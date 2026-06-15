"""Provider-agnostic IMAP email ingestion.

Owns the email-to-vault pipeline: the long-running `email_poller_loop` and the
blocking `_poll_imap_sync` it drives, plus the IMAP folder-routing helpers
(archive/junk/trash resolution), sender parsing, forwarded-date extraction,
inline-image rescue, and the attachment-to-document hand-off.

Dependency direction is email_ingest -> {config, db}. The attachment hand-off
inserts a `jobs` row directly (the background worker in jobs.py picks it up);
there is no import of jobs.py here. The app-wide single-worker `_executor` lives
in config, so `email_poller_loop` imports it directly at module load — no lazy
`from main import` cycle workaround is needed.

The module is named `email_ingest` (NOT `email`) on purpose: a top-level
`email.py` would shadow the stdlib `email` package that `_poll_imap_sync` and
`_extract_forwarded_date` rely on (`email.parser`, `email.utils`).

NOTE: _poll_imap_sync moved as-is; inner-stage extraction is step 7b.
"""

import asyncio
import json
import re
import uuid
from pathlib import Path

from config import (
    DB_PATH,
    NAS_PATH,
    EMAIL_ADDRESS,
    EMAIL_PASSWORD,
    EMAIL_POLL_INTERVAL_SECONDS,
    IMAP_HOST,
    IMAP_PORT,
    EMAIL_PROCESSED_FOLDER,
    EMAIL_REJECTED_FOLDER,
    EMAIL_INLINE_IMAGE_MIN_BYTES,
    EMAIL_INLINE_IMAGE_MIN_DIM,
    SUPPORTED_EXTENSIONS,
    _executor,
)

from db import log_event, connection


def _extract_email_addr(header: str) -> str:
    m = re.search(r"<([^>]+)>", header)
    return (m.group(1) if m else header).strip().lower()


def _move_to_imap_folder(imap, uid: str, folder: str) -> bool:
    """Copy a message to `folder` and remove it from INBOX.

    Returns True only if the COPY succeeded and the message was expunged.
    Never raises — callers use the bool to decide whether to record the
    message as processed or leave it for the next poll cycle to retry.
    """
    try:
        try:
            ctyp, cdata = imap.create(folder)
            print(f"email_poller: create folder '{folder}' -> {ctyp} {cdata}")
        except Exception as e:
            # Create commonly fails because the folder already exists; that's
            # fine. Log it so genuine failures are still visible.
            print(f"email_poller: create folder '{folder}' raised: {e}")
        typ, data = imap.uid("COPY", uid, folder)
        if typ != "OK":
            print(
                f"email_poller: COPY to '{folder}' failed for message {uid}: "
                f"typ={typ} data={data}"
            )
            return False
        imap.uid("STORE", uid, "+FLAGS", "\\Deleted")
        imap.expunge()
        return True
    except Exception as e:
        print(f"email_poller: move to folder failed ({folder}): {e}")
        return False


_IMAP_LIST_RE = re.compile(
    r'^\((?P<flags>[^)]*)\)\s+(?P<sep>"[^"]*"|NIL)\s+(?P<name>"[^"]*"|\S+)\s*$'
)


def _parse_imap_list_line(line) -> tuple[str, str | None, str] | None:
    """Parse one LIST response line into (flags, separator, mailbox_name).

    Handles the standard forms:
        (\\HasNoChildren \\Archive) "." "INBOX.Archive"   → cPanel/Dovecot
        (\\HasNoChildren) "/" "Archive"                   → GMX/Gmail-style
        (\\Noselect) NIL "INBOX"

    Returns None if the line can't be parsed. `separator` is None for NIL.
    """
    if not line:
        return None
    try:
        decoded = line.decode() if isinstance(line, (bytes, bytearray)) else str(line)
    except Exception:
        return None
    m = _IMAP_LIST_RE.match(decoded.strip())
    if not m:
        return None
    sep_raw = m.group("sep")
    separator = None if sep_raw == "NIL" else sep_raw.strip('"')
    name = m.group("name").strip('"')
    return m.group("flags"), separator, name


