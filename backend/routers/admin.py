"""Admin + health endpoints.

Grouped together for cohesion even though their paths diverge
(/health and /admin/factory-reset), so no router prefix is used — an
/admin prefix would exclude /health and split cohesion for no benefit.
Each path stays exactly as it was in main.py.

Config constants (OLLAMA_URL, EMBED_MODEL, LLM_MODEL, logger, _executor)
and the mutable DB_PATH / NAS_PATH are referenced via attribute access on
the `config` / `db` / `storage` / `embeddings` modules so that test
monkeypatches on those modules flow through to these handlers at call time.

CRITICAL test seam: `_restart_process` (the os.execv re-exec used by
factory-reset) lives in *this* module. The conftest fixture patches
`routers.admin._restart_process` to a no-op so the TestClient does not
re-exec the pytest process and hang the suite. The factory-reset handler
references the bare name `_restart_process`, which resolves in this
module's namespace at call time — keep it that way or the patch goes
vacuous.
"""
import asyncio

import httpx
from fastapi import APIRouter, BackgroundTasks

import config
import db
import storage
import embeddings

router = APIRouter(tags=["admin"])


@router.get("/health")
async def health():
    checks: dict[str, str] = {}

    nas_ok = False
    try:
        if storage.NAS_PATH.exists():
            probe = storage.NAS_PATH / ".docvault_write_probe"
            probe.touch()
            probe.unlink()
            nas_ok = True
    except Exception as e:
        print(f"NAS check failed: {e}")
    checks["nas"] = "green" if nas_ok else "red"

    ollama_ok = False
    llm_ok = False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{config.OLLAMA_URL}/api/tags")
            if resp.status_code == 200:
                models = [m["name"] for m in resp.json().get("models", [])]
                ollama_ok = any(config.EMBED_MODEL in m for m in models)
                llm_ok = any(config.LLM_MODEL in m for m in models)
    except Exception as e:
        print(f"Ollama check failed: {e}")
    checks["ollama"] = "green" if ollama_ok else "red"
    checks["llm"] = "green" if llm_ok else "red"

    loop = asyncio.get_event_loop()
    embed_healthy, embed_sim = await loop.run_in_executor(None, embeddings._check_embedding_quality)
    checks["embedding_quality"] = "green" if embed_healthy else "red"

    db_ok = False
    embedding_gap: int | None = None
    try:
        with db.connection(timeout=3) as conn:
            conn.execute("SELECT 1")
            complete_count = conn.execute(
                "SELECT COUNT(*) FROM documents WHERE processing_status='complete'"
            ).fetchone()[0]
            # Documents intentionally skipped from embedding (no text) should not inflate the gap.
            skipped_embed_count = conn.execute(
                "SELECT COUNT(DISTINCT document_id) FROM document_log"
                " WHERE event_type='embed_verify' AND status='skipped'"
            ).fetchone()[0]
            embedded_count = conn.execute(
                "SELECT COUNT(DISTINCT document_id) FROM vec_chunk_meta"
            ).fetchone()[0]
            embedding_gap = (complete_count - skipped_embed_count) - embedded_count

        db_ok = True
        if embedding_gap > 1:
            config.logger.warning(
                "Health check: %d complete document(s) in SQLite but only %d have sqlite-vec embeddings "
                "(gap=%d) — these documents won't appear in RAG results until reprocessed",
                complete_count,
                embedded_count,
                embedding_gap,
            )
    except Exception as e:
        print(f"DB check failed: {e}")
    checks["database"] = "green" if db_ok else "red"

    core = {k: v for k, v in checks.items() if k not in ("llm",)}
    overall = "pass" if all(v == "green" for v in core.values()) else "fail"
    return {
        "status": overall,
        "checks": checks,
        "embedding_quality_score": round(embed_sim, 4),
        "embedding_gap": embedding_gap,
    }


@router.post("/admin/factory-reset")
async def factory_reset(background_tasks: BackgroundTasks):
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(config._executor, _factory_reset_sync)
    background_tasks.add_task(_restart_process)
    return {"success": True, "message": "Factory reset complete"}


async def _restart_process():
    import os
    import sys
    await asyncio.sleep(0.5)
    os.execv(sys.executable, [sys.executable] + sys.argv)


def _factory_reset_sync() -> None:
    import shutil

    # 1. Wipe all rows from every table
    with db.connection() as conn:
        conn.execute("DELETE FROM document_log")
        conn.execute("DELETE FROM audit_log")
        conn.execute("DELETE FROM jobs")
        conn.execute("DELETE FROM tags")
        conn.execute("DELETE FROM documents")
        # Drop and recreate FTS5 table to clear any corruption
        conn.execute("DROP TABLE IF EXISTS documents_fts")
        conn.execute(
            "CREATE VIRTUAL TABLE documents_fts USING fts5("
            "document_id UNINDEXED, extracted_text,"
            " tokenize='porter unicode61')"
        )
        conn.commit()

    # 2. Wipe all vec embeddings (extension required to interact with virtual table)
    vc = db._vec_conn()
    try:
        vc.execute("DELETE FROM vec_chunks")
        vc.execute("DELETE FROM vec_chunk_meta")
        vc.commit()
    finally:
        vc.close()

    # 3. Delete files inside originals/ and processed/ without removing dirs
    for subdir in ("originals", "processed"):
        target = storage.NAS_PATH / subdir
        if target.exists():
            for item in target.iterdir():
                if item.is_file():
                    item.unlink()
                elif item.is_dir():
                    shutil.rmtree(item)

    # 4. Recreate subdirectory structure so uploads work immediately after restart
    storage.init_nas()
