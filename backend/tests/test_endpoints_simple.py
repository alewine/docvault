"""Tests for lightweight read-only and simple write endpoints."""
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import insert_document, insert_job

# ---------------------------------------------------------------------------
# GET /categories
# ---------------------------------------------------------------------------

def test_get_categories_returns_default_list(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/categories")
    assert resp.status_code == 200
    data = resp.json()
    names = [c["name"] for c in data["categories"]]
    assert names == [
        "Audio",
        "Education",
        "Financial",
        "Home",
        "Insurance",
        "Legal",
        "Medical",
        "Other",
    ]


def test_get_categories_sorted_alphabetically(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/categories")
    names = [c["name"] for c in resp.json()["categories"]]
    assert names == sorted(names)


# ---------------------------------------------------------------------------
# GET /tags
# ---------------------------------------------------------------------------

def test_get_tags_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/tags")
    assert resp.status_code == 200
    assert resp.json()["tags"] == []


def test_get_tags_with_seeded_data(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, "medical"))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, "insurance"))
    conn.commit()
    conn.close()

    resp = client.get("/tags")
    tags = {t["tag"] for t in resp.json()["tags"]}
    assert "medical" in tags
    assert "insurance" in tags


def test_get_tags_counts_distinct_documents(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc1 = insert_document(db_path)
    doc2 = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'medical')", (doc1,))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'medical')", (doc2,))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'other')", (doc1,))
    conn.commit()
    conn.close()

    resp = client.get("/tags")
    tags_by_name = {t["tag"]: t["count"] for t in resp.json()["tags"]}
    assert tags_by_name["medical"] == 2
    assert tags_by_name["other"] == 1


def test_get_tags_with_query_prefix(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'medical')", (doc_id,))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'medicare')", (doc_id,))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'insurance')", (doc_id,))
    conn.commit()
    conn.close()

    resp = client.get("/tags?q=med")
    tags = resp.json()["tags"]
    assert "medical" in tags
    assert "medicare" in tags
    assert "insurance" not in tags


def test_get_tags_query_no_match(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/tags?q=zzz")
    assert resp.json()["tags"] == []


# ---------------------------------------------------------------------------
# GET /jobs/failed
# ---------------------------------------------------------------------------

def test_get_failed_jobs_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/jobs/failed")
    assert resp.status_code == 200
    assert resp.json()["failed_jobs"] == []


def test_get_failed_jobs_returns_error_docs(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, processing_status="error")
    insert_job(db_path, doc_id, status="error", error="OCR failed")

    resp = client.get("/jobs/failed")
    jobs = resp.json()["failed_jobs"]
    assert len(jobs) == 1
    assert jobs[0]["document_id"] == doc_id
    assert jobs[0]["error_message"] == "OCR failed"


def test_get_failed_jobs_excludes_complete_docs(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    insert_document(db_path, processing_status="complete")
    resp = client.get("/jobs/failed")
    assert resp.json()["failed_jobs"] == []


# ---------------------------------------------------------------------------
# GET /status/{job_id}
# ---------------------------------------------------------------------------

def test_get_status_404_for_unknown_job(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/status/nonexistent-job")
    assert resp.status_code == 404


def test_get_status_returns_job_fields(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    job_id = insert_job(db_path, doc_id, status="complete")

    resp = client.get(f"/status/{job_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["job_id"] == job_id
    assert data["document_id"] == doc_id
    assert data["status"] == "complete"
    assert data["events"] == []


def test_get_status_includes_job_events(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    job_id = insert_job(db_path, doc_id)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO job_events (job_id, event) VALUES (?, ?)", (job_id, "started"))
    conn.execute("INSERT INTO job_events (job_id, event) VALUES (?, ?)", (job_id, "ocr_done"))
    conn.commit()
    conn.close()

    resp = client.get(f"/status/{job_id}")
    events = resp.json()["events"]
    assert len(events) == 2
    assert events[0]["event"] == "started"


# ---------------------------------------------------------------------------
# POST /check-duplicate
# ---------------------------------------------------------------------------

def test_check_duplicate_returns_false_when_no_match(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/check-duplicate", data={"file_hash": "abc123"})
    assert resp.status_code == 200
    assert resp.json() == {"duplicate": False}


def test_check_duplicate_returns_true_when_hash_matches(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    file_hash = "deadbeefdeadbeef" * 4
    doc_id = insert_document(db_path, file_hash=file_hash, filename="original.pdf")

    resp = client.post("/check-duplicate", data={"file_hash": file_hash})
    assert resp.status_code == 200
    data = resp.json()
    assert data["duplicate"] is True
    assert data["document_id"] == doc_id
    assert data["filename"] == "original.pdf"


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

def test_health_nas_green_when_mounted(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    # NAS dir is the tmp_path nas_dir — it exists and is writable
    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"models": []},
        )
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    assert resp.status_code == 200
    checks = resp.json()["checks"]
    assert checks["nas"] == "green"


def test_health_ollama_red_when_no_models(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"models": []},
        )
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    checks = resp.json()["checks"]
    assert checks["ollama"] == "red"
    assert checks["llm"] == "red"


def test_health_ollama_red_when_request_fails(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.side_effect = Exception("connection refused")
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    checks = resp.json()["checks"]
    assert checks["ollama"] == "red"


def test_health_db_green_when_reachable(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.return_value = MagicMock(
            status_code=200, json=lambda: {"models": []}
        )
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    checks = resp.json()["checks"]
    assert checks["database"] == "green"


def test_health_reports_embedding_gap_from_vec_chunk_meta(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    embedded_doc_id = insert_document(db_path)
    insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO vec_chunk_meta (document_id, chunk_index, chunk_text) VALUES (?, ?, ?)",
        (embedded_doc_id, 0, "chunk"),
    )
    conn.commit()
    conn.close()

    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.return_value = MagicMock(
            status_code=200, json=lambda: {"models": []}
        )
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    assert resp.status_code == 200
    assert resp.json()["embedding_gap"] == 1


def test_health_overall_fail_when_core_services_down(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    with patch("main.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.get.side_effect = Exception("down")
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        resp = client.get("/health")

    # ollama red → overall fail
    assert resp.json()["status"] == "fail"


# ---------------------------------------------------------------------------
# POST /upload — basic validation (NAS write path)
# ---------------------------------------------------------------------------

def test_upload_unsupported_extension_returns_400(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post(
        "/upload",
        files={"file": ("test.xyz", b"content", "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_upload_creates_document_and_job(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post(
        "/upload",
        files={"file": ("report.txt", b"Hello world content", "text/plain")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "document_id" in data
    assert "job_id" in data

    # Verify DB row created
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT id, filename FROM documents WHERE id = ?", (data["document_id"],)
    ).fetchone()
    conn.close()
    assert row is not None
    assert row[1] == "report.txt"


def test_upload_duplicate_content_still_creates_new_document(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    content = b"exact same content"
    resp1 = client.post(
        "/upload",
        files={"file": ("first.txt", content, "text/plain")},
    )
    assert resp1.status_code == 200
    first_id = resp1.json()["document_id"]

    resp2 = client.post(
        "/upload",
        files={"file": ("second.txt", content, "text/plain")},
    )
    assert resp2.status_code == 200
    # A new document is created even if content is the same
    second_id = resp2.json()["document_id"]
    assert second_id != first_id
