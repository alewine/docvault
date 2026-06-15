"""SQLite schema, migrations, and connection helpers.

Owns the database layer: the canonical `SCHEMA_SQL`, every additive
`_maybe_migrate_*` helper, `init_db()` (the startup migration+create runner),
the sqlite-vec connection factory `_vec_conn()`, a generic `connection()`
context manager, and the doc-scoped vector delete helper. main.py re-exports
these names so existing call sites and the test suite keep resolving them.
"""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from config import (
    DB_PATH,
    DB_DIR,
    ALLOWED_SENDERS_ENV,
)


def _tags_for_documents(conn: sqlite3.Connection, doc_ids: list[str]) -> dict[str, list[str]]:
    """Fetch tags for many documents in a single query, keyed by document_id."""
    if not doc_ids:
        return {}
    placeholders = ",".join("?" * len(doc_ids))
    rows = conn.execute(
        f"SELECT document_id, tag FROM tags WHERE document_id IN ({placeholders})",
        doc_ids,
    ).fetchall()
    result: dict[str, list[str]] = {doc_id: [] for doc_id in doc_ids}
    for document_id, tag in rows:
        result.setdefault(document_id, []).append(tag)
    return result


def _get_auto_cleanup_enabled() -> bool:
    """Whether scheduled auto-cleanup is on. Defaults to enabled when unset."""
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key='auto_cleanup_orphans'"
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return True
    return row[0] == "1"


def log_event(
    conn: sqlite3.Connection,
    document_id: str,
    event_type: str,
    *,
    pipeline_path: str | None = None,
    char_count: int | None = None,
    chunk_count: int | None = None,
    status: str | None = None,
    message: str | None = None,
    metadata: dict | None = None,
) -> None:
    try:
        conn.execute(
            "INSERT INTO document_log"
            " (document_id, event_type, pipeline_path, char_count, chunk_count, status, message, metadata)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                document_id,
                event_type,
                pipeline_path,
                char_count,
                chunk_count,
                status,
                message,
                json.dumps(metadata) if metadata is not None else None,
            ),
        )
        conn.commit()
    except Exception as e:
        print(f"log_event warning ({event_type} for {document_id}): {e}")


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_path TEXT NOT NULL,
    processed_text_path TEXT,
    thumbnail_path TEXT,
    category TEXT,
    notes TEXT,
    document_date DATE,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processing_status TEXT DEFAULT 'queued',
    file_hash TEXT,
    source TEXT DEFAULT 'upload',
    email_sender TEXT,
    summary TEXT,
    title TEXT,
    starred INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    tag TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_document ON tags(document_id);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    document_id UNINDEXED,
    extracted_text,
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS document_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    pipeline_path TEXT,
    char_count INTEGER,
    chunk_count INTEGER,
    status TEXT,
    message TEXT,
    metadata JSON
);

CREATE INDEX IF NOT EXISTS idx_document_log_document ON document_log(document_id);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_id TEXT,
    target_path TEXT,
    performed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_uid TEXT NOT NULL,
    mailbox TEXT NOT NULL DEFAULT 'INBOX',
    sender TEXT,
    subject TEXT,
    status TEXT NOT NULL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    document_ids TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_uid ON email_messages(message_uid, mailbox);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    is_default INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_dismissed_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id_a TEXT NOT NULL,
    doc_id_b TEXT NOT NULL,
    dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(doc_id_a, doc_id_b)
);
"""

_DEFAULT_CATEGORIES = ["Audio", "Education", "Financial", "Home", "Insurance", "Legal", "Medical", "Other"]


def _maybe_migrate_summary(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if not cols or "summary" in cols:
        return
    print("Migrating documents table: adding summary column…")
    conn.execute("ALTER TABLE documents ADD COLUMN summary TEXT")
    conn.commit()
    print("summary migration complete")


def _maybe_migrate_title_column(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if not cols or "title" in cols:
        return
    print("Migrating documents table: adding title column…")
    conn.execute("ALTER TABLE documents ADD COLUMN title TEXT")
    conn.commit()
    print("title migration complete")


def _maybe_migrate_email_fields(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if not cols:
        return
    changed = False
    if "source" not in cols:
        conn.execute("ALTER TABLE documents ADD COLUMN source TEXT DEFAULT 'upload'")
        changed = True
    if "email_sender" not in cols:
        conn.execute("ALTER TABLE documents ADD COLUMN email_sender TEXT")
        changed = True
    if changed:
        conn.commit()
        print("email_fields migration complete")


def _maybe_migrate_category_locked(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if "category_locked" in cols:
        return
    print("Migrating documents table: adding category_locked column…")
    conn.execute("ALTER TABLE documents ADD COLUMN category_locked BOOLEAN NOT NULL DEFAULT 0")
    conn.commit()
    print("category_locked migration complete")


def _maybe_migrate_dismissed_pairs(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS audit_dismissed_pairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id_a TEXT NOT NULL,
            doc_id_b TEXT NOT NULL,
            dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(doc_id_a, doc_id_b)
        )
    """)
    conn.commit()


