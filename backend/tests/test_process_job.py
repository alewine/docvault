"""Tests for process_job() — the main document processing pipeline."""
import sqlite3
import uuid
from unittest.mock import MagicMock


def _setup_job(db_path, nas_dir, ext=".txt") -> tuple[str, str]:
    """Insert a document + job row and write a real file; return (job_id, doc_id)."""
    doc_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    orig = nas_dir / "originals" / f"{doc_id}{ext}"
    orig.write_bytes(b"dummy content for testing")

    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO documents (id, filename, original_path, processing_status)"
        " VALUES (?, ?, ?, 'queued')",
        (doc_id, f"document{ext}", str(orig)),
    )
    conn.execute(
        "INSERT INTO jobs (id, document_id, status, attempts) VALUES (?, ?, 'queued', 0)",
        (job_id, doc_id),
    )
    conn.commit()
    conn.close()
    return job_id, doc_id


def _get_doc_status(db_path, doc_id):
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT processing_status FROM documents WHERE id=?", (doc_id,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


def _make_thumb(nas_dir, doc_id, _ext, _text=None):
    thumb = nas_dir / "processed" / "thumbnails" / f"{doc_id}_thumb.jpg"
    thumb.write_bytes(b"fake jpeg")
    return thumb


def test_process_job_txt_completes(seeded_db, nas_dir, monkeypatch):
    import main
    import jobs

    db_path = main.DB_PATH
    job_id, doc_id = _setup_job(db_path, nas_dir, ".txt")
    extracted = "Monthly checking statement for Bank of America. Date: 03/15/2024. " * 30

    # process_job now lives in jobs.py and resolves these dependencies in jobs's
    # namespace, so patch them there (not on main).
    monkeypatch.setattr(jobs, "ocr_file", lambda path, ext, doc_id, conn: extracted)
    monkeypatch.setattr(
        jobs,
        "generate_text_preview_thumbnail",
        lambda doc_id, ext, text: _make_thumb(nas_dir, doc_id, ext, text),
    )
    monkeypatch.setattr(jobs, "generate_thumbnail", lambda path, doc_id, ext: None)
    import embeddings
    monkeypatch.setattr(embeddings, "_check_embedding_quality", lambda: (True, 0.0))

    def _fake_httpx_post(url, *, json, timeout=None):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        prompt = json.get("prompt", "")
        if url.endswith("/api/embeddings"):
            mock_resp.json.return_value = {"embedding": [0.1] * 768}
        elif prompt == main.build_summary_prompts(extracted, "Financial")[0]:
            mock_resp.json.return_value = {"response": "Bank Statement"}
        elif prompt == main.build_summary_prompts(extracted, "Financial")[1]:
            mock_resp.json.return_value = {"response": "Short account summary."}
        elif "Return ONLY valid JSON in exactly this shape" in prompt:
            mock_resp.json.return_value = {
                "response": '{"category": "Financial", "tags": ["bank of america", "checking"], "document_date": null}'
            }
        else:
            mock_resp.json.return_value = {"response": "Financial"}
        return mock_resp

    # jobs.httpx is the same module object as main.httpx; patch via jobs since
    # the call site is now in jobs.process_job.
    monkeypatch.setattr(jobs.httpx, "post", _fake_httpx_post)

    main.process_job(job_id, doc_id)

    conn = sqlite3.connect(db_path)
    doc_row = conn.execute(
        "SELECT processing_status, category, title, summary FROM documents WHERE id=?",
        (doc_id,),
    ).fetchone()
    tag_count = conn.execute(
        "SELECT COUNT(*) FROM tags WHERE document_id=?", (doc_id,)
    ).fetchone()[0]
    conn.close()

    assert doc_row[0] == "complete"
    assert doc_row[1]
    assert doc_row[2]
    assert doc_row[3]
    assert tag_count >= 1


def test_process_job_audio_skips_ocr(seeded_db, nas_dir, monkeypatch):
    import main
    import jobs

    db_path = main.DB_PATH
    job_id, doc_id = _setup_job(db_path, nas_dir, ".mp3")

    ocr_called = []
    monkeypatch.setattr(jobs, "ocr_file", lambda *a, **kw: ocr_called.append(True) or "")

    main.process_job(job_id, doc_id)

    assert not ocr_called
    assert _get_doc_status(db_path, doc_id) == "complete"
