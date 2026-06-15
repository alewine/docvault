"""Filesystem / NAS storage layer.

Owns the on-disk side of DocVault: NAS directory initialization, path
construction for a document's original / extracted-text / thumbnail files,
thumbnail generation, and orphan-record/file cleanup.

Dependency direction is storage -> db -> config. This module never imports
main, so the path helpers and thumbnail functions can be re-exported by main
for backwards compatibility with the existing test suite.
"""

import os
from pathlib import Path

from config import NAS_PATH, DB_PATH, logger
from db import delete_document_vectors, connection


# ---------------------------------------------------------------------------
# Path construction
#
# These read the module-global NAS_PATH at call time (not import time), so a
# test that patches storage.NAS_PATH gets the patched value. Do NOT replace
# them with module-level constants for the same reason.
# ---------------------------------------------------------------------------

def originals_dir() -> Path:
    return NAS_PATH / "originals"


def processed_text_dir() -> Path:
    return NAS_PATH / "processed" / "text"


def thumbnails_dir() -> Path:
    return NAS_PATH / "processed" / "thumbnails"


def nas_subdirs() -> list[Path]:
    return [
        NAS_PATH / "originals",
        NAS_PATH / "processed",
        processed_text_dir(),
        thumbnails_dir(),
    ]


def original_path(doc_id: str, ext: str) -> Path:
    return originals_dir() / f"{doc_id}{ext}"


def text_path(doc_id: str) -> Path:
    return processed_text_dir() / f"{doc_id}.txt"


def thumbnail_path(doc_id: str) -> Path:
    return thumbnails_dir() / f"{doc_id}_thumb.jpg"


# ---------------------------------------------------------------------------
# NAS initialization
# ---------------------------------------------------------------------------

def init_nas() -> None:
    if not NAS_PATH.exists():
        logger.warning("NAS not mounted at %s", NAS_PATH)
        return

    for d in nas_subdirs():
        existed = d.exists()
        os.makedirs(d, exist_ok=True)
        if existed:
            logger.info("NAS directory exists: %s", d)
        else:
            logger.info("NAS directory created: %s", d)

    logger.info("NAS directories ready at %s", NAS_PATH)


# ---------------------------------------------------------------------------
# Thumbnail generation
# ---------------------------------------------------------------------------

def generate_text_preview_thumbnail(doc_id: str, ext: str, text: str) -> Path | None:
    from PIL import Image, ImageDraw, ImageFont

    try:
        WIDTH, HEIGHT = 400, 300
        PAD = 10

        img = Image.new("RGB", (WIDTH, HEIGHT), (28, 32, 48))
        draw = ImageDraw.Draw(img)

        try:
            font_text = ImageFont.load_default(size=11)
        except TypeError:
            font_text = ImageFont.load_default()

        preview = text[:500].strip()
        if preview:
            CHARS_PER_LINE = 55
            lines: list[str] = []
            for raw_line in preview.splitlines():
                while len(raw_line) > CHARS_PER_LINE:
                    lines.append(raw_line[:CHARS_PER_LINE])
                    raw_line = raw_line[CHARS_PER_LINE:]
                if raw_line:
                    lines.append(raw_line)
                if len(lines) >= 16:
                    break

            y = PAD
            for line in lines[:16]:
                try:
                    draw.text((PAD, y), line, fill=(180, 186, 200), font=font_text)
                except Exception:
                    draw.text((PAD, y), line, fill=(180, 186, 200))
                y += 14
                if y > HEIGHT - PAD:
                    break

        thumb_path = thumbnail_path(doc_id)
        img.save(thumb_path, "JPEG", quality=90)
        return thumb_path
    except Exception as e:
        print(f"Text thumbnail generation failed for {doc_id}: {e}")
        return None


