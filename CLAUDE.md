# CLAUDE.md

<!-- Last updated: 2026-06-12 — Provider-agnostic IMAP email ingest (configurable via backend/.env, see .env.example); no-attachment emails moved to server \Trash (`_find_trash_folder`) -->

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DocVault is a locally-hosted personal document management system. Two long-running processes talk to each other over localhost — a Python FastAPI backend (`:8777`) and a Next.js 14 frontend (`:3777`). All OCR, embedding, and search happens on-device via Ollama. No document content leaves the machine.

Full architecture detail is in `TECH_SPEC.md`. Milestone plan is in `ROADMAP.md`. Phase 1 complete. Phase 2 complete (Tailscale). Phase 3 complete (Email-to-Vault). Currently at **Phase 4** — ongoing improvements. Recent additions: pre-upload duplicate check via `/check-duplicate` (SHA-256), folder drag-and-drop + folder picker in `UploadButton.tsx`, `GET /categories` endpoint + `categories` DB table (seeded with 7 defaults), `POST /admin/factory-reset` endpoint (wipes all data), `POST /audit/dismiss-pair` endpoint + `dismissed_pairs` table, `UploadButton` polling refactored with `clearItemActivity()`, unsupported file type detection in `UploadButton`, `GET /jobs/status` + `POST /jobs/reprocess-all` endpoints, "Reprocess All" action in `AuditView`. `SearchView.tsx` removed — search merged into `LibraryView.tsx`. Image files now go through `ocr_file()` in `process_job` (special-case skip removed). `AuditView` duplicate section now cluster-aware: per-cluster selection/dismiss/delete UI matching the cluster response shape from `/audit/audit`.

When changes require a restart to the service, let the user know at the end of the change

## Running the services

```bash
# Start both services + open browser
./start.sh

# Stop both services
./stop.sh
```

`start.sh` checks that the storage directory exists and is writable (reads `DOCVAULT_STORAGE_PATH` from `backend/.env`, falls back to `~/Documents/DocVault`), optionally starts Ollama, then starts uvicorn and Next.js dev server. PIDs are written to `/tmp/docvault-*.pid`; logs go to `/tmp/docvault-*.log`.

To run services individually:

```bash
# Backend
cd backend
source .venv/bin/activate
uvicorn main:app --port 8777 --reload

# Frontend
cd frontend
npm run dev
```

## Testing

**Always run tests in the foreground and wait for them to finish.** Never push a test run (pytest, `npm run test`, etc.) into the background — the result is needed before continuing.

### Coverage philosophy

Frontend tests cover only a small set of high-value units. Large UI components (`DocumentDetail`, `LibraryView`, `AuditView`, `AskView`, `TagManagerView`, `SettingsView`, `UploadButton`) are intentionally excluded — they are deep React trees with conditional rendering paths that are expensive to simulate and brittle to maintain.

**Do not add tests when implementing new features in excluded components.** Do not pad coverage. Do not notify the user if coverage does not change on excluded files.

The only files under active coverage enforcement are:

- `frontend/app/lib/backend.ts`
- `frontend/app/lib/categories.ts`
- `frontend/app/lib/fileDropUtils.ts`
- `frontend/app/components/HealthScreen.tsx`

If a change touches one of those four files, update the corresponding test file.

### Backend tests (pytest)

```bash
cd backend
source .venv/bin/activate
pytest
pytest tests/test_endpoints_documents.py      # run a single file
```

- Config: `backend/pytest.ini` — `asyncio_mode = auto`; no coverage floor enforced (fast happy-path only — run `pytest --cov=main` manually if you want a coverage report). ~172 tests, runs in a few seconds.
- Tests live in `backend/tests/` — one file per concern:
  - `conftest.py` — `isolated_app` fixture (real temp SQLite with sqlite-vec + background loops suppressed), `seeded_db` fixture
  - `test_pure_functions.py` — `chunk_text`, `_sanitize_fts`, `_extract_email_addr`, `_title_fallback`
  - `test_db_init.py` — migration functions, schema, category seeding, log helpers
  - `test_endpoints_simple.py` — `/health`, `/categories`, `/tags`, `/check-duplicate`, `/audit/log`
  - `test_endpoints_documents.py` — CRUD for documents, `/status`, `/jobs/failed`
  - `test_endpoints_tags.py` — rename, delete, frequency sort
  - `test_endpoints_search.py` — hybrid search, FTS fallback, filters
  - `test_endpoints_audit.py` — orphan detection, cleanup action (happy path)
  - `test_endpoints_email_settings.py` — email config, allowed senders
  - `test_endpoints_media.py` — thumbnail, audio stream, PDF unlock
  - `test_endpoints_admin.py` — factory reset, dismiss-pair
  - `test_auto_cleanup.py` — `/settings/auto-cleanup` GET/PUT, `_run_auto_cleanup_sync` (orphan removal happy path)
  - `test_endpoints_ask.py` — SSE stream RAG happy path (valid question → chunks → streamed answer)
  - `test_process_job.py` — `process_job()` direct call, `.txt`/`.mp3` happy paths