def _resolve_imap_folder(imap, special_use_flag: str, configured_name: str) -> str:
    """Resolve the real server mailbox for a logical destination.

    Resolution order:
      1. A mailbox advertising `special_use_flag` (e.g. "\\Archive", "\\Junk",
         "\\Trash") in its LIST flags — the provider-agnostic, authoritative
         answer (wins on GMX/Gmail and Dovecot alike).
      2. The configured name tried as-is if the server lists it, then the same
         name under an "INBOX" + hierarchy-separator prefix using the server's
         actual separator — cPanel/Dovecot nest user folders under INBOX so the
         visible "Archive" is really "INBOX.Archive" on the wire.
      3. The configured name unchanged (create-on-copy will handle it).

    Never raises — falls back to `configured_name` on any failure so callers
    always have a usable destination.
    """
    try:
        typ, folders = imap.list()
        if typ != "OK" or not folders:
            return configured_name
        separator = "."
        existing_names: set[str] = set()
        special_match: str | None = None
        flag_token = special_use_flag.lower()
        for raw in folders:
            parsed = _parse_imap_list_line(raw)
            if not parsed:
                continue
            flags, sep, name = parsed
            if sep:
                separator = sep
            if special_match is None and flag_token in flags.lower():
                special_match = name
            existing_names.add(name)
        if special_match:
            return special_match
        if configured_name in existing_names:
            return configured_name
        prefixed = f"INBOX{separator}{configured_name}"
        if prefixed in existing_names:
            return prefixed
    except Exception:
        pass
    return configured_name


def _find_trash_folder(imap) -> str:
    """Return the server's designated Trash folder name, falling back to 'Trash'."""
    return _resolve_imap_folder(imap, "\\Trash", "Trash")


def _update_email_status(*, last_polled_at: str | None = None, error: str | None = None) -> None:
    with connection() as conn:
        try:
            if last_polled_at is not None:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_last_polled', ?)",
                    (last_polled_at,),
                )
            if error is not None:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_last_error', ?)",
                    (json.dumps(error),),
                )
            elif last_polled_at is not None:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_last_error', 'null')"
                )
            conn.commit()
        except Exception as e:
            print(f"_update_email_status warning: {e}")


def _extract_forwarded_date(msg) -> str | None:
    """Parse the original email's date out of a forwarded message body.

    Walks the message for a text/plain part, finds a "Date:" line in the
    forwarded header block, and tries several parse strategies to handle
    RFC 2822, Gmail, and Outlook formats. Returns a YYYY-MM-DD string or None.
    """
    import datetime as _dt
    from email.utils import parsedate_to_datetime

    body: str | None = None
    for part in msg.walk():
        if part.get_content_type() != "text/plain":
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        try:
            body = payload.decode("utf-8")
        except UnicodeDecodeError:
            body = payload.decode("latin-1")
        break

    if not body:
        print("email_poller: no forwarded date found in body")
        return None

    m = re.search(r"^\s*Date:\s*(.+)$", body, re.MULTILINE)
    if not m:
        print("email_poller: no forwarded date found in body")
        return None

    raw = m.group(1).strip()

    # Strategy a: strip a trailing timezone abbreviation in parens, then RFC 2822
    stripped = re.sub(r"\s*\([A-Za-z]+\)\s*$", "", raw).strip()
    try:
        dt = parsedate_to_datetime(stripped)
        if dt is not None:
            result = dt.strftime("%Y-%m-%d")
            print(f"email_poller: extracted forwarded date {result}")
            return result
    except (TypeError, ValueError):
        pass

    # Strategy b: remove " at " (Gmail-style) and try strptime patterns
    no_at = stripped.replace(" at ", " ")
    for fmt in ("%a, %b %d, %Y %I:%M %p", "%A, %B %d, %Y %I:%M %p"):
        try:
            dt = _dt.datetime.strptime(no_at, fmt)
            result = dt.strftime("%Y-%m-%d")
            print(f"email_poller: extracted forwarded date {result}")
            return result
        except ValueError:
            continue

    # Strategy c: additional strptime patterns without "at"
    for fmt in ("%A, %B %d, %Y %I:%M %p",):
        try:
            dt = _dt.datetime.strptime(stripped, fmt)
            result = dt.strftime("%Y-%m-%d")
            print(f"email_poller: extracted forwarded date {result}")
            return result
        except ValueError:
            continue

    print("email_poller: no forwarded date found in body")
    return None


