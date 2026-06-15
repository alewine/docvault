"""Background job processing and maintenance loops.

Owns the document-processing pipeline (`process_job`) and the long-running
asyncio loops that drive it: the worker that pulls queued jobs, the watchdog
that resets stuck jobs, and the scheduled orphan auto-cleanup. Also owns
`_vec_integrity_check`, the startup/periodic check that requeues documents
whose sqlite-vec vectors went missing.

Dependency direction is jobs -> {config, db, extraction, storage, embeddings,
enrichment}. This module does not import `main`. The app-wide single-worker
`_executor` lives in config and `_get_auto_cleanup_enabled` lives in db, so the
loops import them directly at module load — no lazy `from main import` cycle
workaround is needed.

NOTE: process_job moved here as-is; inner-stage extraction is step 6b.
"""

import asyncio
import sqlite3
import uuid
from pathlib import Path

import httpx

from config import (
    DB_PATH,
    NAS_PATH,
    OLLAMA_URL,
    LLM_MODEL,
    AUDIO_EXTENSIONS,
    TEXT_BASED_EXTENSIONS,
    IMAGE_EXTENSIONS,
    AUTO_CLEANUP_INTERVAL_SECONDS,
    AUTO_CLEANUP_STARTUP_DELAY_SECONDS,
    logger,
    _executor,
)

from db import log_event, _get_auto_cleanup_enabled, connection

from extraction import ocr_file

from storage import generate_thumbnail, generate_text_preview_thumbnail

from embeddings import embed_document, _check_embedding_quality

from enrichment import (
    _title_fallback,
    auto_categorize,
    auto_extract_metadata,
    build_summary_prompts,
    detect_json_category,
    extract_json_date,
)


def log_job_event(conn: sqlite3.Connection, job_id: str, event: str) -> None:
    try:
        conn.execute(
            "INSERT INTO job_events (job_id, event) VALUES (?, ?)",
            (job_id, event),
        )
        conn.commit()
    except Exception as e:
        print(f"log_job_event warning ({event} for {job_id}): {e}")


def _vec_integrity_check() -> int:
    """Verify Ollama embedding quality then requeue documents whose sqlite-vec vectors are missing. Returns count requeued."""
    try:
        is_healthy, score = _check_embedding_quality()
        if not is_healthy:
            logger.warning(
                "Vec integrity check skipped: Ollama embeddings are degenerate"
                " (cross-similarity=%.4f) — restart Ollama before requeuing",
                score,
            )
            return 0

        with connection() as conn:
            complete_rows = conn.execute(
                "SELECT id FROM documents WHERE processing_status='complete'"
            ).fetchall()
            total_complete = len(complete_rows)
            if total_complete == 0:
                logger.info("Vec integrity check: no complete documents — skipping")
                return 0

            embedded_rows = conn.execute(
                "SELECT DISTINCT document_id FROM vec_chunk_meta"
            ).fetchall()
            embedded_doc_ids = {r[0] for r in embedded_rows}

            skipped_embed_ids = {
                r[0] for r in conn.execute(
                    "SELECT DISTINCT document_id FROM document_log"
                    " WHERE event_type='embed_verify' AND status='skipped'"
                ).fetchall()
            }

            missing_doc_ids = [
                r[0] for r in complete_rows
                if r[0] not in embedded_doc_ids and r[0] not in skipped_embed_ids
            ]

            if not missing_doc_ids:
                logger.info("Vec integrity check: all embeddings healthy")
                return 0

            missing_ratio = len(missing_doc_ids) / total_complete if total_complete else 0

            if missing_ratio > 0.80:
                logger.warning(
                    "Vec integrity check: %d/%d documents (%.0f%%) are missing embeddings — "
                    "treating as vec wipe, requeuing all for full re-embedding",
                    len(missing_doc_ids),
                    total_complete,
                    missing_ratio * 100,
                )
            else:
                logger.warning(
                    "Vec integrity check: %d document(s) missing from sqlite-vec — requeuing",
                    len(missing_doc_ids),
                )

            for doc_id in missing_doc_ids:
                conn.execute(
                    "UPDATE documents SET processing_status='queued' WHERE id=?", (doc_id,)
                )
                conn.execute(
                    "INSERT INTO jobs (id, document_id) VALUES (?, ?)",
                    (str(uuid.uuid4()), doc_id),
                )
            conn.commit()

        logger.info(
            "Vec integrity check: %d document(s) requeued (missing from sqlite-vec)",
            len(missing_doc_ids),
        )
        return len(missing_doc_ids)

    except Exception as e:
        logger.warning("Vec integrity check failed: %s", e)
        return 0


