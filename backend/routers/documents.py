"""Document lifecycle + media endpoints — the heaviest router.

Covers upload/duplicate-check, the document CRUD surface
(/documents, /document/{id}, PUT/DELETE, reprocess, star, generate-title),
the file-serving endpoints (/thumbnail, /audio, /original), the
password-unlock endpoint, and the per-document processing log.

No router prefix: the paths span /upload, /check-duplicate, /documents,
/document/{id}/*, /thumbnail/{id}, /audio/{id}, /original/{id} — divergent
enough that no single prefix fits, and every other router is prefix-free,
so each path stays byte-identical to its old @app.* form.

Per the canonical router pattern: the mutable DB_PATH / NAS_PATH and the
patched-in-tests helpers are referenced via attribute access on the
`db` / `storage` / `config` / `enrichment` modules (e.g. db.DB_PATH,
storage.NAS_PATH, config._executor, enrichment._merge_suggested_tags) so
that conftest monkeypatches flow through to these handlers at call time.
Never imports main.
"""
import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import config
import db
import enrichment
import storage

router = APIRouter(tags=["documents"])

MAX_UPLOAD_BYTES = 20_971_520  # 20 MB


def _sanitize_filename(name: str) -> str:
    """Strip null bytes and control characters from an uploaded filename."""
    return re.sub(r"[\x00-\x1f\x7f]", "", name)


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

@router.post("/upload")
async def upload(request: Request, file: UploadFile = File(...)):
    import hashlib

    if not file.filename:
        raise HTTPException(status_code=422, detail="Filename is required")
    filename = _sanitize_filename(file.filename)

    ext = Path(filename).suffix.lower()
    if ext not in config.SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    # Reject oversized uploads up front via Content-Length when the client sends it.
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 20 MB limit")

    if not storage.NAS_PATH.exists():
        raise HTTPException(status_code=503, detail="NAS not mounted")

    doc_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    original_path = storage.NAS_PATH / "originals" / f"{doc_id}{ext}"

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 20 MB limit")
    file_hash = hashlib.sha256(contents).hexdigest()
    original_path.write_bytes(contents)

    duplicate_of: str | None = None
    duplicate_of_filename: str | None = None
    with db.connection() as conn:
        existing = conn.execute(
            "SELECT id, filename FROM documents WHERE file_hash=? ORDER BY uploaded_at ASC LIMIT 1",
            (file_hash,),
        ).fetchone()
        if existing:
            duplicate_of = existing[0]
            duplicate_of_filename = existing[1]

        conn.execute(
            "INSERT INTO documents (id, filename, original_path, file_hash) VALUES (?, ?, ?, ?)",
            (doc_id, filename, str(original_path), file_hash),
        )
        conn.execute(
            "INSERT INTO jobs (id, document_id) VALUES (?, ?)",
            (job_id, doc_id),
        )
        conn.commit()
        db.log_event(
            conn, doc_id, "upload",
            status="success",
            message=f"File received: {filename} ({len(contents)} bytes)",
            metadata={
                "file_hash": file_hash,
                "duplicate_of": duplicate_of,
                "duplicate_of_filename": duplicate_of_filename,
            },
        )

    return {"job_id": job_id, "document_id": doc_id}


@router.post("/check-duplicate")
async def check_duplicate(file_hash: str = Form(...)):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT id, filename FROM documents WHERE file_hash = ?",
            (file_hash,),
        ).fetchone()
    if row:
        return {"duplicate": True, "document_id": row["id"], "filename": row["filename"]}
    return {"duplicate": False}


# ---------------------------------------------------------------------------
# Unlock password-protected PDF
# ---------------------------------------------------------------------------

class UnlockRequest(BaseModel):
    password: str