def _ingest_email_attachment(filename: str, payload: bytes, sender: str, document_date=None, captured_from: str | None = None) -> tuple[str | None, str | None]:
    import hashlib

    original_path: Path | None = None
    try:
        if not NAS_PATH.exists():
            print("email_poller: NAS not mounted, skipping attachment")
            return None, None

        ext = Path(filename).suffix.lower()
        doc_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        original_path = NAS_PATH / "originals" / f"{doc_id}{ext}"

        file_hash = hashlib.sha256(payload).hexdigest()
        original_path.write_bytes(payload)

        with connection() as conn:
            existing = conn.execute(
                "SELECT id FROM documents WHERE file_hash=? ORDER BY uploaded_at ASC LIMIT 1",
                (file_hash,),
            ).fetchone()
            conn.execute(
                "INSERT INTO documents (id, filename, original_path, file_hash, source, email_sender, document_date)"
                " VALUES (?, ?, ?, ?, 'email', ?, ?)",
                (doc_id, filename, str(original_path), file_hash, sender, document_date),
            )
            conn.execute(
                "INSERT INTO jobs (id, document_id) VALUES (?, ?)",
                (job_id, doc_id),
            )
            conn.commit()
            log_event(
                conn, doc_id, "upload",
                status="success",
                message=f"Email attachment from {sender}: {filename} ({len(payload)} bytes)",
                metadata={
                    "file_hash": file_hash,
                    "source": "email",
                    "sender": sender,
                    "duplicate_of": existing[0] if existing else None,
                    "document_date": document_date,
                    "captured_from": captured_from,
                },
            )

        print(f"email_poller: ingested {filename} from {sender} → {doc_id}")
        return doc_id, job_id

    except Exception as e:
        print(f"email_poller: failed to ingest {filename}: {e}")
        if original_path and original_path.exists():
            original_path.unlink(missing_ok=True)
        return None, None


def _message_already_seen(uid: str) -> bool:
    """Return True if this INBOX message UID was already recorded in email_messages."""
    with connection() as conn:
        seen = conn.execute(
            "SELECT id FROM email_messages WHERE message_uid=? AND mailbox='INBOX'",
            (uid,),
        ).fetchone()
    return seen is not None


def _fetch_message(imap, uid: str):
    """FETCH the raw RFC822 message for `uid` and parse it. Returns msg or None."""
    import email as _email_module

    typ2, msg_data = imap.uid("FETCH", uid, "(RFC822)")
    if typ2 != "OK" or not msg_data or not msg_data[0]:
        return None
    raw_bytes = msg_data[0][1]
    return _email_module.message_from_bytes(raw_bytes)


def _reject_message(imap, uid: str, sender_addr: str, subject: str, rejected_folder: str) -> None:
    """Sender not in allowlist: mark \\Seen, move to the rejected folder, record it."""
    imap.uid("STORE", uid, "+FLAGS", "\\Seen")
    _move_to_imap_folder(imap, uid, rejected_folder)
    with connection() as conn:
        conn.execute(
            "INSERT INTO email_messages"
            " (message_uid, mailbox, sender, subject, status)"
            " VALUES (?, 'INBOX', ?, ?, 'rejected')",
            (uid, sender_addr, subject),
        )
        conn.commit()
    print(f"email_poller: rejected from {sender_addr} — not in allowlist")


def _extract_message_attachments(msg, sender_addr: str, forwarded_date) -> tuple[list[str], list[tuple]]:
    """Walk the message parts, ingesting supported attachments.

    Returns `(doc_ids, inline_image_candidates)` — `doc_ids` are the documents
    ingested from real attachments here; `inline_image_candidates` are
    `(part, filename)` tuples held back for the inline-image rescue pass when no
    real attachment was accepted.
    """
    doc_ids: list[str] = []
    inline_image_candidates: list[tuple] = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        disposition = part.get("Content-Disposition")
        disposition_value = str(disposition).strip().lower() if disposition is not None else ""
        filename = part.get_filename()
        ext = Path(filename).suffix.lower() if filename else ""
        is_inline = part.get("Content-ID") is not None or disposition_value.startswith("inline")

        # If it's a supported document type, treat it as an attachment
        # regardless of inline flag. Gmail re-encodes forwarded PDFs with
        # Content-Disposition: inline, so we must not skip them just for
        # being inline. The filename/ext checks are sufficient gatekeeping.
        if ext in SUPPORTED_EXTENSIONS:
            payload_bytes = part.get_payload(decode=True)
            if not payload_bytes:
                continue
            doc_id, _job_id = _ingest_email_attachment(
                filename, payload_bytes, sender_addr, document_date=forwarded_date
            )
            if doc_id:
                doc_ids.append(doc_id)
            continue

        # Not a supported document — if it's an inline image, hold it as a
        # rescue candidate. Forwarded phone screenshots arrive this way.
        # Other inline parts (signature logos, tracking pixels) stay skipped.
        if is_inline and part.get_content_maintype() == "image":
            inline_image_candidates.append((part, filename))
            print(
                f"email_poller: skipping inline part {filename} (Content-ID or inline disposition)"
            )
            continue

        # Not inline, not a supported doc — only process if explicitly
        # disposition=attachment (kept for safety; files with no extension).
        if not disposition_value.startswith("attachment"):
            continue
        if not filename:
            continue
        payload_bytes = part.get_payload(decode=True)
        if not payload_bytes:
            continue
        doc_id, _job_id = _ingest_email_attachment(
            filename, payload_bytes, sender_addr, document_date=forwarded_date
        )
        if doc_id:
            doc_ids.append(doc_id)
    return doc_ids, inline_image_candidates