# ---------------------------------------------------------------------------
# Auto-cleanup of orphaned processed files
# ---------------------------------------------------------------------------

def _run_auto_cleanup_sync() -> dict:
    """Delete orphaned files in processed/text and processed/thumbnails only.

    Mirrors the orphaned-NAS-files scan in _run_audit_sync, but never touches
    originals/. Each deletion is logged to audit_log with
    action='auto_cleanup_orphan'.
    """
    deleted: list[str] = []
    with connection() as conn:
        known_ids: set[str] = {
            r["id"] for r in conn.execute("SELECT id FROM documents").fetchall()
        }
        scan_dirs = [
            ("processed/text", NAS_PATH / "processed" / "text"),
            ("processed/thumbnails", NAS_PATH / "processed" / "thumbnails"),
        ]
        for _subdir_label, dir_path in scan_dirs:
            if not dir_path.exists():
                continue
            for f in dir_path.iterdir():
                if not f.is_file():
                    continue
                if f.name.startswith('.'):
                    f.unlink(missing_ok=True)
                    continue
                # File names are <uuid>.txt or <uuid>_thumb.jpg
                stem = f.stem.replace("_thumb", "")
                if stem in known_ids:
                    continue
                path_str = str(f)
                try:
                    f.unlink(missing_ok=True)
                except Exception as e:
                    logger.warning("Auto-cleanup: failed to delete %s: %s", path_str, e)
                    continue
                conn.execute(
                    "INSERT INTO audit_log (action, target_path) VALUES ('auto_cleanup_orphan', ?)",
                    (path_str,),
                )
                deleted.append(path_str)
        conn.commit()
    if deleted:
        logger.info("Auto-cleanup: removed %d orphaned processed file(s)", len(deleted))
    return {"deleted": deleted, "count": len(deleted)}


