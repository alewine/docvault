# DocVault — Project Roadmap

**Version:** 1.0  
**Date:** June 2026

---

## Guiding Principles

- Ship working software at the end of every milestone — no milestone ends with broken state
- Local-first: no document content leaves the machine
- Batch processing is fine; overnight jobs are acceptable
- Keep dependencies minimal and well-understood

---

## Milestone Summary

| #   | Name                    | Status     | Key Outcome                                                                      |
| --- | ----------------------- | ---------- | -------------------------------------------------------------------------------- |
| 1   | Foundation              | ✅ Done    | Services launch, health check passes                                             |
| 2   | Ingest Pipeline         | ✅ Done    | Upload + OCR + embed working end-to-end                                          |
| 3   | Search                  | ✅ Done    | Natural language search returns ranked results                                   |
| 4   | Library and Tagging     | ✅ Done    | Full document management CRUD                                                    |
| 5   | Document Q&A            | ✅ Done    | Ask questions, get answers from document contents with citations                 |
| 6   | Vault Health            | ✅ Done    | Vault Health tool audits and cleans up drift between the filesystem and database |
| 7   | Polish and Reliability  | ✅ Done    | Error handling, multi-file upload, NAS warning, filter persistence               |
| 8   | Tailscale Remote Access | ✅ Done    | Secure mobile access via Tailscale                                               |
| 9   | Scan-to-Vault           | 🔄 Planned | Auto-ingest from document scanner via watched inbox folder                       |
| 10  | Email-to-Vault          | 🔄 Planned | Forward attachments from whitelisted senders for auto-ingest                     |

---

## Milestone 9 — Scan-to-Vault

**Goal:** Scan a double-sided document stack and have it appear in DocVault fully processed within seconds — no manual upload, no computer interaction after the initial scanner configuration.

**How it works:**

- Scanner is configured once to output PDFs to a watched inbox folder on the NAS (`/Volumes/RAID/docvault/inbox/`)
- A file watcher (Python `watchdog`, macOS FSEvents) monitors the inbox and fires on new files
- Stability check: watcher waits until file size is unchanged for 2 seconds before treating the file as complete (prevents ingesting mid-write PDFs)
- On stable file: watcher calls `POST /upload` internally — reuses the existing ingest pipeline exactly
- File moves through the normal queue: OCR → embed → index → appears in Library

**Backend tasks:**

- [ ] Add `inbox/` subdirectory to NAS layout (`/Volumes/RAID/docvault/inbox/`)
- [ ] Add `watchdog` to `requirements.txt`
- [ ] Implement `InboxWatcher` class in `main.py`: FSEvents-backed observer, 2-second stability check, calls internal upload handler directly (no HTTP round-trip)
- [ ] Start `InboxWatcher` on FastAPI startup event; stop it on shutdown
- [ ] Move processed inbox files to `originals/` and set `source = 'scanner'` on the resulting document record (new `source` column, consistent with email ingest)
- [ ] Log watcher activity (file detected, stability check passed, job enqueued) to existing processing log

**Scanner configuration (one-time, outside the codebase):**

- [ ] Configure scanner's scan-to-folder destination to `/Volumes/RAID/docvault/inbox/`
- [ ] Enable duplex (double-sided) scanning in scanner profile — output is a single multi-page PDF regardless of page count
- [ ] Optional: configure per-profile filename prefixes (e.g. `medical_`, `financial_`) for automatic pre-tagging at ingest time

**Optional enhancements (not in MVP):**

- Parse scanner-assigned filename prefix to pre-apply a category or tags before enqueueing
- Surface "scanned documents" as a filterable source in the Library alongside 'upload' and 'email'
- `start.sh` warns if `inbox/` directory is missing from NAS

**Done when:** Placing a PDF in `/Volumes/RAID/docvault/inbox/` (simulating a scanner drop) results in the document fully processed and visible in the Library within 10 seconds, with no manual action.

---

## Milestone 10 — Email-to-Vault

**Goal:** Forward or email a document attachment to a designated email address and have it automatically ingested — no UI required.

**Security model:**

- All polling is outbound (IMAP) — no open ports, no public SMTP server
- Transport encryption handled by the email provider (TLS)
- Sender allowlist is the authorization gate: only process attachments from configured addresses
- Email account credentials stored in `.env`, never committed
- Optional: require PGP-signed emails for elevated threat models (not in MVP)

**Backend tasks:**

- [ ] Configure email App Password + IMAP credentials in `.env`
- [ ] Background poller: check INBOX on a configurable interval (default: every 5 minutes)
- [ ] For each unprocessed email: verify `From` address is in `ALLOWED_SENDERS` list (DB-backed, editable via Settings UI)
- [ ] Extract attachments matching supported extensions (`.pdf`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.txt`, `.csv`, `.docx`, `.xlsx`, `.pptx`, `.mp3`, `.wav`)
- [ ] Save attachments to NAS `originals/` and enqueue jobs — reuse the existing ingest pipeline exactly
- [ ] After processing: apply a `DocVault/Processed` label and mark message as read
- [ ] On rejected sender: apply a `DocVault/Rejected` label and log the attempt; do not process
- [ ] New SQLite column `source` on `documents` table: `'upload'` (existing) or `'email'`; `email_sender TEXT` column added

**Config (.env additions):**

```env
EMAIL_ADDRESS=your-docvault-address@example.com
EMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
IMAP_HOST=imap.example.com
EMAIL_POLL_INTERVAL_SECONDS=300
ALLOWED_SENDERS=you@example.com,other@example.com
```

**Frontend tasks:**

- [ ] Settings screen (new): display allowed senders list, add/remove senders, show poller status and recent activity
- [ ] Document detail view: show source badge (`via email` + sender address) for email-ingested documents
- [ ] Library view: show email icon pill on cards for email-sourced documents

**Done when:** Forwarding a PDF attachment from a whitelisted address results in the document fully processed and searchable within 10 minutes, with no manual action on the desktop.

**Email ingest — two-path model (current reality):**

Each accepted message yields exactly one of two outcomes, then the message is trashed:

- [x] **Attachment ingest** — a forwarded email with a supported attachment ingests the attachment via `_ingest_email_attachment` (`source='email'`)
- [x] **Inline-image / screenshot ingest** — when there is no supported attachment, a qualifying inline image is rescued and ingested (`captured_from='inline_image'`), gated by `EMAIL_INLINE_IMAGE_MIN_BYTES` (default 25000) and `EMAIL_INLINE_IMAGE_MIN_DIM` (default 400) so signature logos and tracking pixels are skipped
- [x] Anything that produces neither is moved to Trash

> Body capture of the forwarded email body (the old `convert` command flag / `EMAIL_BODY_COMMAND_WORD` / `EMAIL_CAPTURE_BODY_WHEN_NO_ATTACHMENT`, rendered to PDF via WeasyPrint) was **removed** as a deliberate simplification — no email-body analysis or PDF rendering remains, and the email path makes no network calls.