@router.post("/unlock/{doc_id}")
async def unlock_document(doc_id: str, req: UnlockRequest):
    import pikepdf

    with db.connection() as conn:
        row = conn.execute(
            "SELECT original_path FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if not row or not row[0]:
            raise HTTPException(status_code=404, detail="Document not found")

        original_path = Path(row[0])
        if not original_path.exists():
            raise HTTPException(status_code=404, detail="File not found on NAS")

        decrypted_tmp = original_path.with_suffix(".decrypted_tmp")
        try:
            with pikepdf.open(str(original_path), password=req.password) as pdf:
                pdf.save(str(decrypted_tmp))
        except pikepdf.PasswordError:
            decrypted_tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Incorrect password")
        except Exception as e:
            decrypted_tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=f"Could not open PDF: {e}")

        try:
            decrypted_tmp.replace(original_path)
        except Exception as e:
            decrypted_tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not save decrypted file: {e}")

        job_row = conn.execute(
            "SELECT id FROM jobs WHERE document_id=? ORDER BY created_at DESC LIMIT 1",
            (doc_id,),
        ).fetchone()
        if job_row:
            conn.execute(
                "UPDATE jobs SET status='queued', attempts=0, error_message=NULL,"
                " updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (job_row[0],),
            )
        else:
            new_job_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO jobs (id, document_id) VALUES (?, ?)", (new_job_id, doc_id)
            )

        conn.execute(
            "UPDATE documents SET processing_status='queued' WHERE id=?", (doc_id,)
        )
        conn.commit()
        return {"status": "queued"}


# ---------------------------------------------------------------------------
# Thumbnail
# ---------------------------------------------------------------------------

@router.get("/thumbnail/{doc_id}")
async def get_thumbnail(doc_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT thumbnail_path FROM documents WHERE id=?", (doc_id,)
        ).fetchone()

    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    thumb_path = Path(row[0])
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail file not found")

    return FileResponse(str(thumb_path), media_type="image/jpeg")


# ---------------------------------------------------------------------------
# Audio streaming
# ---------------------------------------------------------------------------

@router.get("/audio/{doc_id}")
async def get_audio(doc_id: str, request: Request):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT original_path, filename FROM documents WHERE id=?", (doc_id,)
        ).fetchone()

    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Document not found")

    original_path = Path(row[0])
    if not original_path.exists():
        raise HTTPException(status_code=404, detail="File not found on NAS")

    ext = original_path.suffix.lower()
    if ext not in config.AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not an audio file")

    content_type = "audio/mpeg" if ext == ".mp3" else "audio/wav"
    file_size = original_path.stat().st_size

    range_header = request.headers.get("range")
    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else file_size - 1
            end = min(end, file_size - 1)
            length = end - start + 1

            def _iter_range():
                with open(original_path, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return StreamingResponse(
                _iter_range(),
                status_code=206,
                media_type=content_type,
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(length),
                },
            )

    return FileResponse(
        str(original_path),
        media_type=content_type,
        headers={"Accept-Ranges": "bytes"},
    )


# ---------------------------------------------------------------------------
# Document listing + detail
# ---------------------------------------------------------------------------