def _rescue_inline_images(inline_image_candidates, sender_addr: str, forwarded_date, uid: str) -> list[str]:
    """Rescue forwarded phone screenshots embedded inline when no real
    attachment was accepted. Size and dimension gates keep signature logos and
    tracking pixels out. Returns the list of rescued doc_ids.
    """
    import io

    from PIL import Image

    _subtype_ext = {
        "png": ".png",
        "jpeg": ".jpg",
        "jpg": ".jpg",
        "heic": ".heic",
        "heif": ".heif",
    }
    rescued: list[str] = []
    for part, part_filename in inline_image_candidates:
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        if len(payload) < EMAIL_INLINE_IMAGE_MIN_BYTES:
            print(
                f"email_poller: skipping inline image {part_filename} "
                f"— too small ({len(payload)} bytes < "
                f"{EMAIL_INLINE_IMAGE_MIN_BYTES} byte minimum)"
            )
            continue
        width = height = None
        try:
            with Image.open(io.BytesIO(payload)) as im:
                width, height = im.size
        except Exception:
            # PIL can't read this format (e.g. HEIC without the
            # plugin) — fall back to the byte-size gate alone.
            width = height = None
        if width is not None and height is not None and (
            width < EMAIL_INLINE_IMAGE_MIN_DIM
            or height < EMAIL_INLINE_IMAGE_MIN_DIM
        ):
            print(
                f"email_poller: skipping inline image {part_filename} "
                f"— too small ({width}x{height} px < "
                f"{EMAIL_INLINE_IMAGE_MIN_DIM}px minimum dimension)"
            )
            continue
        filename = part_filename
        if not filename:
            ext = _subtype_ext.get(
                part.get_content_subtype().lower(), ".png"
            )
            filename = f"screenshot-{uid}{ext}"
        doc_id, _job_id = _ingest_email_attachment(
            filename, payload, sender_addr,
            document_date=forwarded_date, captured_from="inline_image",
        )
        if doc_id:
            rescued.append(doc_id)
            dims = (
                f"{width}x{height} px"
                if width is not None and height is not None
                else "unknown dimensions"
            )
            print(
                f"email_poller: rescued inline image {filename} "
                f"({len(payload)} bytes, {dims}) from "
                f"{sender_addr} → {doc_id}"
            )
    return rescued


def _trash_message(imap, uid: str, sender_addr: str, subject: str) -> None:
    """No supported attachment and no qualifying inline image — move to Trash and record it."""
    trash_folder = _find_trash_folder(imap)
    _move_to_imap_folder(imap, uid, trash_folder)
    print(f"email_poller: no attachments in message {uid} from {sender_addr} — moved to Trash")
    with connection() as conn:
        conn.execute(
            "INSERT INTO email_messages"
            " (message_uid, mailbox, sender, subject, status)"
            " VALUES (?, 'INBOX', ?, ?, 'trashed')",
            (uid, sender_addr, subject),
        )
        conn.commit()


