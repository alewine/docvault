"""Tests for scheduled auto-cleanup of orphaned processed files.

Covers GET/PUT /settings/auto-cleanup and the _run_auto_cleanup_sync worker,
which deletes orphaned files in processed/text and processed/thumbnails only
(never originals/) and logs each deletion to audit_log.
"""
import sqlite3


def test_auto_cleanup_setting_defaults_enabled(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/settings/auto-cleanup")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled"] is True
    assert data["interval_seconds"] == main.AUTO_CLEANUP_INTERVAL_SECONDS


def test_auto_cleanup_setting_can_be_disabled_and_persisted(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put("/settings/auto-cleanup", json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False

    # Persisted to settings table and reflected on GET
    assert client.get("/settings/auto-cleanup").json()["enabled"] is False
    assert main._get_auto_cleanup_enabled() is False


def test_auto_cleanup_removes_orphaned_processed_files(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    text_dir = nas_dir / "processed" / "text"
    thumb_dir = nas_dir / "processed" / "thumbnails"
    text_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    orphan_txt = text_dir / "00000000-0000-0000-0000-000000000001.txt"
    orphan_thumb = thumb_dir / "00000000-0000-0000-0000-000000000002_thumb.jpg"
    orphan_txt.write_text("orphaned text")
    orphan_thumb.write_bytes(b"orphaned thumb")

    result = main._run_auto_cleanup_sync()

    assert result["count"] == 2
    assert not orphan_txt.exists()
    assert not orphan_thumb.exists()

    # Each deletion logged to audit_log with the auto_cleanup_orphan action
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT target_path FROM audit_log WHERE action='auto_cleanup_orphan'"
        ).fetchall()
    finally:
        conn.close()
    logged = {r[0] for r in rows}
    assert str(orphan_txt) in logged
    assert str(orphan_thumb) in logged