@router.get("/documents")
async def list_documents(
    category: Optional[str] = None,
    exclude_category: Optional[str] = None,
    tags: Optional[list[str]] = Query(default=None),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: str = "uploaded_at",
    sort_dir: str = "desc",
    page: int = Query(default=1, ge=1),
    page_size: int = 24,
    starred: Optional[bool] = None,
):
    allowed_sort = {"uploaded_at", "document_date", "filename"}
    if sort_by not in allowed_sort:
        sort_by = "uploaded_at"
    sort_dir = "DESC" if sort_dir.lower() != "asc" else "ASC"

    with db.connection() as conn:
        params: list = []
        where: list = []

        if starred is True:
            where.append("starred = 1")
        if category:
            where.append("category = ?")
            params.append(category)
        if exclude_category:
            where.append("category != ?")
            params.append(exclude_category)
        if date_from:
            where.append("document_date >= ?")
            params.append(date_from)
        if date_to:
            where.append("document_date <= ?")
            params.append(date_to)
        if tags:
            # Match documents carrying ALL requested tags (dedupe first so the
            # HAVING count matches the distinct-tag count).
            tag_list = list(dict.fromkeys(tags))
            placeholders = ",".join("?" * len(tag_list))
            where.append(
                f"id IN (SELECT document_id FROM tags WHERE tag IN ({placeholders})"
                f" GROUP BY document_id HAVING COUNT(DISTINCT tag) = ?)"
            )
            params.extend(tag_list)
            params.append(len(tag_list))

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        total = conn.execute(
            f"SELECT COUNT(*) FROM documents {where_sql}", params
        ).fetchone()[0]

        offset = (page - 1) * page_size
        rows = conn.execute(
            f"SELECT id, filename, category, document_date, uploaded_at, thumbnail_path,"
            f" summary, title, source, email_sender, starred, processing_status"
            f" FROM documents {where_sql}"
            f" ORDER BY CASE processing_status"
            f"  WHEN 'complete' THEN 0"
            f"  WHEN 'processing' THEN 1"
            f"  WHEN 'queued' THEN 2"
            f"  ELSE 3 END ASC,"
            f" {sort_by} {sort_dir}"
            f" LIMIT ? OFFSET ?",
            params + [page_size, offset],
        ).fetchall()

        # Batch-fetch tags for this page in one query, keyed by document_id.
        tags_by_doc = db._tags_for_documents(conn, [row["id"] for row in rows])

        results = [{
            "document_id": row["id"],
            "filename": row["filename"],
            "title": row["title"] or None,
            "category": row["category"],
            "tags": tags_by_doc.get(row["id"], []),
            "document_date": row["document_date"],
            "uploaded_at": row["uploaded_at"],
            "summary": row["summary"] or None,
            "has_thumbnail": bool(row["thumbnail_path"] and Path(row["thumbnail_path"]).exists()),
            "source": row["source"] or "upload",
            "email_sender": row["email_sender"] or None,
            "starred": bool(row["starred"]),
            "processing_status": row["processing_status"],
        } for row in rows]

        return {"documents": results, "total": total, "page": page, "page_size": page_size}


