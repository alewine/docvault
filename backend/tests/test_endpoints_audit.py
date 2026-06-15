"""Tests for POST /audit/audit and POST /audit/cleanup."""
import sqlite3

from tests.conftest import insert_document


def test_audit_detects_orphaned_record_when_file_missing(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    # Insert doc pointing to a nonexistent file path
    doc_id = insert_document(
        db_path,
        original_path="/nonexistent/path/doc.pdf",
    )

    resp = client.post("/audit/audit")
    assert resp.status_code == 200
    data = resp.json()
    orphaned_ids = [r["document_id"] for r in data["orphaned_records"]]
    assert doc_id in orphaned_ids


def test_cleanup_delete_orphan_record(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.post("/audit/cleanup", json={
        "actions": [{"action": "delete_orphan_record", "target_id": doc_id}]
    })
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert results[0]["status"] == "ok"

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    conn.close()
    assert row is None
