"""Email settings + status endpoints.

Grouped together for cohesion even though their paths diverge
(/settings/email and /email/status), so no router prefix is used —
each path stays exactly as it was in main.py.

Config constants (EMAIL_ADDRESS, etc.) and DB_PATH are referenced via
attribute access on the `config` / `db` modules so that test monkeypatches
on those modules flow through to these handlers at call time.
"""
import json
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

import config
import db

router = APIRouter(tags=["email"])


@router.get("/settings/email")
async def get_email_settings():
    with db.connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings_map = {row["key"]: row["value"] for row in rows}

    allowed_raw = settings_map.get("allowed_senders")
    allowed_senders: list[str] = json.loads(allowed_raw) if allowed_raw else []

    last_error_raw = settings_map.get("email_last_error")
    try:
        last_error = json.loads(last_error_raw) if last_error_raw else None
    except Exception:
        last_error = last_error_raw

    return {
        "email_address": config.EMAIL_ADDRESS or None,
        "configured": bool(config.EMAIL_ADDRESS and config.EMAIL_PASSWORD),
        "allowed_senders": allowed_senders,
        "poll_interval_seconds": config.EMAIL_POLL_INTERVAL_SECONDS,
        "last_polled_at": settings_map.get("email_last_polled"),
        "last_error": last_error,
    }


class UpdateEmailSettingsRequest(BaseModel):
    add_senders: Optional[list[str]] = None
    remove_senders: Optional[list[str]] = None


@router.put("/settings/email")
async def update_email_settings(req: UpdateEmailSettingsRequest):
    with db.connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='allowed_senders'").fetchone()
        current: set[str] = set(json.loads(row[0])) if row else set()

        if req.add_senders:
            for s in req.add_senders:
                s = s.strip().lower()
                if s:
                    current.add(s)
        if req.remove_senders:
            for s in req.remove_senders:
                current.discard(s.strip().lower())

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('allowed_senders', ?)",
            (json.dumps(sorted(current)),),
        )
        conn.commit()
        return {"allowed_senders": sorted(current)}


@router.get("/email/status")
async def get_email_status():
    with db.connection() as conn:
        settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings_map = {row["key"]: row["value"] for row in settings_rows}

        total_processed = conn.execute(
            "SELECT COUNT(*) FROM email_messages WHERE status='processed'"
        ).fetchone()[0]
        total_rejected = conn.execute(
            "SELECT COUNT(*) FROM email_messages WHERE status='rejected'"
        ).fetchone()[0]

        recent = conn.execute(
            "SELECT sender, subject, status, processed_at FROM email_messages"
            " ORDER BY processed_at DESC LIMIT 20"
        ).fetchall()

    last_error_raw = settings_map.get("email_last_error")
    try:
        last_error = json.loads(last_error_raw) if last_error_raw else None
    except Exception:
        last_error = last_error_raw

    return {
        "configured": bool(config.EMAIL_ADDRESS and config.EMAIL_PASSWORD),
        "email_address": config.EMAIL_ADDRESS or None,
        "last_polled_at": settings_map.get("email_last_polled"),
        "last_error": last_error,
        "total_processed": total_processed,
        "total_rejected": total_rejected,
        "recent_messages": [dict(r) for r in recent],
    }
