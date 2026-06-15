"""Tests for /admin/factory-reset and /audit/dismiss-pair."""
import sqlite3

from tests.conftest import insert_document, insert_job

# ---------------------------------------------------------------------------
# POST /admin/factory-reset
# ---------------------------------------------------------------------------

def test_factory_reset_returns_success(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/admin/factory-reset")
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True


def test_factory_reset_clears_documents_table(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    # Seed a document
    insert_document(db_path)
    conn = sqlite3.connect(db_path)
    count_before = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    conn.close()
    assert count_before == 1

    client.post("/admin/factory-reset")

    conn = sqlite3.connect(db_path)
    count_after = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    conn.close()
    assert count_after == 0


def test_factory_reset_clears_jobs_table(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    insert_job(db_path, doc_id)

    client.post("/admin/factory-reset")

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    conn.close()
    assert count == 0


def test_factory_reset_clears_tags_table(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, "important"))
    conn.commit()
    conn.close()

    client.post("/admin/factory-reset")

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
    conn.close()
    assert count == 0


def test_factory_reset_removes_nas_files(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    # Create a file in originals
    orig = nas_dir / "originals" / "some_file.pdf"
    orig.write_bytes(b"content")
    assert orig.exists()

    client.post("/admin/factory-reset")

    # File should be deleted by factory reset
    assert not orig.exists()


def test_factory_reset_clears_vec_tables(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    from tests.conftest import insert_document, insert_vec

    # Insert a document and its vec embedding
    doc_id = insert_document(db_path)
    insert_vec(db_path, doc_id, [0.1] * 768)

    resp = client.post("/admin/factory-reset")
    assert resp.status_code == 200

    # After reset, vec tables should be empty and DB still accessible
    import sqlite3
    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM vec_chunk_meta").fetchone()[0]
    conn.close()
    assert count == 0

    resp2 = client.get("/categories")
    assert resp2.status_code == 200


# ---------------------------------------------------------------------------
# POST /audit/dismiss-pair
# ---------------------------------------------------------------------------

def test_dismiss_pair_stores_in_db(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/audit/dismiss-pair", json={
        "doc_id_a": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "doc_id_b": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    })
    assert resp.status_code == 200
    assert resp.json()["dismissed"] is True

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT * FROM audit_dismissed_pairs").fetchone()
    conn.close()
    assert row is not None


def test_dismiss_pair_normalizes_order(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    # Dismiss with a > b
    client.post("/audit/dismiss-pair", json={
        "doc_id_a": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
        "doc_id_b": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    })

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT doc_id_a, doc_id_b FROM audit_dismissed_pairs").fetchone()
    conn.close()
    assert row is not None
    # min(a, b) should be stored in doc_id_a
    assert row[0] < row[1]


def test_dismiss_pair_idempotent(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    b = "cccccccc-cccc-cccc-cccc-cccccccccccc"

    # Dismiss twice — should not raise or create duplicate
    client.post("/audit/dismiss-pair", json={"doc_id_a": a, "doc_id_b": b})
    resp = client.post("/audit/dismiss-pair", json={"doc_id_a": a, "doc_id_b": b})
    assert resp.status_code == 200

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM audit_dismissed_pairs").fetchone()[0]
    conn.close()
    assert count == 1