async def auto_cleanup_loop() -> None:
    # Wait a short delay after startup before the first run.
    await asyncio.sleep(AUTO_CLEANUP_STARTUP_DELAY_SECONDS)
    loop = asyncio.get_event_loop()
    while True:
        try:
            if _get_auto_cleanup_enabled():
                await loop.run_in_executor(_executor, _run_auto_cleanup_sync)
        except Exception as e:
            logger.warning("Auto-cleanup loop error: %s", e)
        await asyncio.sleep(AUTO_CLEANUP_INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Worker / watchdog loops
# ---------------------------------------------------------------------------

async def worker_loop() -> None:
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(5)
        with connection() as conn:
            row = conn.execute(
                "SELECT id, document_id FROM jobs"
                " WHERE status = 'queued' AND attempts < 3"
                " ORDER BY created_at LIMIT 1"
            ).fetchone()

        if row:
            job_id, doc_id = row
            try:
                await loop.run_in_executor(_executor, process_job, job_id, doc_id)
            except Exception as e:
                print(f"Worker: job {job_id} failed: {e}")


async def watchdog_loop() -> None:
    while True:
        await asyncio.sleep(300)
        with connection() as conn:
            try:
                stuck = conn.execute(
                    "SELECT id, document_id, updated_at FROM jobs"
                    " WHERE status = 'processing'"
                    " AND updated_at < DATETIME('now', '-10 minutes')"
                ).fetchall()
                if stuck:
                    job_ids = [r[0] for r in stuck]
                    doc_ids = [r[1] for r in stuck]
                    conn.execute(
                        f"UPDATE jobs SET status = 'queued', updated_at = CURRENT_TIMESTAMP"
                        f" WHERE id IN ({','.join('?' * len(job_ids))})",
                        job_ids,
                    )
                    conn.execute(
                        f"UPDATE documents SET processing_status = 'queued'"
                        f" WHERE id IN ({','.join('?' * len(doc_ids))})",
                        doc_ids,
                    )
                    conn.commit()
                    for job_id, _doc_id, updated_at in stuck:
                        logger.warning(
                            "Watchdog: reset stuck job %s (last updated %s)", job_id, updated_at
                        )
            except Exception as e:
                print(f"Watchdog: error during check: {e}")


# ---------------------------------------------------------------------------
# Document processing pipeline
# ---------------------------------------------------------------------------

def _process_job_begin(conn: sqlite3.Connection, job_id: str, doc_id: str) -> None:
    """Mark the job/document as processing and log the start event."""
    conn.execute(
        "UPDATE jobs SET status='processing', attempts=attempts+1,"
        " updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (job_id,),
    )
    conn.execute(
        "UPDATE documents SET processing_status='processing' WHERE id=?",
        (doc_id,),
    )
    conn.commit()

    attempt = conn.execute(
        "SELECT attempts FROM jobs WHERE id=?", (job_id,)
    ).fetchone()[0]
    log_event(conn, doc_id, "job_start",
              message="Worker picked up job, beginning processing",
              metadata={"attempt": attempt})


def _resolve_document(conn: sqlite3.Connection, doc_id: str):
    """Read the document row and return (filename, original_path, ext)."""
    row = conn.execute(
        "SELECT filename, original_path FROM documents WHERE id=?", (doc_id,)
    ).fetchone()
    filename, original_path_str = row
    original_path = Path(original_path_str)
    ext = original_path.suffix.lower()
    return filename, original_path, ext


def _process_job_audio(conn: sqlite3.Connection, job_id: str, doc_id: str,
                       filename: str, ext: str) -> None:
    """Terminal path for audio files — storage only: skip OCR/thumbnail/embed/FTS."""
    log_event(conn, doc_id, "file_detected",
              message=f"Audio file ({ext.lstrip('.')}) — storage only, skipping OCR/embed/index",
              pipeline_path="audio")
    conn.execute(
        "UPDATE documents SET processing_status='complete', category='Audio' WHERE id=?", (doc_id,)
    )
    log_event(conn, doc_id, "auto_categorize", status="success",
              message="Category assigned by file type: Audio")
    conn.execute(
        "UPDATE jobs SET status='complete', error_message=NULL,"
        " updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (job_id,),
    )
    conn.commit()
    log_event(conn, doc_id, "job_complete", status="success",
              message="Audio file stored successfully")
    log_job_event(conn, job_id, "job_complete")
    print(f"Worker: job {job_id} complete ({filename}) [audio]")


def _log_file_detected(conn: sqlite3.Connection, doc_id: str, ext: str) -> None:
    """Log the detected file type and its pipeline path."""
    _ext_label = {
        ".pdf": "PDF", ".jpg": "JPG", ".jpeg": "JPG", ".png": "PNG",
        ".heic": "HEIC", ".heif": "HEIC",
        ".txt": "TXT", ".csv": "CSV", ".docx": "DOCX",
        ".xlsx": "XLSX", ".pptx": "PPTX", ".json": "JSON",
    }
    _ext_pipeline = {
        ".pdf": "pdf", ".jpg": "jpg_png", ".jpeg": "jpg_png", ".png": "jpg_png",
        ".heic": "heic", ".heif": "heic",
        ".txt": "txt", ".csv": "csv", ".docx": "docx",
        ".xlsx": "xlsx", ".pptx": "pptx", ".json": "json",
    }
    log_event(conn, doc_id, "file_detected",
              message=f"Detected file type: {_ext_label.get(ext, ext.upper().lstrip('.'))}",
              pipeline_path=_ext_pipeline.get(ext, ext.lstrip('.')))


def _process_job_extract(conn: sqlite3.Connection, job_id: str, doc_id: str,
                         original_path: Path, ext: str) -> str:
    """Extract text via OCR/parsers and return it."""
    extracted_text = ocr_file(original_path, ext, doc_id, conn)
    log_event(conn, doc_id, "ocr_complete", status="success", char_count=len(extracted_text))
    log_job_event(conn, job_id, "ocr_complete")
    return extracted_text


def _process_job_json_heuristics(conn: sqlite3.Connection, doc_id: str,
                                 original_path: Path, ext: str) -> None:
    """JSON schema heuristics: category and date detection from raw structure."""
    if ext != ".json":
        return
    import json as _json_mod
    _json_data: object = None
    try:
        _json_data = _json_mod.loads(
            original_path.read_text(encoding="utf-8", errors="replace")
        )
    except Exception:
        pass
    if _json_data is not None:
        _json_cat = detect_json_category(_json_data)
        if _json_cat:
            conn.execute("UPDATE documents SET category=? WHERE id=?", (_json_cat, doc_id))
            conn.commit()
            log_event(conn, doc_id, "auto_categorize", status="success",
                      message=f"Category assigned by JSON schema heuristic: {_json_cat}")
        _json_date = extract_json_date(_json_data)
        if _json_date:
            _existing_date = conn.execute(
                "SELECT document_date FROM documents WHERE id=?", (doc_id,)
            ).fetchone()
            if not _existing_date or not _existing_date[0]:
                conn.execute(
                    "UPDATE documents SET document_date=? WHERE id=?", (_json_date, doc_id)
                )
                conn.commit()
                log_event(conn, doc_id, "metadata_extracted", status="success",
                          message=f"document_date set to {_json_date} (from JSON key)")


def _process_job_save_text(conn: sqlite3.Connection, doc_id: str, extracted_text: str) -> Path:
    """Write the extracted text to NAS and return its path."""
    import traceback as _tb
    text_path = NAS_PATH / "processed" / "text" / f"{doc_id}.txt"
    try:
        text_path.write_text(extracted_text, encoding="utf-8")
    except Exception as e:
        log_event(conn, doc_id, "text_saved", status="failure",
                  message=f"{e}\n\n{_tb.format_exc()}")
        raise
    log_event(conn, doc_id, "text_saved",
              status="success",
              message=f"Extracted text written to {text_path}",
              char_count=len(extracted_text))
    return text_path


def _process_job_thumbnail(conn: sqlite3.Connection, doc_id: str, original_path: Path,
                           ext: str, extracted_text: str):
    """Generate and log a thumbnail; return its path (or None)."""
    if ext in TEXT_BASED_EXTENSIONS:
        thumb_path = generate_text_preview_thumbnail(doc_id, ext, extracted_text)
    else:
        thumb_path = generate_thumbnail(original_path, doc_id, ext)
    if thumb_path:
        log_event(conn, doc_id, "thumbnail", status="success",
                  message="Thumbnail saved to NAS")
    else:
        log_event(conn, doc_id, "thumbnail", status="failure",
                  message="Thumbnail generation failed (see server log)")
    return thumb_path


def _process_job_categorize_and_metadata(conn: sqlite3.Connection, job_id: str, doc_id: str,
                                         ext: str, extracted_text: str) -> None:
    """Run auto-categorization and metadata extraction (skipped for textless images)."""
    if ext not in IMAGE_EXTENSIONS or extracted_text.strip():
        auto_categorize(doc_id, extracted_text, conn)
        log_job_event(conn, job_id, "category_assigned")

    if ext not in IMAGE_EXTENSIONS or extracted_text.strip():
        auto_extract_metadata(doc_id, extracted_text, conn)
        log_job_event(conn, job_id, "metadata_extracted")


def _process_job_embed(conn: sqlite3.Connection, job_id: str, doc_id: str,
                       extracted_text: str) -> None:
    """Embed the document and verify the vectors landed in sqlite-vec."""
    embed_document(doc_id, extracted_text, conn)
    log_job_event(conn, job_id, "embeddings_stored")

    # Check whether embed_document produced chunks or skipped (no text).
    _ev_row = conn.execute(
        "SELECT status FROM document_log"
        " WHERE document_id=? AND event_type='embed_verify'"
        " ORDER BY timestamp DESC LIMIT 1",
        (doc_id,),
    ).fetchone()
    _embed_skipped = _ev_row and _ev_row[0] == "skipped"

    if not _embed_skipped:
        # Verify the embedding actually landed in sqlite-vec before continuing.
        _verify_row = conn.execute(
            "SELECT rowid FROM vec_chunk_meta WHERE document_id=? AND chunk_index=0 LIMIT 1",
            (doc_id,),
        ).fetchone()
        if not _verify_row:
            log_event(conn, doc_id, "embed_verify", status="failure",
                      message="Embedding verification failed — vectors not found in sqlite-vec after insert")
            raise RuntimeError("Embedding verification failed — vectors not found in sqlite-vec after insert")
        log_event(conn, doc_id, "embed_verify", status="success")


def _process_job_title_summary(conn: sqlite3.Connection, job_id: str, doc_id: str,
                               filename: str, ext: str, extracted_text: str) -> None:
    """Title (local LLM) + 4-pass summary comparison → notes."""
    if ext in IMAGE_EXTENSIONS and not extracted_text.strip():
        conn.execute(
            "UPDATE documents SET title=?, summary=?, category=? WHERE id=?",
            (
                _title_fallback(filename),
                "This appears to be a photo or image — no document text was detected.",
                "Other",
                doc_id,
            ),
        )
        conn.commit()
    elif extracted_text:
        _doc_cat_row = conn.execute(
            "SELECT category FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        _doc_category = (_doc_cat_row[0] or "") if _doc_cat_row else ""
        _title_prompt, _summary_prompt = build_summary_prompts(extracted_text, _doc_category)

        # Title — local LLM only, category-aware prompt
        try:
            _local_title_resp = httpx.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": LLM_MODEL, "prompt": _title_prompt, "stream": False},
                timeout=60.0,
            )
            _local_title_resp.raise_for_status()
            _local_title = _local_title_resp.json().get("response", "").strip().strip("\"'.,")[:80]
            if not _local_title:
                _local_title = _title_fallback(filename)
            log_event(conn, doc_id, "local_title_generated", status="success")
        except Exception as _e:
            _local_title = _title_fallback(filename)
            log_event(conn, doc_id, "local_title_generated", status="failure",
                      message=f"Local LLM title generation failed: {_e}")

        conn.execute("UPDATE documents SET title=? WHERE id=?", (_local_title, doc_id))
        conn.commit()
        log_job_event(conn, job_id, "title_generated")

        # Summary — local LLM only, category-aware prompt
        try:
            _summary_resp = httpx.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": LLM_MODEL, "prompt": _summary_prompt, "stream": False},
                timeout=60.0,
            )
            _summary_resp.raise_for_status()
            _summary = _summary_resp.json().get("response", "").strip()
            conn.execute("UPDATE documents SET summary=? WHERE id=?", (_summary, doc_id))
            conn.commit()
            log_event(conn, doc_id, "summary_generated", status="success")
            log_job_event(conn, job_id, "summary_generated")
        except Exception as _e:
            print(f"process_job: summary generation failed for {doc_id}: {_e}")
            log_event(conn, doc_id, "summary_generated", status="failure",
                      message=f"Summary generation failed: {_e}")