### Frontend tests (Vitest + React Testing Library)

```bash
cd frontend
npm run test             # run all tests
npm run test:coverage
```

- Config: `frontend/vitest.config.ts` — jsdom environment, v8 coverage provider, `@` alias to project root
- Setup: `frontend/vitest.setup.ts` — jest-dom matchers, `webcrypto` polyfill for SHA-256, `window.matchMedia` polyfill, `navigator.clipboard` polyfill
- Tests live in `frontend/app/__tests__/`:
  - `backend.test.ts` — BACKEND_URL resolves correctly in SSR and browser contexts
  - `categories.test.ts` — `fetchCategoryNames` (success, error, empty, falsy filter), `withSelectedCategory` (all branches)
  - `HealthScreen.test.tsx` — loading, backend error, all-green, LLM-soft-fail, hard fail, `onHealthy` callback
  - `fileDropUtils.test.ts` — `readFileEntry`, `readDirectoryEntries`, `flattenEntry` (file/dir/unknown), `getDroppedFiles` (items path, fallback path)

## Backend (Python / FastAPI)

```bash
cd backend
source .venv/bin/activate

# Install / update deps
pip install -r requirements.txt

# Lint (no linter configured yet — add ruff when needed)
```

- Single file for now: `backend/main.py`
- On startup: runs FTS migration if needed, runs `file_hash` column migration if needed, initializes SQLite schema, creates NAS subdirs if mounted, initializes sqlite-vec tables
- Storage path: `NAS_PATH` is derived from `os.getenv("DOCVAULT_STORAGE_PATH", str(Path.home() / "Documents" / "DocVault"))` — set `DOCVAULT_STORAGE_PATH` in `backend/.env` to point at a NAS or external drive
- Persistent data lives outside the repo:
  - SQLite (metadata + vec_chunks) → `~/Library/Application Support/docvault/db/`
  - Raw files + extracted text → `$DOCVAULT_STORAGE_PATH` (default: `~/Documents/DocVault`)

## Frontend (Next.js 14 / TypeScript / Tailwind)

```bash
cd frontend
npm run dev       # dev server on :3777
npm run build     # production build
npm run lint      # ESLint
```

- App Router (`frontend/app/`). No `src/` directory.
- Backend URL is derived from `window.location.hostname` in `frontend/app/lib/backend.ts` and imported by every component — resolves to `http://127.0.0.1:8777` locally or `http://[tailscale-ip]:8777` when accessed remotely.
- CORS allows `http://localhost:3777`, `http://127.0.0.1:3777`, and via regex: Tailscale IPs (`100.x.x.x`) and MagicDNS hostnames (`*.ts.net`) (configured in `backend/main.py`).
- Uvicorn binds to `0.0.0.0` (not `127.0.0.1`) so the backend is reachable on the Tailscale interface.
- `app/page.tsx` orchestrates views: shows `HealthScreen` until all systems green, then renders a top nav (Ask / Library / Tags / Audit / Settings) and routes to `DocumentDetail` when a card is clicked. Includes global drag-and-drop handler (drops files into the upload queue) and periodic NAS health check (every 60 s) that shows a warning banner if NAS goes offline.
- Components live in `frontend/app/components/`:
  - `HealthScreen.tsx` — startup health check (nas, ollama embed model, llm model, database)
  - `LibraryView.tsx` — infinite-scroll card/list grid with search, filter sidebar, tag autocomplete, and category dropdown; sidebar filters (including "Show Medical" toggle) persisted to `sessionStorage`; shows collapsible "Failed documents" section at top with per-item retry buttons; "Show Medical" toggle hidden by default — sends `exclude_category=Medical` query param when off. This is a privacy/sensitivity default: medical records are kept out of view unless the user explicitly opts in via the toggle
  - `DocumentDetail.tsx` — full metadata editor (category, tags, notes, document date), extracted text panel, download button, delete with confirmation modal; AI-generated title/summary shown when available; mobile-responsive layout with collapsible summary panel
  - `AskView.tsx` — natural language Q&A; streams answer from local LLM with source citations; stores up to 6 recent questions in `localStorage` (`docvault_recent_questions`); shows elapsed time during streaming
  - `TagManagerView.tsx` — tag table (rename inline, delete with confirmation)
  - `AuditView.tsx` — audit dashboard (orphaned DB records, orphaned NAS files, duplicate candidates); cluster-aware duplicate UI (per-cluster selection, dismiss, bulk delete); checkboxes + confirmation modal for deletion; paginated cleanup log (renamed from `VaultHealthView.tsx`)
  - `UploadButton.tsx` — multi-file upload queue (up to 2 concurrent, 20 MB per file); exposes `addFiles()` via `forwardRef` for the global drop handler; expandable panel shows per-file progress, status, and retry; duplicate warning shown inline; dispatches `docvault:document-processed` CustomEvent on job completion (caught by `page.tsx` to refresh library)
  - `fileTypeBadge.ts` — utility for mapping file extension to display badge/icon
  - `categories.ts` — `fetchCategoryNames()` fetches `/categories`; `withSelectedCategory()` ensures a pre-existing value appears in the list even if not in the server response
  - `fileDropUtils.ts` — `getDroppedFiles()`, `flattenEntry()`, `readFileEntry()`, `readDirectoryEntries()` — FileSystem API helpers for recursive folder drag-and-drop; used by `page.tsx` global drop handler

