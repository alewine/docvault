import asyncio
from contextlib import asynccontextmanager

# httpx has no direct caller in main.py, but the test suite patches
# main.httpx.post / main.httpx.AsyncClient. httpx is a shared module object, so
# patching the attribute here also patches it for the router code — load-bearing.
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# The re-exports below keep main.<name> resolving for the test suite (tests do
# `import main` and reach these via main.<name> or monkeypatch.setattr(main,
# "<name>", …)) and for the bare names the lifespan handler calls directly.
# NAS_PATH / DB_DIR / DB_PATH are referenced only via setattr in conftest, so
# they must exist on main even though nothing here reads them.
from config import (
    NAS_PATH,
    DB_DIR,
    DB_PATH,
    AUTO_CLEANUP_INTERVAL_SECONDS,
    logger,
)

from db import (
    init_db,
    _reset_stuck_processing_jobs,
    _maybe_migrate_summary,
    _maybe_migrate_title_column,
    _maybe_migrate_email_fields,
    _maybe_migrate_categories,
    _maybe_seed_allowed_senders,
    log_event,
    _get_auto_cleanup_enabled,
)

from storage import init_nas

from embeddings import (
    chunk_text,
    _MAX_WORD_CHARS,
    _MAX_CHUNK_CHARS,
)

from enrichment import (
    _sanitize_category,
    _title_fallback,
    build_summary_prompts,
)

# Background job processing and maintenance loops live in jobs.py. lifespan calls
# worker_loop / watchdog_loop / auto_cleanup_loop / _vec_integrity_check by bare
# name; tests reach process_job / log_job_event / _run_auto_cleanup_sync as main.X.
from jobs import (
    log_job_event,
    _vec_integrity_check,
    _run_auto_cleanup_sync,
    auto_cleanup_loop,
    worker_loop,
    watchdog_loop,
    process_job,
)

# Email ingestion lives in email_ingest.py (named to avoid shadowing the stdlib
# `email` package). lifespan starts email_poller_loop() by bare name; tests reach
# _extract_email_addr as main._extract_email_addr.
from email_ingest import (
    email_poller_loop,
    _extract_email_addr,
)

from routers.email import router as email_router
from routers.jobs import router as jobs_router
from routers.admin import router as admin_router
from routers.settings import router as settings_router
from routers.audit import router as audit_router
from routers.documents import router as documents_router
from routers.search import router as search_router

# _sanitize_fts now lives in routers.search; re-exported so the pure-function
# tests can reach it as main._sanitize_fts.
from routers.search import _sanitize_fts


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    init_nas()
    reset_count = _reset_stuck_processing_jobs()
    if reset_count:
        logger.info("Startup: reset %d stuck processing job(s) back to queued", reset_count)
    _vec_integrity_check()

    async def _deferred_integrity_check():
        await asyncio.sleep(90)
        logger.info("Deferred integrity check starting")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _vec_integrity_check)

    asyncio.create_task(_deferred_integrity_check())
    task = asyncio.create_task(worker_loop())
    email_task = asyncio.create_task(email_poller_loop())
    watchdog_task = asyncio.create_task(watchdog_loop())
    auto_cleanup_task = asyncio.create_task(auto_cleanup_loop())
    yield
    task.cancel()
    email_task.cancel()
    watchdog_task.cancel()
    auto_cleanup_task.cancel()
    for t in (task, email_task, watchdog_task, auto_cleanup_task):
        try:
            await t
        except asyncio.CancelledError:
            pass


app = FastAPI(title="DocVault Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Explicit allowlist of known origins (no wildcards). Local dev + each
    # device on the tailnet by its stable Tailscale IP. When a new device is
    # added to the tailnet, add its Tailscale IP:3777 origin here.
    allow_origins=[
        "http://localhost:3777",       # local dev frontend
        "http://127.0.0.1:3777",       # local dev frontend
        "http://100.82.222.43:3777",   # mac-mini frontend (Tailscale)
        "http://100.81.181.8:3777",    # iphone-15 (Tailscale)
        "http://100.81.181.8",         # iphone-15 direct access (no port)
    ],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.include_router(email_router)
app.include_router(jobs_router)
app.include_router(admin_router)
app.include_router(settings_router)
app.include_router(audit_router)
app.include_router(documents_router)
app.include_router(search_router)