def _maybe_migrate_starred(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if "starred" in cols:
        return
    print("Migrating documents table: adding starred column…")
    conn.execute("ALTER TABLE documents ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    print("starred migration complete")


def _maybe_migrate_categories(conn: sqlite3.Connection) -> None:
    existing = {r[0] for r in conn.execute("SELECT name FROM categories").fetchall()}
    canonical = set(_DEFAULT_CATEGORIES)
    if existing == canonical:
        return
    # Resync: delete all rows and reseed with the canonical 8
    print("Resyncing categories table to canonical list…")
    conn.execute("DELETE FROM categories")
    for name in _DEFAULT_CATEGORIES:
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, is_default) VALUES (?, 1)", (name,)
        )
    conn.commit()
    print(f"Categories resynced: {sorted(canonical)}")


def _maybe_migrate_remove_vehicle_category(conn: sqlite3.Connection) -> None:
    # "Vehicle" was retired as a category; remove it from the categories table
    # and reassign any documents still tagged with it to "Other".
    cat_deleted = conn.execute(
        "DELETE FROM categories WHERE name = 'Vehicle'"
    ).rowcount
    docs_updated = conn.execute(
        "UPDATE documents SET category = 'Other' WHERE category = 'Vehicle'"
    ).rowcount
    conn.commit()
    if cat_deleted:
        print(f"Removed 'Vehicle' category row ({cat_deleted} deleted)")
    if docs_updated:
        print(f"Reassigned {docs_updated} document(s) from 'Vehicle' to 'Other'")


