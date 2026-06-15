"""Tests for database initialization, schema creation, and migration functions."""
import sqlite3

# ---------------------------------------------------------------------------
# Schema creation
# ---------------------------------------------------------------------------

EXPECTED_TABLES = {
    "documents",
    "tags",
    "jobs",
    "documents_fts",
    "document_log",
    "job_events",
    "audit_log",
    "settings",
    "email_messages",
    "categories",
}


def test_init_db_creates_all_tables(seeded_db):
    tables = {
        row["name"]
        for row in seeded_db.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    assert EXPECTED_TABLES <= tables


def test_init_db_seeds_eight_default_categories(seeded_db):
    count = seeded_db.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    assert count == 8


def test_init_db_default_categories_names(seeded_db):
    names = {
        row[0]
        for row in seeded_db.execute("SELECT name FROM categories").fetchall()
    }
    assert names == {"Audio", "Education", "Financial", "Home", "Insurance", "Legal", "Medical", "Other"}


def test_init_db_default_categories_are_marked_default(seeded_db):
    non_default = seeded_db.execute(
        "SELECT COUNT(*) FROM categories WHERE is_default = 0"
    ).fetchone()[0]
    assert non_default == 0


# ---------------------------------------------------------------------------
# Migrations — additive column migrations are idempotent
# ---------------------------------------------------------------------------

def _column_names(conn, table):
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def test_maybe_migrate_summary_adds_column(db_path, monkeypatch):
    import main

    monkeypatch.setattr(main, "DB_PATH", db_path)
    monkeypatch.setattr(main, "DB_DIR", db_path.parent)
    # Create documents table WITHOUT the summary column
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL)")
    conn.commit()
    main._maybe_migrate_summary(conn)
    assert "summary" in _column_names(conn, "documents")
    conn.close()


def test_maybe_migrate_summary_noop_when_column_exists(db_path):
    import main

    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, summary TEXT)")
    conn.commit()
    # Should not raise
    main._maybe_migrate_summary(conn)
    assert _column_names(conn, "documents").count("summary") == 1
    conn.close()


def test_maybe_migrate_title_column_adds_column(db_path):
    import main

    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, filename TEXT)")
    conn.commit()
    main._maybe_migrate_title_column(conn)
    assert "title" in _column_names(conn, "documents")
    conn.close()


def test_maybe_migrate_email_fields_adds_source_and_sender(db_path):
    import main

    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, filename TEXT)")
    conn.commit()
    main._maybe_migrate_email_fields(conn)
    cols = _column_names(conn, "documents")
    assert "source" in cols
    assert "email_sender" in cols
    conn.close()


def test_maybe_migrate_email_fields_noop_when_already_present(db_path):
    import main

    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT, email_sender TEXT)"
    )
    conn.commit()
    main._maybe_migrate_email_fields(conn)
    # Columns still present exactly once
    cols = _column_names(conn, "documents")
    assert cols.count("source") == 1
    assert cols.count("email_sender") == 1
    conn.close()


def test_maybe_migrate_categories_noop_when_already_seeded(seeded_db):
    import main

    # Already seeded by init_db — calling again should not insert duplicates
    main._maybe_migrate_categories(seeded_db)
    count = seeded_db.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    assert count == 8


def test_maybe_seed_allowed_senders_reads_env(db_path, nas_dir, monkeypatch):
    import main
    import db

    monkeypatch.setattr(main, "DB_PATH", db_path)
    monkeypatch.setattr(main, "DB_DIR", db_path.parent)
    monkeypatch.setattr(main, "NAS_PATH", nas_dir)
    # init_db + _maybe_seed_allowed_senders live in db.py and resolve these
    # names in db's own globals.
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "DB_DIR", db_path.parent)
    monkeypatch.setattr(db, "ALLOWED_SENDERS_ENV", "alice@example.com, BOB@EXAMPLE.COM")
    main.init_db()

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT value FROM settings WHERE key='allowed_senders'"
    ).fetchone()
    conn.close()
    assert row is not None
    import json

    senders = json.loads(row[0])
    assert "alice@example.com" in senders
    assert "bob@example.com" in senders  # lowercased


def test_maybe_seed_allowed_senders_skips_when_row_exists(seeded_db, monkeypatch):
    import json

    import main

    seeded_db.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('allowed_senders', ?)",
        (json.dumps(["existing@example.com"]),),
    )
    seeded_db.commit()
    import db
    monkeypatch.setattr(db, "ALLOWED_SENDERS_ENV", "new@example.com")
    main._maybe_seed_allowed_senders(seeded_db)
    row = seeded_db.execute(
        "SELECT value FROM settings WHERE key='allowed_senders'"
    ).fetchone()
    senders = json.loads(row[0])
    assert senders == ["existing@example.com"]  # unchanged


def test_maybe_seed_allowed_senders_noop_when_env_empty(seeded_db, monkeypatch):
    import main
    import db

    monkeypatch.setattr(db, "ALLOWED_SENDERS_ENV", "")
    main._maybe_seed_allowed_senders(seeded_db)
    row = seeded_db.execute(
        "SELECT value FROM settings WHERE key='allowed_senders'"
    ).fetchone()
    assert row is None


# ---------------------------------------------------------------------------
# log_event / log_job_event
# ---------------------------------------------------------------------------

def test_log_event_inserts_row(seeded_db):
    import main

    seeded_db.execute(
        """INSERT INTO documents (id, filename, original_path)
           VALUES ('doc-log-1', 'test.pdf', '/tmp/test.pdf')"""
    )
    seeded_db.commit()
    main.log_event(seeded_db, "doc-log-1", "ocr", status="ok", message="done")
    row = seeded_db.execute(
        "SELECT * FROM document_log WHERE document_id='doc-log-1'"
    ).fetchone()
    assert row is not None
    assert row["event_type"] == "ocr"
    assert row["status"] == "ok"


def test_log_event_with_metadata(seeded_db):
    import main

    seeded_db.execute(
        "INSERT INTO documents (id, filename, original_path) VALUES ('doc-log-2','f.pdf','/tmp/f.pdf')"
    )
    seeded_db.commit()
    main.log_event(
        seeded_db, "doc-log-2", "embed", metadata={"chunk_count": 3}
    )
    row = seeded_db.execute(
        "SELECT metadata FROM document_log WHERE document_id='doc-log-2'"
    ).fetchone()
    assert row is not None
    import json

    assert json.loads(row["metadata"])["chunk_count"] == 3


def test_log_job_event_inserts_row(seeded_db):
    import main

    seeded_db.execute(
        "INSERT INTO documents (id, filename, original_path) VALUES ('doc-je-1','f.pdf','/tmp/f.pdf')"
    )
    seeded_db.execute(
        "INSERT INTO jobs (id, document_id) VALUES ('job-je-1', 'doc-je-1')"
    )
    seeded_db.commit()
    main.log_job_event(seeded_db, "job-je-1", "started")
    row = seeded_db.execute(
        "SELECT event FROM job_events WHERE job_id='job-je-1'"
    ).fetchone()
    assert row is not None
    assert row["event"] == "started"