def _process_job_finalize(conn: sqlite3.Connection, job_id: str, doc_id: str, filename: str,
                          extracted_text: str, text_path, thumb_path) -> None:
    """Populate the FTS index and mark the document and job complete."""
    conn.execute(
        "INSERT INTO documents_fts (document_id, extracted_text) VALUES (?, ?)",
        (doc_id, extracted_text),
    )
    conn.execute(
        "UPDATE documents SET processed_text_path=?, thumbnail_path=?,"
        " processing_status='complete' WHERE id=?",
        (str(text_path), str(thumb_path) if thumb_path else None, doc_id),
    )
    log_event(conn, doc_id, "index", pipeline_path="fts5", status="success",
              message="FTS5 index populated for document")
    log_event(conn, doc_id, "job_complete", status="success",
              message="Document fully processed and indexed")
    conn.execute(
        "UPDATE jobs SET status='complete', error_message=NULL,"
        " updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (job_id,),
    )
    conn.commit()
    print(f"Worker: job {job_id} complete ({filename})")


def process_job(job_id: str, doc_id: str) -> None:
    import traceback as _tb
    with connection() as conn:
        # Tracks the stage currently running so a failure logs against the stage
        # that actually broke (the "ocr" stage still yields "ocr_error"); updated
        # immediately before each stage call.
        current_stage = "begin"
        try:
            _process_job_begin(conn, job_id, doc_id)
            current_stage = "resolve_document"
            filename, original_path, ext = _resolve_document(conn, doc_id)

            # Audio files — storage only: skip OCR, thumbnail, embed, and FTS
            if ext in AUDIO_EXTENSIONS:
                current_stage = "audio"
                _process_job_audio(conn, job_id, doc_id, filename, ext)
                return

            current_stage = "file_detected"
            _log_file_detected(conn, doc_id, ext)
            current_stage = "ocr"
            extracted_text = _process_job_extract(conn, job_id, doc_id, original_path, ext)
            current_stage = "json_heuristics"
            _process_job_json_heuristics(conn, doc_id, original_path, ext)
            current_stage = "save_text"
            text_path = _process_job_save_text(conn, doc_id, extracted_text)
            current_stage = "thumbnail"
            thumb_path = _process_job_thumbnail(conn, doc_id, original_path, ext, extracted_text)
            current_stage = "categorize_metadata"
            _process_job_categorize_and_metadata(conn, job_id, doc_id, ext, extracted_text)
            current_stage = "embed"
            _process_job_embed(conn, job_id, doc_id, extracted_text)
            current_stage = "title_summary"
            _process_job_title_summary(conn, job_id, doc_id, filename, ext, extracted_text)
            current_stage = "finalize"
            _process_job_finalize(conn, job_id, doc_id, filename, extracted_text, text_path, thumb_path)

        except Exception as e:
            try:
                log_event(conn, doc_id, f"{current_stage}_error", status="failure",
                          message=f"{e}\n\n{_tb.format_exc()}")
            except Exception:
                pass

            # ext may be unbound if _resolve_document raised; NameError guard handles that case.
            try:
                _is_pdf = ext == ".pdf"
            except NameError:
                _is_pdf = False
            # pdfminer raises PDFPasswordIncorrect() with no message, so str(e) == "".
            # pdfplumber wraps it in PdfminerException, also with no message, so we also
            # inspect repr(e.args) to surface the wrapped exception's class name.
            _err_text = (str(e) + " " + type(e).__name__ + " " + repr(e.args)).lower()
            is_password_error = _is_pdf and (
                "password" in _err_text or "encrypted" in _err_text or "decrypt" in _err_text
            )

            if is_password_error:
                conn.execute(
                    "UPDATE jobs SET status='needs_password', error_message=?,"
                    " attempts=3, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    ("This PDF is password-protected.", job_id),
                )
                conn.execute(
                    "UPDATE documents SET processing_status='needs_password' WHERE id=?", (doc_id,)
                )
            else:
                attempts = conn.execute(
                    "SELECT attempts FROM jobs WHERE id=?", (job_id,)
                ).fetchone()[0]
                if attempts >= 3:
                    conn.execute(
                        "UPDATE jobs SET status='error', error_message=?,"
                        " updated_at=CURRENT_TIMESTAMP WHERE id=?",
                        (str(e), job_id),
                    )
                    conn.execute(
                        "UPDATE documents SET processing_status='error' WHERE id=?", (doc_id,)
                    )
                else:
                    conn.execute(
                        "UPDATE jobs SET status='queued', error_message=?,"
                        " updated_at=CURRENT_TIMESTAMP WHERE id=?",
                        (str(e), job_id),
                    )
            conn.commit()
            raise
