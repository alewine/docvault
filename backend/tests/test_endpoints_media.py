"""Tests for /thumbnail/{doc_id}, /audio/{doc_id}, and /unlock/{doc_id}."""
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

from tests.conftest import insert_document, insert_job

# ---------------------------------------------------------------------------
# GET /thumbnail/{doc_id}
# ---------------------------------------------------------------------------

def test_thumbnail_404_unknown_doc(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/thumbnail/nonexistent-id")
    assert resp.status_code == 404


def test_thumbnail_404_when_thumbnail_path_is_null(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, thumbnail_path=None)
    resp = client.get(f"/thumbnail/{doc_id}")
    assert resp.status_code == 404


def test_thumbnail_404_when_file_missing_from_disk(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, thumbnail_path="/nonexistent/thumb.jpg")
    resp = client.get(f"/thumbnail/{doc_id}")
    assert resp.status_code == 404


def test_thumbnail_returns_jpeg_when_file_exists(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    thumb = nas_dir / "processed" / "thumbnails" / "thumb.jpg"
    thumb.write_bytes(b"\xff\xd8\xff" + b"\x00" * 100)  # minimal JPEG header
    doc_id = insert_document(db_path, thumbnail_path=str(thumb))

    resp = client.get(f"/thumbnail/{doc_id}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"


# ---------------------------------------------------------------------------
# GET /audio/{doc_id}
# ---------------------------------------------------------------------------

def test_audio_404_unknown_doc(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/audio/nonexistent-id")
    assert resp.status_code == 404


def test_audio_400_for_non_audio_file(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    pdf = nas_dir / "originals" / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    doc_id = insert_document(db_path, original_path=str(pdf), filename="doc.pdf")
    resp = client.get(f"/audio/{doc_id}")
    assert resp.status_code == 400


def test_audio_returns_200_for_mp3(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    mp3 = nas_dir / "originals" / "voice.mp3"
    mp3.write_bytes(b"\xff\xfb" + b"\x00" * 200)  # minimal MP3 header
    doc_id = insert_document(db_path, original_path=str(mp3), filename="voice.mp3")

    resp = client.get(f"/audio/{doc_id}")
    assert resp.status_code == 200
    assert "audio" in resp.headers.get("content-type", "")


def test_audio_returns_206_with_range_header(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    mp3 = nas_dir / "originals" / "range.mp3"
    content = b"\xff\xfb" + b"\xAB" * 500
    mp3.write_bytes(content)
    doc_id = insert_document(db_path, original_path=str(mp3), filename="range.mp3")

    resp = client.get(f"/audio/{doc_id}", headers={"Range": "bytes=0-99"})
    assert resp.status_code == 206
    assert resp.headers.get("content-range", "").startswith("bytes 0-99/")


def test_audio_404_when_file_missing(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(
        db_path,
        original_path="/nonexistent/voice.mp3",
        filename="voice.mp3",
    )
    resp = client.get(f"/audio/{doc_id}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /unlock/{doc_id}
# ---------------------------------------------------------------------------

def test_unlock_404_unknown_doc(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/unlock/nonexistent-id", json={"password": "secret"})
    assert resp.status_code == 404


def test_unlock_404_when_file_missing_from_disk(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, original_path="/nonexistent/file.pdf")
    resp = client.post(f"/unlock/{doc_id}", json={"password": "secret"})
    assert resp.status_code == 404


def test_unlock_400_on_wrong_password(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    pdf = nas_dir / "originals" / "locked.pdf"
    pdf.write_bytes(b"%PDF-1.4 encrypted content")
    doc_id = insert_document(db_path, original_path=str(pdf))

    with patch("pikepdf.open", side_effect=Exception("PDF is encrypted")):
        # pikepdf.PasswordError is a subclass of Exception in our mock context
        import pikepdf
        mock_cm = MagicMock()
        mock_cm.__enter__ = MagicMock(side_effect=pikepdf.PasswordError("wrong password"))
        mock_cm.__exit__ = MagicMock(return_value=False)
        with patch("pikepdf.open", return_value=mock_cm):
            resp = client.post(f"/unlock/{doc_id}", json={"password": "wrong"})

    assert resp.status_code == 400


def test_unlock_success_requeues_existing_job(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    pdf = nas_dir / "originals" / "locked.pdf"
    pdf.write_bytes(b"%PDF-1.4 content here")
    doc_id = insert_document(db_path, original_path=str(pdf), processing_status="needs_password")
    job_id = insert_job(db_path, doc_id, status="needs_password")

    # Mock pikepdf to succeed — open returns a context manager that saves to the decrypted_tmp
    mock_pdf = MagicMock()
    mock_pdf.__enter__ = MagicMock(return_value=mock_pdf)
    mock_pdf.__exit__ = MagicMock(return_value=False)

    def _fake_save(path):
        Path(path).write_bytes(b"%PDF-1.4 decrypted content")

    mock_pdf.save = _fake_save

    with patch("pikepdf.open", return_value=mock_pdf):
        resp = client.post(f"/unlock/{doc_id}", json={"password": "correct"})

    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    assert row is not None
    assert row[0] == "queued"
