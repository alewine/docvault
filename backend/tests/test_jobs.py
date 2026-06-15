"""Smoke tests for jobs.py — the background processing module.

Fast, no real Ollama / OCR / IMAP. Covers _vec_integrity_check (requeue of a
document missing from sqlite-vec) and a single worker_loop dispatch tick.
"""
import asyncio
import uuid

import pytest


def test_vec_integrity_check_requeues_missing(seeded_db, monkeypatch):
    import jobs
    import embeddings

    # Pretend Ollama embeddings are healthy so the check proceeds.
    monkeypatch.setattr(embeddings, "_check_embedding_quality", lambda: (True, 0.0))

    db_path = jobs.DB_PATH
    doc_id = str(uuid.uuid4())
    seeded_db.execute(
        "INSERT INTO documents (id, filename, original_path, processing_status)"
        " VALUES (?, 'f.pdf', '/tmp/f.pdf', 'complete')",
        (doc_id,),
    )
    seeded_db.commit()

    # No vec_chunk_meta row exists for this complete doc → it should be requeued.
    requeued = jobs._vec_integrity_check()
    assert requeued == 1

    import sqlite3
    conn = sqlite3.connect(db_path)
    try:
        status = conn.execute(
            "SELECT processing_status FROM documents WHERE id=?", (doc_id,)
        ).fetchone()[0]
        job_count = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE document_id=?", (doc_id,)
        ).fetchone()[0]
    finally:
        conn.close()

    assert status == "queued"
    assert job_count == 1


def test_worker_loop_dispatches_one_job(seeded_db, monkeypatch):
    import jobs

    db_path = jobs.DB_PATH
    doc_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    seeded_db.execute(
        "INSERT INTO documents (id, filename, original_path, processing_status)"
        " VALUES (?, 'f.pdf', '/tmp/f.pdf', 'queued')",
        (doc_id,),
    )
    seeded_db.execute(
        "INSERT INTO jobs (id, document_id, status, attempts) VALUES (?, ?, 'queued', 0)",
        (job_id, doc_id),
    )
    seeded_db.commit()

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(jobs, "process_job", lambda jid, did: dispatched.append((jid, did)))

    # Break the (otherwise infinite) loop after one tick: let the first sleep
    # through, then raise on the second so the loop exits without hanging.
    real_sleep = asyncio.sleep
    calls = {"n": 0}

    async def fake_sleep(_secs):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise asyncio.CancelledError
        await real_sleep(0)

    monkeypatch.setattr(jobs.asyncio, "sleep", fake_sleep)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(jobs.worker_loop())

    assert dispatched == [(job_id, doc_id)]