def _archive_message(imap, uid: str, sender_addr: str, subject: str, processed_folder: str, doc_ids: list[str]) -> None:
    """Record an ingested message as processed and archive it (cosmetic move).

    The attachments are already ingested at this point, so archiving is cosmetic
    mail housekeeping — NOT the ingest gate. Try to move the message to the
    resolved Archive folder, but whether or not the move succeeds we must mark it
    \\Seen and record it as processed. Otherwise a failed move leaves the message
    UNSEEN and unrecorded, and every subsequent poll re-ingests it as duplicate
    documents. The dedup SELECT at the top of the loop plus the \\Seen flag are
    what actually prevent re-ingestion.
    """
    moved = _move_to_imap_folder(imap, uid, processed_folder)
    if not moved:
        print(
            f"email_poller: archive move to '{processed_folder}' FAILED "
            f"for message {uid} from {sender_addr} — attachments already "
            f"ingested ({len(doc_ids)} doc(s)); marking \\Seen and "
            f"recording as processed so it is not re-ingested next poll"
        )
        try:
            imap.uid("STORE", uid, "+FLAGS", "\\Seen")
        except Exception as e:
            print(
                f"email_poller: failed to set \\Seen on message {uid}: {e}"
            )

    with connection() as conn:
        conn.execute(
            "INSERT INTO email_messages"
            " (message_uid, mailbox, sender, subject, status, document_ids)"
            " VALUES (?, 'INBOX', ?, ?, 'processed', ?)",
            (uid, sender_addr, subject, json.dumps(doc_ids)),
        )
        conn.commit()


def _poll_imap_sync() -> dict:
    import datetime as _dt
    import imaplib

    if not EMAIL_ADDRESS or not EMAIL_PASSWORD:
        return {"status": "unconfigured"}

    now_iso = _dt.datetime.utcnow().isoformat() + "Z"
    _update_email_status(last_polled_at=now_iso, error=None)

    with connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='allowed_senders'").fetchone()
        allowed = set(json.loads(row[0])) if row else set()

    if not allowed:
        return {"status": "no_allowed_senders"}

    processed = 0
    try:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        imap.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
        imap.select("INBOX")

        # Resolve the real server mailboxes once per connection. On cPanel/Dovecot
        # the visible "Archive"/"Junk" folders are nested under INBOX (e.g.
        # "INBOX.Archive"); on GMX/Gmail they aren't. Let the special-use flags or
        # the server's own folder list decide rather than guessing the name.
        processed_folder = _resolve_imap_folder(imap, "\\Archive", EMAIL_PROCESSED_FOLDER)
        rejected_folder = _resolve_imap_folder(imap, "\\Junk", EMAIL_REJECTED_FOLDER)

        typ, data = imap.uid("SEARCH", None, "UNSEEN")
        if typ != "OK" or not data or not data[0]:
            imap.logout()
            return {"status": "ok", "processed": 0}

        uids = data[0].decode().split()

        for uid in uids:
            try:
                if _message_already_seen(uid):
                    continue

                msg = _fetch_message(imap, uid)
                if msg is None:
                    continue

                sender_addr = _extract_email_addr(msg.get("From", ""))
                subject = msg.get("Subject", "(no subject)")

                if sender_addr not in allowed:
                    _reject_message(imap, uid, sender_addr, subject, rejected_folder)
                    continue

                forwarded_date = _extract_forwarded_date(msg)

                doc_ids, inline_image_candidates = _extract_message_attachments(
                    msg, sender_addr, forwarded_date
                )

                if not doc_ids and inline_image_candidates:
                    doc_ids += _rescue_inline_images(
                        inline_image_candidates, sender_addr, forwarded_date, uid
                    )

                if not doc_ids:
                    _trash_message(imap, uid, sender_addr, subject)
                    continue

                _archive_message(imap, uid, sender_addr, subject, processed_folder, doc_ids)
                processed += len(doc_ids)

            except Exception as e:
                print(f"email_poller: error on message {uid}: {e}")

        try:
            imap.logout()
        except Exception:
            pass

        return {"status": "ok", "processed": processed}

    except Exception as e:
        err_str = str(e)
        _update_email_status(error=err_str)
        print(f"email_poller: connection error: {e}")
        return {"status": "error", "error": err_str}


async def email_poller_loop() -> None:
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(EMAIL_POLL_INTERVAL_SECONDS)
        try:
            result = await loop.run_in_executor(_executor, _poll_imap_sync)
            if result.get("processed", 0) > 0:
                print(f"email_poller: ingested {result['processed']} attachment(s)")
        except Exception as e:
            print(f"email_poller: loop error: {e}")