def generate_thumbnail(path: Path, doc_id: str, ext: str) -> Path | None:
    from PIL import Image, ImageOps

    try:
        if ext == ".pdf":
            from pdf2image import convert_from_path
            images = convert_from_path(str(path), last_page=1, dpi=150)
            if not images:
                return None
            img = images[0]
        elif ext in (".heic", ".heif"):
            from pillow_heif import register_heif_opener
            register_heif_opener()
            img = Image.open(path)
            img = ImageOps.exif_transpose(img)
        else:
            img = Image.open(path)
            img = ImageOps.exif_transpose(img)

        img.thumbnail((800, 800))
        if img.mode != "RGB":
            img = img.convert("RGB")
        thumb_path = thumbnail_path(doc_id)
        img.save(thumb_path, "JPEG", quality=90)
        return thumb_path
    except Exception as e:
        print(f"Thumbnail generation failed for {doc_id}: {e}")
        return None


# ---------------------------------------------------------------------------
# Orphan cleanup (pure work; the scheduling loop lives in main/jobs)
# ---------------------------------------------------------------------------

def _run_cleanup_sync(req) -> dict:
    results = []
    with connection() as conn:
        for action in req.actions:
            act = action.action
            try:
                if act == "delete_orphan_record":
                    doc_id = action.target_id
                    if not doc_id:
                        results.append({"action": act, "target_id": doc_id, "status": "error", "message": "target_id required"})
                        continue
                    row = conn.execute(
                        "SELECT original_path, processed_text_path, thumbnail_path"
                        " FROM documents WHERE id=?", (doc_id,)
                    ).fetchone()
                    if not row:
                        results.append({"action": act, "target_id": doc_id, "status": "error", "message": "document not found"})
                        continue
                    # Remove vec embeddings
                    try:
                        delete_document_vectors(doc_id)
                    except Exception as e:
                        print(f"cleanup: vec delete warning {doc_id}: {e}")
                    conn.execute("DELETE FROM documents_fts WHERE document_id=?", (doc_id,))
                    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
                    conn.execute("DELETE FROM jobs WHERE document_id=?", (doc_id,))
                    conn.commit()
                    # Remove any NAS files that happen to exist
                    for p in row:
                        if p:
                            Path(p).unlink(missing_ok=True)
                    results.append({"action": act, "target_id": doc_id, "status": "ok"})

                elif act == "delete_orphan_file":
                    target_path = action.target_path
                    if not target_path:
                        results.append({"action": act, "target_path": target_path, "status": "error", "message": "target_path required"})
                        continue
                    # Path-traversal guard: never unlink outside the storage directory.
                    if not Path(target_path).resolve().is_relative_to(Path(NAS_PATH).resolve()):
                        results.append({"action": act, "target_path": target_path, "status": "error", "message": "Path outside storage directory"})
                        continue
                    conn.commit()
                    try:
                        Path(target_path).unlink(missing_ok=True)
                        results.append({"action": act, "target_path": target_path, "status": "ok"})
                    except Exception as e:
                        results.append({"action": act, "target_path": target_path, "status": "error", "message": str(e)})

                elif act == "delete_duplicate":
                    doc_id = action.target_id
                    if not doc_id:
                        results.append({"action": act, "target_id": doc_id, "status": "error", "message": "target_id required"})
                        continue
                    row = conn.execute(
                        "SELECT original_path, processed_text_path, thumbnail_path"
                        " FROM documents WHERE id=?", (doc_id,)
                    ).fetchone()
                    if not row:
                        results.append({"action": act, "target_id": doc_id, "status": "error", "message": "document not found"})
                        continue
                    try:
                        delete_document_vectors(doc_id)
                    except Exception as e:
                        print(f"cleanup: vec delete warning {doc_id}: {e}")
                    conn.execute("DELETE FROM documents_fts WHERE document_id=?", (doc_id,))
                    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
                    conn.execute("DELETE FROM jobs WHERE document_id=?", (doc_id,))
                    conn.commit()
                    for p in row:
                        if p:
                            Path(p).unlink(missing_ok=True)
                    results.append({"action": act, "target_id": doc_id, "status": "ok"})

                else:
                    results.append({"action": act, "status": "error", "message": f"unknown action: {act}"})

            except Exception as e:
                results.append({"action": act, "target_id": action.target_id, "target_path": action.target_path, "status": "error", "message": str(e)})

    return {"results": results, "completed": sum(1 for r in results if r["status"] == "ok")}
