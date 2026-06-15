"""Job-queue inspection + bulk-requeue endpoints.

Grouped by cohesion (all read/write the `jobs` / `job_events` tables and
the `documents.processing_status` column). No router prefix: `/status/{job_id}`
does not share the `/jobs/*` shape, and splitting one path off into a second
router earns nothing — each path stays byte-identical to its old `@app.*` form.

DB_PATH is referenced via attribute access on the `db` module so test
monkeypatches on `db.DB_PATH` (conftest fixtures) flow through at call time.
These handlers are pure sqlite reads/writes; they need no worker helper from
the top-level `jobs` module.
"""
import uuid

from fastapi import APIRouter, HTTPException

import db

router = APIRouter(tags=["jobs"])


@router.get("/status/{job_id}")
async def job_status(job_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT id, document_id, status, error_message, attempts, created_at, updated_at"
            " FROM jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Job not found")
        event_rows = conn.execute(
            "SELECT event, created_at FROM job_events WHERE job_id=? ORDER BY created_at ASC",
            (job_id,),
        ).fetchall()

    return {
        "job_id": row[0],
        "document_id": row[1],
        "status": row[2],
        "error_message": row[3],
        "attempts": row[4],
        "created_at": row[5],
        "updated_at": row[6],
        "events": [{"event": e[0], "created_at": e[1]} for e in event_rows],
    }


@router.get("/jobs/failed")
async def list_failed_jobs():
    with db.connection() as conn:
        docs = conn.execute(
            "SELECT id, filename, uploaded_at, title FROM documents"
            " WHERE processing_status = 'error'"
            " ORDER BY uploaded_at DESC LIMIT 50"
        ).fetchall()
        result = []
        for doc in docs:
            latest_job = conn.execute(
                "SELECT error_message FROM jobs"
                " WHERE document_id = ? ORDER BY updated_at DESC LIMIT 1",
                (doc["id"],),
            ).fetchone()
            result.append({
                "document_id": doc["id"],
                "filename": doc["filename"],
                "title": doc["title"] or None,
                "uploaded_at": doc["uploaded_at"],
                "error_message": latest_job["error_message"] if latest_job else "Unknown error",
            })
        return {"failed_jobs": result}


@router.get("/jobs/status")
async def jobs_status():
    with db.connection() as conn:
        queued = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE status = 'queued'"
        ).fetchone()[0]
        processing = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE status = 'processing'"
        ).fetchone()[0]
        failed = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE processing_status = 'error'"
        ).fetchone()[0]
        return {
            "queued": queued,
            "processing": processing,
            "failed": failed,
            "total_active": queued + processing,
        }


@router.post("/jobs/reprocess-all")
async def reprocess_all_jobs():
    with db.connection() as conn:
        docs = conn.execute(
            "SELECT id FROM documents WHERE processing_status != 'processing'"
        ).fetchall()
        count = 0
        for doc in docs:
            job_id = str(uuid.uuid4())
            conn.execute(
                "UPDATE documents SET processing_status = 'queued' WHERE id = ?",
                (doc["id"],),
            )
            conn.execute(
                "INSERT INTO jobs (id, document_id) VALUES (?, ?)",
                (job_id, doc["id"]),
            )
            count += 1
        conn.commit()
        return {"requeued": count}


@router.get("/jobs/active")
async def list_active_jobs():
    with db.connection() as conn:
        rows = conn.execute(
            """
            SELECT j.id AS job_id, j.document_id, j.status, d.filename
            FROM jobs j
            JOIN documents d ON d.id = j.document_id
            WHERE j.status IN ('queued', 'processing')
            ORDER BY j.created_at ASC
            """
        ).fetchall()
        seen: set[str] = set()
        jobs = []
        for row in rows:
            doc_id = row["document_id"]
            if doc_id in seen:
                continue
            seen.add(doc_id)
            jobs.append({
                "job_id": row["job_id"],
                "document_id": doc_id,
                "filename": row["filename"],
                "status": row["status"],
            })
        return {"jobs": jobs}