## Backend API endpoints

| Method   | Path                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                           | Returns `{status, checks: {nas, ollama, llm, database}}` — `ollama` checks `nomic-embed-text`, `llm` checks `llama3.1:8b`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST`   | `/upload`                           | Accepts `multipart/form-data` with `file` field; returns `{job_id, document_id}` — also returns `duplicate_warning: <id>` if SHA-256 hash matches an existing document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST`   | `/check-duplicate`                  | Pre-upload duplicate check; body: `form-data` with `file_hash` (SHA-256 hex); returns `{duplicate: bool, document_id?, filename?}` — used by upload queue before sending the file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET`    | `/status/{job_id}`                  | Returns job status: `queued → processing → complete / error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET`    | `/thumbnail/{doc_id}`               | Returns JPEG thumbnail from NAS; 404 if not generated yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST`   | `/search`                           | Body: `{query, category?, tags?, date_from?, date_to?, limit?}`; returns `{results, total, query}` — hybrid semantic (sqlite-vec) + FTS (SQLite BM25) at 0.6/0.4 weighting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET`    | `/documents`                        | Query params: `category`, `tags`, `date_from`, `date_to`, `sort_by`, `sort_dir` (asc/desc), `page`, `page_size`, `exclude_category` (excludes docs with that category); returns `{documents, total, page, page_size}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET`    | `/document/{id}`                    | Full document detail including `extracted_text`, `notes`, `original_ext`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT`    | `/document/{id}`                    | Body: `{category?, notes?, document_date?, tags?}`; updates metadata and replaces tag list; when `category` is present, sets `category_locked=1` so future `generate-title` calls skip recategorization; returns updated document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE` | `/document/{id}`                    | Removes from SQLite (CASCADE on tags), vec_chunks, FTS, and NAS files; returns `{deleted: id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST`   | `/document/{doc_id}/reprocess`      | Requeues a document for processing; returns `{job_id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST`   | `/document/{doc_id}/star`           | Toggles starred status; returns `{id, starred: bool}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`   | `/document/{doc_id}/generate-title` | Generates AI title + summary using the local LLM; also evaluates whether the current category is correct and updates `documents.category` if needed, and produces `suggested_tags` that are merged into the document's existing tag list. Returns `{title, summary, category, recategorized, tags}` — `recategorized: true` when the category was changed; `tags` is the final merged tag list. High-confidence mismatch → regenerates summary with new category framing + `category` updated in DB; low-confidence mismatch → category set to `"Other"`. If `category_locked=1`, skips recategorization and generates title+summary (still merging suggested tags) using the current category as fixed ground truth. |
| `GET`    | `/document/{doc_id}/log`            | Returns processing log entries for a document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`    | `/tags`                             | With `?q=`: prefix autocomplete, returns `{tags: [string]}`. Without `q`: returns `{tags: [{tag, count}]}` sorted by frequency desc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PUT`    | `/tags/{tag}`                       | Body: `{new_name}`. Renames tag across all documents, deduplicating where new name already exists; returns `{updated_count}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DELETE` | `/tags/{tag}`                       | Removes all rows with that tag; returns `{deleted_count}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET`    | `/original/{id}`                    | Streams the original file from NAS as a download                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET`    | `/audio/{doc_id}`                   | Streams audio file (MP3/WAV) from NAS with HTTP range support; 400 if not an audio file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST`   | `/unlock/{doc_id}`                  | Body: `{password}`; unlocks password-protected PDF via pikepdf, overwrites original on NAS, requeues for reprocessing; returns `{job_id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST`   | `/ask`                              | Body: `{question, category?, tags?, date_from?, date_to?}`; returns SSE stream of `{type:"token",text}` events followed by `{type:"done",sources:[...]}` — RAG via sqlite-vec + `llama3.1:8b`; candidates filtered by minimum relevance score `ASK_MIN_SCORE = 0.45` (score = 1/(1+dist)); returns fallback message if no chunks pass threshold                                                                                                                                                                                                                                                                                                                                                                       |
| `POST`   | `/audit/audit`                      | Read-only scan; returns `{orphaned_records, orphaned_files, duplicates, summary}` — `duplicates` is now a list of **cluster objects** (`{anchor, members[], max_similarity, cluster_size}`) rather than pairs; `summary` fields are `duplicate_clusters` (cluster count) and `duplicate_documents` (member count). Greedy clustering: each unclaimed doc becomes an anchor; sqlite-vec cosine sim ≥ 0.97 neighbors are added as members. Exact SHA-256 dupes form their own clusters first. Anchor is always the **earliest `uploaded_at`** doc in the cluster (most likely original).                                                                                                                                |
| `POST`   | `/audit/cleanup`                    | Body: `{actions: [{action, target_id?, target_path?}]}`; executes `delete_orphan_record`, `delete_orphan_file`, `delete_duplicate`; logs each to `audit_log`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST`   | `/audit/dismiss-pair`               | Body: `{doc_id_a, doc_id_b}`; records a near-duplicate pair as dismissed in `dismissed_pairs` table so it won't reappear in future audit scans; returns `{dismissed: true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET`    | `/audit/log`                        | Query params: `page`, `page_size`; returns paginated `audit_log` history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET`    | `/jobs/failed`                      | Returns `{failed_jobs: [{document_id, filename, uploaded_at, error_message}]}` — all documents with `processing_status = 'error'`, each with its latest job error message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET`    | `/jobs/status`                      | Returns `{queued, processing, failed, total_active}` — live job queue counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST`   | `/jobs/reprocess-all`               | Requeues all non-processing documents for reprocessing; returns `{requeued: count}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET`    | `/categories`                       | Returns `{categories: [{id, name, is_default}]}` sorted by name — lists all categories from the `categories` table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST`   | `/admin/factory-reset`              | Destructive: wipes all SQLite tables (including vec_chunks / vec_chunk_meta), and NAS originals/processed files; reinitializes schema and sqlite-vec; returns `{success, message}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`    | `/settings/auto-cleanup`            | Returns `{enabled, interval_seconds}` — whether scheduled orphan auto-cleanup is on (defaults to enabled when the `auto_cleanup_orphans` setting is unset)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PUT`    | `/settings/auto-cleanup`            | Body: `{enabled: bool}`; persists the `auto_cleanup_orphans` flag to the `settings` table; returns `{enabled}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Supported upload extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.txt`, `.csv`, `.docx`, `.xlsx`, `.pptx`, `.mp3`, `.wav`. Frontend upload limit: 20 MB per file.

A single-worker background loop polls the `jobs` table every 5 seconds and processes one job at a time (up to 3 attempts before marking failed).

**Auto-cleanup background loop:** `auto_cleanup_loop()` runs on startup (after a short delay, `AUTO_CLEANUP_STARTUP_DELAY_SECONDS`, default 120 s) then repeats on `AUTO_CLEANUP_INTERVAL_SECONDS` (default daily). Each tick, if the `auto_cleanup_orphans` setting is enabled (default on), `_run_auto_cleanup_sync()` scans `processed/text/` and `processed/thumbnails/` for files whose UUID stem has no matching `documents.id`, deletes them, and logs each removal to `audit_log` with `action="auto_cleanup_orphan"`. **It never touches `originals/`** — orphaned originals remain manual-only via the Audit page. Toggle it from Audit → Scheduled Cleanup (or via `PUT /settings/auto-cleanup`). `AuditView` shows a note under the Orphaned items section when it's on, and that section defaults to collapsed when the orphan count is 0 (expanded when > 0).

**FTS schema note:** The `documents_fts` table must NOT use `content=''` (contentless) — that prevents `document_id` from being retrieved by SELECT. On first boot after the Milestone 2 schema, `_maybe_migrate_fts` auto-drops the old table, recreates it without `content=''`, and backfills all completed documents from their NAS `.txt` files.

**Schema additions (Milestone 4.6):** `documents` table has a `file_hash TEXT` column (SHA-256, indexed) added via `_maybe_migrate_file_hash` on startup — backfills hashes for existing documents whose NAS files are still present. New `vault_health_log` table records every cleanup action (action, target_id, target_path, performed_at).

**Schema additions (Milestone 6):** `documents` table gains `summary TEXT` and `title TEXT` columns (both via startup migration). `vault_health_log` table renamed to `audit_log` via `_maybe_migrate_audit_log` on startup. `documents` table also gains `starred INTEGER DEFAULT 0` via `_maybe_migrate_starred` on startup. `documents` table gains `category_locked BOOLEAN DEFAULT 0` via `_maybe_migrate_category_locked` on startup — set to 1 when a user manually saves a category via `PUT /document/{id}`.

**Milestone 5 backend changes:** sqlite-vec connection is initialized once at startup and reused across all endpoints. HEIC/JPEG/PNG thumbnails now apply `ImageOps.exif_transpose()` to correct EXIF orientation (fixes sideways iPhone portrait photos).

**Milestone 6 backend changes:** Audio file support (MP3/WAV) — stored on NAS, streamed via `/audio/{doc_id}` with HTTP range support, searchable by filename. PDF unlock via `pikepdf` (`/unlock/{doc_id}`). Document reprocess endpoint. Processing log endpoint. Office doc extraction via `python-docx`, `openpyxl`, `python-pptx`.

**Smart recategorization (Phase 4):** `generate-title` endpoint now evaluates the document's current category in a single local LLM call (`_local_generate_title_and_category`) that returns `{title, summary, suggested_category, category_confidence}`. If `suggested_category` differs from the current category and confidence is `"high"`, a second local call regenerates the summary with category-specific framing (see `_CATEGORY_SUMMARY_INSTRUCTIONS` and `_local_recategorize_summary`), and `documents.category` is updated. If confidence is `"low"`, category falls back to `"Other"`. No recategorization occurs if the LLM agrees with the existing category. When `category_locked=1`, title+summary are generated via `_local_generate_title_locked` using the current category as fixed ground truth. Recategorization events are logged to `document_log` with `event_type = "recategorize"`. Both LLM calls also return `suggested_tags` (3–8 lowercase tags); `_merge_suggested_tags` unions them with the document's existing tags (lowercased, stripped, deduped), writes the merged set back to the `tags` table, and logs `event_type = "tags_updated"` when new tags are added. The initial `process_job()` tag extraction (`_METADATA_PROMPT`) is unchanged — `generate-title` augments tags when called explicitly or auto-triggered.

**Post-M7 schema additions:** New `categories` table (`id`, `name UNIQUE`, `is_default`); seeded on first boot with 7 defaults via `_maybe_migrate_categories`. New `audit_dismissed_pairs` table (`doc_id_a`, `doc_id_b`; stored with smaller id first) via `_maybe_migrate_dismissed_pairs` — tracks near-duplicate pairs the user has explicitly dismissed from audit view. New `GET /categories`, `POST /admin/factory-reset`, and `POST /audit/dismiss-pair` endpoints. Frontend `categories.ts` utility (`fetchCategoryNames`, `withSelectedCategory`) used by `LibraryView` dropdown. `SearchView.tsx` removed — search functionality merged into `LibraryView.tsx`.

## Audit page danger-zone actions

Both actions below are triggered from the Audit page.

### Reprocess All

Use this when you want DocVault to rerun processing for the entire library without deleting the documents themselves.

1. Open the Audit page and expand the danger zone.
2. Click **Reprocess All**.
3. Confirm the modal warning that every document will be requeued for OCR, embedding, and indexing.
4. The backend selects every document whose `processing_status` is not already `processing`.
5. Each selected document is marked `queued`.
6. A new job row is inserted for each selected document.
7. The background worker picks jobs up one at a time and reruns extraction, OCR if needed, embeddings, and indexing.
8. Existing extracted text and derived processing outputs are overwritten as documents finish reprocessing.

What it does not do:

1. It does not delete documents.
2. It does not wipe tags, metadata, or categories.
3. It does not interrupt a document that is already actively processing.

### Factory Reset

Use this only when you want to erase the entire vault and return the app to an empty, ready-to-upload state.

1. Open the Audit page and expand the danger zone.
2. Click **Factory Reset**.
3. Read the warning that the action is permanent.
4. Type `RESET` into the confirmation field.
5. Click **Confirm reset**.
6. The backend deletes all rows from `document_log`, `audit_log`, `jobs`, `tags`, and `documents`.
7. The backend drops and recreates the `documents_fts` table to clear the full-text index.
8. The backend deletes all rows from `vec_chunks` and `vec_chunk_meta` to clear the vector index.
9. The backend deletes everything inside the NAS `originals/` and `processed/` directories while keeping the directory structure itself.
10. The NAS folder structure is recreated so new uploads work immediately.
11. The frontend reloads after success and the library comes back empty.

What it does not preserve:

1. Uploaded files.
2. Extracted text and thumbnails.
3. Search embeddings and indexes.
4. Document metadata, tags, jobs, and audit history.

## Key dependencies

| Layer          | Tech                                                                       | Notes                                                                     |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Backend        | FastAPI, Uvicorn, httpx                                                    | httpx used for async Ollama health check                                  |
| Vector store   | sqlite-vec                                                                 | `vec_chunks` / `vec_chunk_meta` tables in the same SQLite DB as metadata  |
| Embeddings     | Ollama `nomic-embed-text`                                                  | must be running at `localhost:11434`; constant `EMBED_MODEL` in `main.py` |
| LLM            | Ollama `llama3.1:8b`                                                       | used for Q&A answer generation; constant `LLM_MODEL` in `main.py`         |
| Metadata / FTS | SQLite + FTS5                                                              | `porter unicode61` tokenizer                                              |
| OCR            | pdf2image, pytesseract, pillow, pillow-heif, opencv-python-headless, numpy | system deps: Poppler + Tesseract                                          |
| Office docs    | python-docx, openpyxl, python-pptx                                         | text extraction for .docx, .xlsx, .pptx                                   |
| PDF unlock     | pikepdf                                                                    | password-protected PDF decryption                                         |
| Frontend       | Next.js 14, React 18, Tailwind 3, Space Grotesk, Radix UI, Tabler icons    |                                                                           |

## External dependencies that must be present

- The storage directory must exist and be writable — `start.sh` exits if not. Set `DOCVAULT_STORAGE_PATH` in `backend/.env` (default: `~/Documents/DocVault`). For a NAS, mount first, then set the path.
- Ollama must be installed and both models must be pulled:

  ```bash
  brew install ollama
  ollama pull nomic-embed-text   # ~270 MB — required for embedding/search
  ollama pull llama3.1:8b       # ~4.7 GB — required for Q&A (Milestone 4.5)
  ollama list                    # verify both appear
  ```

- Poppler must be installed for PDF processing: `brew install poppler`
- Tesseract must be installed for OCR: `brew install tesseract`

## Email ingestion config

Email-to-Vault is now **provider-agnostic IMAP** (no longer Gmail-specific). Configure via env vars in `backend/.env` — see `backend/.env.example` for the full template. Key vars (all optional; ingestion is off until `EMAIL_ADDRESS` + `EMAIL_PASSWORD` are set):

- `EMAIL_ADDRESS`, `EMAIL_PASSWORD` — mailbox credentials DocVault polls
- `IMAP_HOST` (default `imap.gmx.com`), `IMAP_PORT` (default `993`)
- `EMAIL_POLL_INTERVAL_SECONDS` (default `300`)
- `EMAIL_PROCESSED_FOLDER` (default `Archive`), `EMAIL_REJECTED_FOLDER` (default `Junk`) — server-side folders messages are moved to after handling
- `ALLOWED_SENDERS` — comma-separated seed for the allowlist (also editable in Settings UI)
- `EMAIL_INLINE_IMAGE_MIN_BYTES` (default `25000`), `EMAIL_INLINE_IMAGE_MIN_DIM` (default `400`) — gates an inline image (screenshot) must clear when a message has no supported attachment

Messages with no ingestable content are moved to the server's `\Trash` folder (`_find_trash_folder` resolves it via IMAP special-use flag, falling back to `"Trash"`).
