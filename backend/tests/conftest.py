import sqlite3
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def nas_dir(tmp_path):
    nas = tmp_path / "nas"
    for d in ["originals", "processed/text", "processed/thumbnails"]:
        (nas / d).mkdir(parents=True)
    return nas


@pytest.fixture()
def db_path(tmp_path):
    return tmp_path / "metadata.sqlite"


@pytest.fixture()
def mock_vec_store():
    """Unused compatibility fixture for tests that accept a mocked vector store."""
    return MagicMock()


@pytest.fixture()
def isolated_app(db_path, nas_dir, monkeypatch):
    """FastAPI TestClient with isolated SQLite and mocked NAS."""
    import main
    import db
    import storage
    import jobs
    import routers.admin

    monkeypatch.setattr(main, "DB_PATH", db_path)
    monkeypatch.setattr(main, "DB_DIR", db_path.parent)
    monkeypatch.setattr(main, "NAS_PATH", nas_dir)
    # db.py owns init_db / _vec_conn / _reset_stuck_processing_jobs now; those
    # resolve DB_PATH in db's own globals, so patch there too.
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "DB_DIR", db_path.parent)
    # storage.py owns init_nas / thumbnails / _run_cleanup_sync now; they
    # resolve NAS_PATH / DB_PATH in storage's own globals.
    monkeypatch.setattr(storage, "NAS_PATH", nas_dir)
    monkeypatch.setattr(storage, "DB_PATH", db_path)
    # jobs.py owns process_job / _vec_integrity_check / _run_auto_cleanup_sync /
    # the worker loops now; they resolve DB_PATH / NAS_PATH in jobs's own globals.
    monkeypatch.setattr(jobs, "DB_PATH", db_path)
    monkeypatch.setattr(jobs, "NAS_PATH", nas_dir)
    monkeypatch.setattr(main, "_vec_integrity_check", lambda: 0)

    async def _noop():
        return

    monkeypatch.setattr(main, "worker_loop", _noop)
    monkeypatch.setattr(main, "email_poller_loop", _noop)
    monkeypatch.setattr(main, "watchdog_loop", _noop)
    monkeypatch.setattr(main, "auto_cleanup_loop", _noop)
    # /admin/factory-reset schedules _restart_process as a BackgroundTask, which
    # calls os.execv to re-exec the service. Under TestClient, background tasks
    # run in-process, so that would re-exec the pytest command itself and hang
    # the suite. Neutralize the restart here; real (non-test) behavior is unchanged.
    # _restart_process now lives in routers.admin; the factory-reset handler
    # resolves the bare name in that module's namespace, so the patch MUST target
    # routers.admin (patching main._restart_process would be silently vacuous and
    # the suite would re-hang on the first factory-reset test).
    monkeypatch.setattr(routers.admin, "_restart_process", _noop)

    from fastapi.testclient import TestClient

    with TestClient(main.app) as client:
        yield client, main, db_path, nas_dir


@pytest.fixture()
def seeded_db(db_path, nas_dir, monkeypatch):
    """Run real DB migrations into a temp SQLite; yield an open connection."""
    import main
    import db
    import storage
    import jobs

    monkeypatch.setattr(main, "DB_PATH", db_path)
    monkeypatch.setattr(main, "DB_DIR", db_path.parent)
    monkeypatch.setattr(main, "NAS_PATH", nas_dir)
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "DB_DIR", db_path.parent)
    monkeypatch.setattr(storage, "NAS_PATH", nas_dir)
    monkeypatch.setattr(storage, "DB_PATH", db_path)
    monkeypatch.setattr(jobs, "DB_PATH", db_path)
    monkeypatch.setattr(jobs, "NAS_PATH", nas_dir)
    main.init_db()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# Helpers used across multiple test modules
# ---------------------------------------------------------------------------

def insert_document(db_path: Path, **kwargs) -> str:
    """Insert a minimal document row and return its id."""
    import uuid

    doc_id = kwargs.pop("id", str(uuid.uuid4()))
    defaults = {
        "filename": "test.pdf",
        "original_path": str(db_path.parent / "nas" / "originals" / f"{doc_id}.pdf"),
        "processed_text_path": None,
        "thumbnail_path": None,
        "category": None,
        "notes": None,
        "document_date": None,
        "processing_status": "complete",
        "file_hash": None,
        "source": "upload",
        "email_sender": None,
        "summary": None,
        "title": None,
    }
    defaults.update(kwargs)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO documents
           (id, filename, original_path, processed_text_path, thumbnail_path,
            category, notes, document_date, processing_status, file_hash,
            source, email_sender, summary, title)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            doc_id,
            defaults["filename"],
            defaults["original_path"],
            defaults["processed_text_path"],
            defaults["thumbnail_path"],
            defaults["category"],
            defaults["notes"],
            defaults["document_date"],
            defaults["processing_status"],
            defaults["file_hash"],
            defaults["source"],
            defaults["email_sender"],
            defaults["summary"],
            defaults["title"],
        ),
    )
    conn.commit()
    conn.close()
    return doc_id


def insert_job(db_path: Path, doc_id: str, status: str = "complete", error: str = None) -> str:
    """Insert a job row and return its id."""
    import uuid

    job_id = str(uuid.uuid4())
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO jobs (id, document_id, status, error_message) VALUES (?,?,?,?)",
        (job_id, doc_id, status, error),
    )
    conn.commit()
    conn.close()
    return job_id


def insert_vec(db_path: Path, document_id: str, embedding: list, chunk_index: int = 0, chunk_text: str = "test chunk") -> None:
    """Insert a vector embedding into vec_chunk_meta and vec_chunks for tests."""
    import sqlite3 as _sqlite3

    import sqlite_vec
    vc = _sqlite3.connect(db_path)
    vc.enable_load_extension(True)
    sqlite_vec.load(vc)
    vc.enable_load_extension(False)
    vc.execute(
        "INSERT INTO vec_chunk_meta (document_id, chunk_index, chunk_text) VALUES (?,?,?)",
        (document_id, chunk_index, chunk_text),
    )
    rowid = vc.execute("SELECT last_insert_rowid()").fetchone()[0]
    vc.execute(
        "INSERT INTO vec_chunks (rowid, embedding) VALUES (?,?)",
        (rowid, sqlite_vec.serialize_float32(embedding)),
    )
    vc.commit()
    vc.close()