@router.get("/document/{doc_id}")
async def get_document(doc_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT id, filename, category, notes, document_date, uploaded_at,"
            " thumbnail_path, processed_text_path, processing_status, original_path,"
            " summary, title, source, email_sender, starred"
            " FROM documents WHERE id=?",
            (doc_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")

        doc_tags = [r[0] for r in conn.execute(
            "SELECT tag FROM tags WHERE document_id=? ORDER BY tag", (doc_id,)
        ).fetchall()]

        extracted_text = None
        if row["processed_text_path"]:
            try:
                extracted_text = Path(row["processed_text_path"]).read_text(encoding="utf-8")
            except Exception:
                pass

        original_path = Path(row["original_path"]) if row["original_path"] else None
        original_ext = original_path.suffix.lower() if original_path else None
        try:
            file_size = original_path.stat().st_size if original_path and original_path.exists() else None
        except Exception:
            file_size = None

        return {
            "document_id": row["id"],
            "filename": row["filename"],
            "title": row["title"] or None,
            "category": row["category"],
            "notes": row["notes"],
            "tags": doc_tags,
            "document_date": row["document_date"],
            "uploaded_at": row["uploaded_at"],
            "processing_status": row["processing_status"],
            "summary": row["summary"] or None,
            "has_thumbnail": bool(row["thumbnail_path"] and Path(row["thumbnail_path"]).exists()),
            "extracted_text": extracted_text,
            "original_ext": original_ext,
            "file_size": file_size,
            "source": row["source"] or "upload",
            "email_sender": row["email_sender"] or None,
            "starred": bool(row["starred"]),
        }


class UpdateDocumentRequest(BaseModel):
    category: Optional[str] = None
    notes: Optional[str] = None
    document_date: Optional[str] = None
    tags: Optional[list[str]] = None
    title: Optional[str] = None


@router.put("/document/{doc_id}")
async def update_document(doc_id: str, req: UpdateDocumentRequest):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT category, notes, document_date, title FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")

        if req.category is not None and req.category not in config.VALID_CATEGORIES:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid category. Must be one of: {', '.join(config.VALID_CATEGORIES)}",
            )

        old_category, old_notes, old_date, old_title = row
        old_tags = [r[0] for r in conn.execute(
            "SELECT tag FROM tags WHERE document_id=? ORDER BY tag", (doc_id,)
        ).fetchall()]

        # COALESCE keeps the existing category when req.category is None/absent
        # (a notes- or tags-only edit must not blank out the category).
        conn.execute(
            "UPDATE documents SET category=COALESCE(?, category), notes=?, document_date=?, title=? WHERE id=?",
            (req.category, req.notes, req.document_date, req.title, doc_id),
        )
        if req.category is not None:
            conn.execute(
                "UPDATE documents SET category_locked=1 WHERE id=?", (doc_id,)
            )

        if req.tags is not None:
            conn.execute("DELETE FROM tags WHERE document_id=?", (doc_id,))
            for tag in req.tags:
                tag = tag.strip()
                if tag:
                    conn.execute(
                        "INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, tag)
                    )

        changed = []
        if req.category is not None and req.category != old_category:
            changed.append("category")
        if req.notes != old_notes:
            changed.append("notes")
        if req.document_date != old_date:
            changed.append("document_date")
        if req.title != old_title:
            changed.append("title")
        if req.tags is not None:
            new_tags_cleaned = sorted(t.strip() for t in req.tags if t.strip())
            if new_tags_cleaned != sorted(old_tags):
                changed.append("tags")
        db.log_event(
            conn, doc_id, "manual_edit",
            status="success",
            message=f"Fields updated: {', '.join(changed)}" if changed else "Saved with no changes",
        )

        conn.commit()

    return await get_document(doc_id)


@router.delete("/document/{doc_id}")
async def delete_document(doc_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT original_path, processed_text_path, thumbnail_path"
            " FROM documents WHERE id=?",
            (doc_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")

        original_path, text_path, thumb_path = row

        # Remove vec embeddings
        try:
            db.delete_document_vectors(doc_id)
        except Exception as e:
            print(f"Delete: vec cleanup warning for {doc_id}: {e}")

        # Remove FTS entry and tags (SQLite FK cascades require PRAGMA foreign_keys=ON;
        # delete explicitly to avoid orphaned rows)
        conn.execute("DELETE FROM documents_fts WHERE document_id=?", (doc_id,))
        conn.execute("DELETE FROM tags WHERE document_id=?", (doc_id,))
        conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
        conn.execute("DELETE FROM jobs WHERE document_id=?", (doc_id,))
        conn.commit()

        # Remove NAS files
        for p in (original_path, text_path, thumb_path):
            if p:
                try:
                    Path(p).unlink(missing_ok=True)
                except Exception as e:
                    print(f"Delete: file removal warning {p}: {e}")

    return {"deleted": doc_id}


@router.post("/document/{doc_id}/reprocess")
async def reprocess_document(doc_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT id FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")

        job_id = str(uuid.uuid4())
        conn.execute("DELETE FROM document_log WHERE document_id=?", (doc_id,))
        conn.execute(
            "UPDATE documents SET processing_status='queued' WHERE id=?", (doc_id,)
        )
        conn.execute(
            "INSERT INTO jobs (id, document_id) VALUES (?, ?)", (job_id, doc_id)
        )
        conn.commit()
        db.log_event(conn, doc_id, "reprocess", status="success", message="Reprocessing triggered via API")

    return {"job_id": job_id, "document_id": doc_id}


@router.post("/document/{doc_id}/star")
async def toggle_star(doc_id: str):
    with db.connection() as conn:
        row = conn.execute("SELECT starred FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        new_val = 0 if row[0] else 1
        conn.execute("UPDATE documents SET starred=? WHERE id=?", (new_val, doc_id))
        conn.commit()
        return {"id": doc_id, "starred": bool(new_val)}


def _gt_fetch_document(doc_id: str):
    """Fetch the row generate-title needs. Returns (filename, text_path, category,
    category_locked); raises HTTPException(404) if the document does not exist."""
    with db.connection() as conn:
        row = conn.execute(
            "SELECT filename, processed_text_path, category, category_locked FROM documents WHERE id=?",
            (doc_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        return row  # (filename, text_path, current_category, category_locked)


def _gt_read_text(text_path) -> str:
    """Read the document's extracted text, swallowing any read error → ''."""
    extracted_text = ""
    if text_path:
        try:
            extracted_text = Path(text_path).read_text(encoding="utf-8")
        except Exception:
            pass
    return extracted_text


async def _gt_fallback_title_summary(filename: str, extracted_text: str, cat: str):
    """Ollama fallback when the local title/category call produced nothing. Returns
    (title, summary). Shared byte-for-byte by the locked and unlocked branches."""
    loop = asyncio.get_event_loop()
    try:
        title = await loop.run_in_executor(
            config._executor, enrichment.generate_document_title, filename, extracted_text, cat
        )
    except Exception:
        title = enrichment._title_fallback(filename)
    summary = None
    if extracted_text:
        try:
            summary = await loop.run_in_executor(
                config._executor, enrichment.generate_document_summary, extracted_text, cat
            )
        except Exception:
            pass
    return title, summary


async def _gt_generate_locked(doc_id: str, filename: str, extracted_text: str, cat: str):
    """Locked path: title+summary only, no recategorization. Returns (title, summary, parsed)."""
    loop = asyncio.get_event_loop()
    parsed: dict | None = None
    if extracted_text:
        try:
            parsed = await loop.run_in_executor(
                config._executor,
                enrichment._local_generate_title_locked,
                filename,
                extracted_text,
                cat,
            )
        except Exception as exc:
            print(f"generate-title (locked) error for {doc_id}: {exc}")

    if parsed:
        title = (parsed.get("title") or "").strip().strip("\"'.,") or enrichment._title_fallback(filename)
        title = title[:80]
        summary = (parsed.get("summary") or "").strip() or None
    else:
        title, summary = await _gt_fallback_title_summary(filename, extracted_text, cat)

    return title, summary, parsed


async def _gt_generate_unlocked(doc_id: str, filename: str, extracted_text: str, cat: str):
    """Unlocked path: full detection. Returns (title, summary, suggested, confidence, parsed)."""
    loop = asyncio.get_event_loop()
    parsed = None
    if extracted_text:
        try:
            parsed = await loop.run_in_executor(
                config._executor,
                enrichment._local_generate_title_and_category,
                filename,
                extracted_text,
                cat,
            )
        except Exception as exc:
            print(f"generate-title first-call error for {doc_id}: {exc}")

    if parsed:
        title = (parsed.get("title") or "").strip().strip("\"'.,") or enrichment._title_fallback(filename)
        title = title[:80]
        summary = (parsed.get("summary") or "").strip() or None
        suggested = parsed.get("suggested_category", cat)
        suggested = suggested if suggested in config.VALID_CATEGORIES else "Other"
        confidence = parsed.get("category_confidence", "low")
    else:
        # Fall back to Ollama-based helpers if no API key or first call failed
        title, summary = await _gt_fallback_title_summary(filename, extracted_text, cat)
        suggested = cat
        confidence = "low"

    return title, summary, suggested, confidence, parsed


async def _gt_resolve_category(doc_id: str, extracted_text: str, cat: str, suggested: str, confidence: str, summary):
    """Decide the final category from the suggestion + confidence. On a high-confidence
    change, regenerates the summary with the new category framing. Returns
    (summary, final_category, recategorized)."""
    loop = asyncio.get_event_loop()
    recategorized = False
    final_category = cat

    if suggested != cat:
        if confidence == "high":
            if extracted_text:
                try:
                    summary = await loop.run_in_executor(
                        config._executor, enrichment._local_recategorize_summary, extracted_text, suggested
                    )
                except Exception as exc:
                    print(f"generate-title recategorize-summary error for {doc_id}: {exc}")
            final_category = suggested
            recategorized = True
            print(
                f"generate-title: recategorized {doc_id} from '{cat}' to '{suggested}' (high confidence)"
            )
        else:
            final_category = suggested
            recategorized = suggested != cat
            if recategorized:
                print(
                    f"generate-title: recategorized {doc_id} from '{cat}' to '{suggested}' (low confidence)"
                )

    return summary, final_category, recategorized


def _gt_persist_locked(doc_id: str, title, summary) -> None:
    """Persist the locked-path result: single UPDATE of title + summary."""
    with db.connection() as conn:
        conn.execute(
            "UPDATE documents SET title=?, summary=? WHERE id=?",
            (title, summary, doc_id),
        )
        conn.commit()


def _gt_persist_recategorized(doc_id: str, title, summary, final_category: str, recategorized: bool, cat: str) -> None:
    """Persist the unlocked-path result: single UPDATE of title + summary + category,
    then log the recategorization (on the same conn) when it occurred."""
    with db.connection() as conn:
        conn.execute(
            "UPDATE documents SET title=?, summary=?, category=? WHERE id=?",
            (title, summary, final_category, doc_id),
        )
        conn.commit()
        if recategorized:
            db.log_event(
                conn,
                doc_id,
                "recategorize",
                status="success",
                message=f"Recategorized from '{cat}' to '{final_category}' during generate-title",
            )


@router.post("/document/{doc_id}/generate-title")
async def generate_title_endpoint(doc_id: str):
    filename, text_path, current_category, category_locked = _gt_fetch_document(doc_id)
    extracted_text = _gt_read_text(text_path)
    cat = current_category or "Other"

    if category_locked:
        # Category is manually set — generate title+summary only, no recategorization
        title, summary, parsed = await _gt_generate_locked(doc_id, filename, extracted_text, cat)
        _gt_persist_locked(doc_id, title, summary)
        tags = enrichment._merge_suggested_tags(doc_id, (parsed or {}).get("suggested_tags"))
        return {
            "title": title,
            "summary": summary,
            "category": cat,
            "recategorized": False,
            "tags": tags,
        }

    # Category is not locked — run full detection and recategorization logic
    title, summary, suggested, confidence, parsed = await _gt_generate_unlocked(doc_id, filename, extracted_text, cat)
    summary, final_category, recategorized = await _gt_resolve_category(
        doc_id, extracted_text, cat, suggested, confidence, summary
    )
    _gt_persist_recategorized(doc_id, title, summary, final_category, recategorized, cat)
    tags = enrichment._merge_suggested_tags(doc_id, (parsed or {}).get("suggested_tags"))

    return {
        "title": title,
        "summary": summary,
        "category": final_category,
        "recategorized": recategorized,
        "tags": tags,
    }


# ---------------------------------------------------------------------------
# Original file download + document log
# ---------------------------------------------------------------------------

@router.get("/original/{doc_id}")
async def get_original(doc_id: str):
    with db.connection() as conn:
        row = conn.execute(
            "SELECT original_path, filename FROM documents WHERE id=?", (doc_id,)
        ).fetchone()

    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Document not found")

    original_path = Path(row[0])
    if not original_path.exists():
        raise HTTPException(status_code=404, detail="File not found on NAS")

    ext = original_path.suffix.lower()
    previewable = {".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif"}
    media_type = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }.get(ext, "application/octet-stream")

    return FileResponse(
        str(original_path),
        media_type=media_type,
        filename=row[1],
        content_disposition_type="inline" if ext in previewable else "attachment",
    )


@router.get("/document/{doc_id}/log")
async def get_document_log(doc_id: str):
    with db.connection() as conn:
        if not conn.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Document not found")
        rows = conn.execute(
            "SELECT id, document_id, timestamp, event_type, pipeline_path,"
            " char_count, chunk_count, status, message, metadata"
            " FROM document_log WHERE document_id=? ORDER BY timestamp ASC",
            (doc_id,),
        ).fetchall()
        return {
            "document_id": doc_id,
            "entries": [
                {
                    "id": row["id"],
                    "document_id": row["document_id"],
                    "timestamp": row["timestamp"],
                    "event_type": row["event_type"],
                    "pipeline_path": row["pipeline_path"],
                    "char_count": row["char_count"],
                    "chunk_count": row["chunk_count"],
                    "status": row["status"],
                    "message": row["message"],
                    "metadata": json.loads(row["metadata"]) if row["metadata"] else None,
                }
                for row in rows
            ],
        }