def _maybe_migrate_vec_table(conn: sqlite3.Connection) -> None:
    conn.enable_load_extension(True)
    import sqlite_vec as _sv
    _sv.load(conn)
    conn.enable_load_extension(False)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
            embedding float[768]
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vec_chunk_meta (
            rowid     INTEGER PRIMARY KEY,
            document_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            chunk_text  TEXT NOT NULL
        )
    """)
    conn.commit()


def _vec_conn() -> sqlite3.Connection:
    import sqlite_vec as _sv
    vc = sqlite3.connect(DB_PATH)
    vc.enable_load_extension(True)
    _sv.load(vc)
    vc.enable_load_extension(False)
    return vc


@contextmanager
def connection(row_factory=sqlite3.Row, timeout: float | None = None) -> Iterator[sqlite3.Connection]:
    """Open a SQLite connection to DB_PATH and guarantee it is closed.

    Defaults to `sqlite3.Row` rows; pass `row_factory=None` (or another
    factory) to override per call site. Pass `timeout` (seconds) to override
    sqlite3's default 5 s busy-wait — e.g. a short timeout for a quick health
    probe that should fail fast rather than block. Pure boilerplate
    consolidation — it adds no pragmas or WAL mode.
    """
    conn = sqlite3.connect(DB_PATH) if timeout is None else sqlite3.connect(DB_PATH, timeout=timeout)
    if row_factory is not None:
        conn.row_factory = row_factory
    try:
        yield conn
    finally:
        conn.close()


def delete_document_vectors(doc_id: str, vc: sqlite3.Connection | None = None) -> None:
    """Delete a document's rows from vec_chunks + vec_chunk_meta.

    When `vc` is omitted, a dedicated sqlite-vec connection is opened,
    committed, and closed. When `vc` is supplied, the deletes run on the
    caller's connection without committing or closing it (the caller owns the
    surrounding transaction — e.g. embed_document re-inserts on the same vc).
    """
    own = vc is None
    if own:
        vc = _vec_conn()
    try:
        vc.execute(
            "DELETE FROM vec_chunks WHERE rowid IN (SELECT rowid FROM vec_chunk_meta WHERE document_id=?)",
            (doc_id,),
        )
        vc.execute("DELETE FROM vec_chunk_meta WHERE document_id=?", (doc_id,))
        if own:
            vc.commit()
    finally:
        if own:
            vc.close()


def _maybe_seed_allowed_senders(conn: sqlite3.Connection) -> None:
    if not ALLOWED_SENDERS_ENV:
        return
    row = conn.execute("SELECT value FROM settings WHERE key='allowed_senders'").fetchone()
    if row:
        return
    senders = sorted({s.strip().lower() for s in ALLOWED_SENDERS_ENV.split(",") if s.strip()})
    if senders:
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('allowed_senders', ?)",
            (json.dumps(senders),),
        )
        conn.commit()
        print(f"Seeded {len(senders)} allowed sender(s) from ALLOWED_SENDERS env var")


def _maybe_migrate_file_hash(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
    if not cols or "file_hash" in cols:
        return
    print("Migrating documents table: adding file_hash column…")
    conn.execute("ALTER TABLE documents ADD COLUMN file_hash TEXT")
    # Backfill hashes for existing documents where the original file still exists
    import hashlib
    rows = conn.execute("SELECT id, original_path FROM documents WHERE original_path IS NOT NULL").fetchall()
    backfilled = 0
    for doc_id, original_path in rows:
        try:
            p = Path(original_path)
            if p.exists():
                h = hashlib.sha256(p.read_bytes()).hexdigest()
                conn.execute("UPDATE documents SET file_hash=? WHERE id=?", (h, doc_id))
                backfilled += 1
        except Exception as e:
            print(f"file_hash backfill warning {doc_id}: {e}")
    conn.commit()
    print(f"file_hash migration complete: {backfilled} documents hashed")


def _maybe_migrate_audit_log(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_health_log'"
    ).fetchone()
    if not row:
        return
    print("Migrating vault_health_log → audit_log…")
    conn.execute("ALTER TABLE vault_health_log RENAME TO audit_log")
    conn.commit()
    print("audit_log migration complete")


def _maybe_migrate_fts(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'"
    ).fetchone()
    if not row or "content=''" not in row[0]:
        return
    print("Migrating FTS table from contentless to content-storing…")
    conn.execute("DROP TABLE IF EXISTS documents_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE documents_fts USING fts5(
            document_id UNINDEXED,
            extracted_text,
            tokenize='porter unicode61'
        )
    """)
    rows = conn.execute(
        "SELECT id, processed_text_path FROM documents"
        " WHERE processing_status='complete' AND processed_text_path IS NOT NULL"
    ).fetchall()
    backfilled = 0
    for doc_id, text_path in rows:
        try:
            text = Path(text_path).read_text(encoding="utf-8")
            conn.execute(
                "INSERT INTO documents_fts (document_id, extracted_text) VALUES (?, ?)",
                (doc_id, text),
            )
            backfilled += 1
        except Exception as e:
            print(f"FTS backfill warning {doc_id}: {e}")
    conn.commit()
    print(f"FTS migration complete: {backfilled} documents re-indexed")


def init_db() -> None:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        _maybe_migrate_audit_log(conn)
        _maybe_migrate_fts(conn)
        _maybe_migrate_file_hash(conn)
        _maybe_migrate_summary(conn)
        _maybe_migrate_title_column(conn)
        _maybe_migrate_email_fields(conn)
        conn.executescript(SCHEMA_SQL)
        conn.commit()
        _maybe_migrate_starred(conn)
        _maybe_migrate_categories(conn)
        _maybe_migrate_remove_vehicle_category(conn)
        _maybe_migrate_dismissed_pairs(conn)
        _maybe_migrate_category_locked(conn)
        _maybe_migrate_vec_table(conn)
        _maybe_seed_allowed_senders(conn)
    finally:
        conn.close()
    print(f"SQLite ready at {DB_PATH}")


def _reset_stuck_processing_jobs() -> int:
    """Reset any jobs left in processing status back to queued. Returns count reset."""
    conn = sqlite3.connect(DB_PATH)
    try:
        stuck = conn.execute(
            "SELECT id, document_id FROM jobs WHERE status = 'processing'"
        ).fetchall()
        if not stuck:
            return 0
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
        return len(stuck)
    finally:
        conn.close()
