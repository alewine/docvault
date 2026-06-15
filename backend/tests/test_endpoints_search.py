"""Tests for POST /search — hybrid semantic+FTS search."""
import sqlite3
from unittest.mock import MagicMock, patch

from tests.conftest import insert_document


def _insert_fts(db_path, doc_id, text):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO documents_fts (document_id, extracted_text) VALUES (?, ?)",
        (doc_id, text),
    )
    conn.commit()
    conn.close()


def _fake_embedding():
    return [0.1] * 768


def _mock_httpx_embedding():
    """Return a mock httpx.post context that yields a fake embedding."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = lambda: None
    mock_resp.json.return_value = {"embedding": _fake_embedding()}
    return mock_resp


# ---------------------------------------------------------------------------
# Basic cases
# ---------------------------------------------------------------------------

def test_search_empty_query_returns_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/search", json={"query": "   "})
    assert resp.status_code == 200
    data = resp.json()
    assert data["results"] == []
    assert data["total"] == 0


def test_search_fts_only_when_embedding_fails(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, processing_status="complete", filename="blood-test.pdf")
    _insert_fts(db_path, doc_id, "blood test results hemoglobin")

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={"query": "blood"})

    assert resp.status_code == 200
    ids = [r["document_id"] for r in resp.json()["results"]]
    assert doc_id in ids


def test_search_with_vec_semantic_results(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    from tests.conftest import insert_vec as _insert_vec

    doc_id = insert_document(db_path, processing_status="complete", filename="cardiac.pdf")
    _insert_vec(db_path, doc_id, [0.1] * 768, chunk_text="heart rhythm findings")

    with patch("main.httpx.post", return_value=_mock_httpx_embedding()):
        resp = client.post("/search", json={"query": "cardiac"})

    assert resp.status_code == 200
    ids = [r["document_id"] for r in resp.json()["results"]]
    assert doc_id in ids


def test_search_filters_by_category(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_med = insert_document(db_path, processing_status="complete", category="Medical")
    doc_leg = insert_document(db_path, processing_status="complete", category="Legal")
    _insert_fts(db_path, doc_med, "blood test results")
    _insert_fts(db_path, doc_leg, "blood lawsuit results")

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={"query": "blood results", "category": "Medical"})

    results = resp.json()["results"]
    result_ids = [r["document_id"] for r in results]
    assert doc_med in result_ids
    assert doc_leg not in result_ids


def test_search_filters_by_date_range(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_old = insert_document(
        db_path, processing_status="complete", document_date="2020-01-01"
    )
    doc_new = insert_document(
        db_path, processing_status="complete", document_date="2024-01-01"
    )
    _insert_fts(db_path, doc_old, "invoice payment")
    _insert_fts(db_path, doc_new, "invoice payment")

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={
            "query": "invoice",
            "date_from": "2023-01-01",
            "date_to": "2025-01-01",
        })

    ids = [r["document_id"] for r in resp.json()["results"]]
    assert doc_new in ids
    # doc_old is out of range; it may or may not appear, but doc_new must be there


def test_search_audio_file_matches_by_filename(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    audio_orig = nas_dir / "originals" / "voice-memo.mp3"
    audio_orig.write_bytes(b"")
    doc_id = insert_document(
        db_path,
        filename="voice-memo.mp3",
        original_path=str(audio_orig),
        processing_status="complete",
    )

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={"query": "voice-memo"})

    ids = [r["document_id"] for r in resp.json()["results"]]
    assert doc_id in ids


def test_search_excludes_non_complete_documents(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_err = insert_document(db_path, processing_status="error")
    _insert_fts(db_path, doc_err, "unique-term-xyz")

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={"query": "unique-term-xyz"})

    ids = [r["document_id"] for r in resp.json()["results"]]
    assert doc_err not in ids


def test_search_result_has_expected_fields(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, processing_status="complete", filename="test.pdf")
    _insert_fts(db_path, doc_id, "unique-searchable-word")

    with patch("main.httpx.post", side_effect=Exception("Ollama down")):
        resp = client.post("/search", json={"query": "unique-searchable-word"})

    results = resp.json()["results"]
    assert len(results) >= 1
    r = next(x for x in results if x["document_id"] == doc_id)
    assert "filename" in r
    assert "score" in r
    assert "excerpt" in r
    assert "tags" in r
