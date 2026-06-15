"""Settings, categories, and tag-management endpoints.

Grouped by cohesion rather than path prefix. The paths span /settings/*,
/categories, /tags, and /tags/{tag} — divergent shapes mean no router
prefix would fit them all, so none is used and each path stays
byte-identical to its old `@app.*` form.

DB_PATH is referenced via attribute access on the `db` module, and the
auto-cleanup interval via `config`, so test monkeypatches on `db.DB_PATH`
(conftest fixtures) and any config override flow through at call time.
`db._get_auto_cleanup_enabled` is likewise resolved on the `db` module.
These handlers are plain sqlite reads/writes; they need nothing from the
top-level `main` module (and must never import it).

Note: `router = APIRouter(tags=["settings"])` — the `tags=` parameter is
FastAPI/OpenAPI grouping metadata, NOT the /tags URL surface. The name
collision is cosmetic.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import db

router = APIRouter(tags=["settings"])


@router.get("/settings/auto-cleanup")
async def get_auto_cleanup_setting():
    return {
        "enabled": db._get_auto_cleanup_enabled(),
        "interval_seconds": config.AUTO_CLEANUP_INTERVAL_SECONDS,
    }


class UpdateAutoCleanupRequest(BaseModel):
    enabled: bool


@router.put("/settings/auto-cleanup")
async def update_auto_cleanup_setting(req: UpdateAutoCleanupRequest):
    with db.connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_cleanup_orphans', ?)",
            ("1" if req.enabled else "0",),
        )
        conn.commit()
    return {"enabled": req.enabled}


@router.get("/categories")
async def list_categories():
    with db.connection() as conn:
        rows = conn.execute(
            "SELECT id, name, is_default FROM categories ORDER BY name ASC"
        ).fetchall()
        return {"categories": [dict(r) for r in rows]}


@router.get("/tags")
async def list_tags(q: Optional[str] = None):
    with db.connection() as conn:
        if q:
            rows = conn.execute(
                "SELECT DISTINCT tag FROM tags WHERE tag LIKE ? ORDER BY tag LIMIT 20",
                (f"{q}%",),
            ).fetchall()
            return {"tags": [r[0] for r in rows]}
        else:
            rows = conn.execute(
                "SELECT tag, COUNT(DISTINCT document_id) AS cnt"
                " FROM tags GROUP BY tag ORDER BY cnt DESC"
            ).fetchall()
            return {"tags": [{"tag": r[0], "count": r[1]} for r in rows]}


class RenameTagRequest(BaseModel):
    new_name: str


@router.put("/tags/{tag}")
async def rename_tag(tag: str, req: RenameTagRequest):
    new_name = req.new_name.strip().lower()
    if not new_name:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")

    with db.connection() as conn:
        doc_ids = [r[0] for r in conn.execute(
            "SELECT document_id FROM tags WHERE tag=?", (tag,)
        ).fetchall()]
        updated = 0
        for doc_id in doc_ids:
            has_new = conn.execute(
                "SELECT 1 FROM tags WHERE document_id=? AND tag=?", (doc_id, new_name)
            ).fetchone()
            if has_new:
                conn.execute("DELETE FROM tags WHERE document_id=? AND tag=?", (doc_id, tag))
            else:
                conn.execute(
                    "UPDATE tags SET tag=? WHERE document_id=? AND tag=?", (new_name, doc_id, tag)
                )
                updated += 1
        conn.commit()
        return {"updated_count": updated}


@router.delete("/tags/{tag}")
async def delete_tag(tag: str):
    with db.connection() as conn:
        result = conn.execute("DELETE FROM tags WHERE tag=?", (tag,))
        conn.commit()
        return {"deleted_count": result.rowcount}
