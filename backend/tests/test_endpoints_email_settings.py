"""Tests for email settings and status endpoints."""
import json
import sqlite3

import config

# ---------------------------------------------------------------------------
# GET /settings/email
# ---------------------------------------------------------------------------

def test_get_email_settings_unconfigured(isolated_app, monkeypatch):
    client, main, db_path, nas_dir = isolated_app
    monkeypatch.setattr(config, "EMAIL_ADDRESS", "")
    monkeypatch.setattr(config, "EMAIL_PASSWORD", "")
    resp = client.get("/settings/email")
    assert resp.status_code == 200
    data = resp.json()
    assert data["configured"] is False
    assert data["email_address"] is None
    assert data["allowed_senders"] == []


def test_get_email_settings_configured_when_env_set(isolated_app, monkeypatch):
    client, main, db_path, nas_dir = isolated_app
    monkeypatch.setattr(config, "EMAIL_ADDRESS", "user@gmx.com")
    monkeypatch.setattr(config, "EMAIL_PASSWORD", "secret")

    resp = client.get("/settings/email")
    data = resp.json()
    assert data["configured"] is True
    assert data["email_address"] == "user@gmx.com"


def test_get_email_settings_returns_allowed_senders(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('allowed_senders', ?)",
        (json.dumps(["alice@example.com", "bob@example.com"]),),
    )
    conn.commit()
    conn.close()

    resp = client.get("/settings/email")
    data = resp.json()
    assert set(data["allowed_senders"]) == {"alice@example.com", "bob@example.com"}


def test_get_email_settings_returns_last_error(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    error_payload = {"message": "auth failed", "code": 401}
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('email_last_error', ?)",
        (json.dumps(error_payload),),
    )
    conn.commit()
    conn.close()

    resp = client.get("/settings/email")
    data = resp.json()
    assert data["last_error"]["code"] == 401


def test_get_email_settings_returns_poll_interval(isolated_app, monkeypatch):
    client, main, db_path, nas_dir = isolated_app
    monkeypatch.setattr(config, "EMAIL_POLL_INTERVAL_SECONDS", 600)

    resp = client.get("/settings/email")
    assert resp.json()["poll_interval_seconds"] == 600


# ---------------------------------------------------------------------------
# PUT /settings/email
# ---------------------------------------------------------------------------

def test_put_email_settings_add_sender(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put(
        "/settings/email",
        json={"add_senders": ["carol@example.com"]},
    )
    assert resp.status_code == 200
    assert "carol@example.com" in resp.json()["allowed_senders"]


def test_put_email_settings_add_sender_lowercases(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put(
        "/settings/email",
        json={"add_senders": ["CAROL@EXAMPLE.COM"]},
    )
    assert "carol@example.com" in resp.json()["allowed_senders"]


def test_put_email_settings_add_is_idempotent(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    client.put("/settings/email", json={"add_senders": ["alice@example.com"]})
    client.put("/settings/email", json={"add_senders": ["alice@example.com"]})

    resp = client.get("/settings/email")
    assert resp.json()["allowed_senders"].count("alice@example.com") == 1


def test_put_email_settings_remove_sender(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    client.put("/settings/email", json={"add_senders": ["alice@example.com", "bob@example.com"]})

    resp = client.put(
        "/settings/email",
        json={"remove_senders": ["alice@example.com"]},
    )
    senders = resp.json()["allowed_senders"]
    assert "alice@example.com" not in senders
    assert "bob@example.com" in senders


def test_put_email_settings_remove_nonexistent_is_noop(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put(
        "/settings/email",
        json={"remove_senders": ["nobody@example.com"]},
    )
    assert resp.status_code == 200


def test_put_email_settings_add_and_remove_in_one_request(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    client.put("/settings/email", json={"add_senders": ["old@example.com"]})

    resp = client.put(
        "/settings/email",
        json={"add_senders": ["new@example.com"], "remove_senders": ["old@example.com"]},
    )
    senders = set(resp.json()["allowed_senders"])
    assert "new@example.com" in senders
    assert "old@example.com" not in senders


# ---------------------------------------------------------------------------
# GET /email/status
# ---------------------------------------------------------------------------

def test_get_email_status_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/email/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_processed"] == 0
    assert data["total_rejected"] == 0
    assert data["recent_messages"] == []


def test_get_email_status_counts(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO email_messages (message_uid, mailbox, sender, subject, status)"
        " VALUES ('uid1', 'INBOX', 'a@b.com', 'sub1', 'processed')"
    )
    conn.execute(
        "INSERT INTO email_messages (message_uid, mailbox, sender, subject, status)"
        " VALUES ('uid2', 'INBOX', 'c@d.com', 'sub2', 'rejected')"
    )
    conn.execute(
        "INSERT INTO email_messages (message_uid, mailbox, sender, subject, status)"
        " VALUES ('uid3', 'INBOX', 'e@f.com', 'sub3', 'processed')"
    )
    conn.commit()
    conn.close()

    resp = client.get("/email/status")
    data = resp.json()
    assert data["total_processed"] == 2
    assert data["total_rejected"] == 1
    assert len(data["recent_messages"]) == 3


def test_get_email_status_includes_last_error(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('email_last_error', ?)",
        (json.dumps({"message": "timeout"}),),
    )
    conn.commit()
    conn.close()

    resp = client.get("/email/status")
    assert resp.json()["last_error"]["message"] == "timeout"
