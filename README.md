# DocVault

A locally-hosted personal document management system built from scratch. All OCR, embedding, search, and Q&A runs fully on-device — no document content ever leaves the machine.

## Features

- **Ingest** — PDF, JPG/PNG/HEIC, DOCX/XLSX/PPTX, TXT/CSV, MP3/WAV (≤ 20 MB); drag-and-drop, folder pick, or email attachment forwarding via IMAP (any standard provider)
- **OCR & extraction** — Tesseract for scanned docs and images; pdfplumber for digital PDFs; python-docx / openpyxl / python-pptx for Office files; OpenCV preprocessing pipeline
- **Hybrid search** — 60 % sqlite-vec semantic (`nomic-embed-text` via Ollama) + 40 % SQLite FTS5 BM25; filter by category, tag, and date range
- **Ask** — RAG Q&A streamed from `llama3.1:8b` (Ollama) via SSE with source citations; fully on-device, nothing sent externally
- **AI metadata** — local LLM (Ollama `llama3.1:8b`): auto-generates title, summary, and category on ingest; recategorizes with confidence scoring
- **Duplicate detection** — SHA-256 exact match on upload + greedy cosine similarity clustering (≥ 0.97) for near-duplicate identification
- **Library** — infinite-scroll card/list view; category, tag, and date filters; inline metadata editor; star and notes. Medical documents are hidden by default for privacy — a "Show Medical" toggle keeps sensitive medical records out of view unless explicitly requested
- **Tags** — free-form tagging with autocomplete; bulk rename and merge across documents
- **Vault Health** — audit orphaned records and near-duplicate clusters; Reprocess All and Factory Reset in the danger zone
- **Remote access** — backend binds the Mac's Tailscale IP (not `0.0.0.0`) and CORS is an explicit per-device allowlist, so the vault is reachable only over your tailnet

**Frontend:** Next.js 14 · TypeScript · Tailwind CSS · React 18 · Radix UI  
**Backend:** Python 3.11 · FastAPI · Uvicorn · SQLite · sqlite-vec

---

## Prerequisites

Install these once before the first run:

```bash
# Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 20+
brew install node

# Python 3.11+
brew install python@3.11

# Tesseract OCR engine
brew install tesseract

# Poppler — required for PDF rendering
brew install poppler

# Ollama — local model runner
brew install ollama

# Pull the two required models (one-time, ~2.3 GB total)
ollama pull nomic-embed-text   # ~270 MB — embeddings and search
ollama pull llama3.2           # ~2 GB   — Q&A (Ask tab)
```

DocVault stores raw files and extracted text at `~/Documents/DocVault` by default. To use a NAS, external drive, or any other path, set `DOCVAULT_STORAGE_PATH` in `backend/.env`:

```env
DOCVAULT_STORAGE_PATH=/Volumes/RAID/docvault
```

The directory must already exist before starting — DocVault will not create it automatically.

---

## Installation

```bash
git clone <repo-url>
cd docvault

# Backend — create virtualenv and install Python deps
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..

# Frontend — install Node deps
cd frontend
npm install
cd ..
```

---

## Configuration

Create (or edit) `backend/.env` with any optional settings:

```env
# Storage path for raw files and extracted text (default: ~/Documents/DocVault)
# DOCVAULT_STORAGE_PATH=/Volumes/RAID/docvault
```

The file is gitignored. The app works without it.

### Email ingestion (optional)

DocVault can poll an IMAP mailbox and automatically ingest documents from whitelisted senders. Any standard IMAP provider works (Namecheap/cPanel hosting, GMX, etc.).

There are exactly two ways a message produces a document:

1. **Forward an email with an attachment** — the supported attachment is ingested as a document.
2. **Email or forward a screenshot** — an inline image (e.g. a phone screenshot of a receipt or document) is ingested when it clears the size/dimension thresholds described below.

Anything that produces neither a supported attachment nor a qualifying inline image is moved to Trash.

Add these to `backend/.env`:

```env
# Required — IMAP mailbox DocVault polls for incoming attachments
EMAIL_ADDRESS=docvault@yourdomain.com
EMAIL_PASSWORD=your-mailbox-password
IMAP_HOST=your-imap-host        # e.g. server263.web-hosting.com or imap.gmx.com
IMAP_PORT=993                   # SSL/TLS port (993 is standard)
EMAIL_POLL_INTERVAL_SECONDS=300 # How often to check (default: every 5 minutes)

# Folder destinations for processed and rejected messages (must exist on the server)
EMAIL_PROCESSED_FOLDER=Archive  # default: Archive
EMAIL_REJECTED_FOLDER=Junk      # default: Junk

# Seed the allowed-senders list on first startup (comma-separated)
# Can also be managed in the Settings UI after startup
ALLOWED_SENDERS=you@example.com,other@example.com

# Inline-image (screenshot) gates — control which inline images count as real
# documents vs. signature logos / tracking pixels. An inline image is ingested
# only when it clears BOTH thresholds.
EMAIL_INLINE_IMAGE_MIN_BYTES=25000  # minimum file size in bytes (default: 25000)
EMAIL_INLINE_IMAGE_MIN_DIM=400      # minimum width AND height in px (default: 400)
```

**Provider notes:**

- **Namecheap/cPanel hosting** — IMAP is included with hosting plans. Find your IMAP host in cPanel under _Email Accounts → Connect Devices_. Use the server hostname shown there (e.g. `server263.web-hosting.com`).
- **GMX (gmx.com)** — Free, no OAuth required. Enable IMAP under _Settings → POP3 & IMAP_ in the GMX web interface before connecting. Use `imap.gmx.com`.
- **Gmail personal** — App passwords still work on personal (non-Workspace) accounts with 2FA enabled. Generate one at _Google Account → Security → App passwords_. Use `imap.gmail.com`. Note: Google Workspace accounts require OAuth and are not supported. Gmail uses a label system rather than standard IMAP folders, so processed messages may not move out of the inbox cleanly — they will be marked read instead. Re-ingestion is still prevented because DocVault marks messages as read after processing and only polls for unread messages regardless.

**How it works:** DocVault polls the INBOX on the configured interval and checks the sender against the allowed list. For each accepted message it ingests any supported attachment; if there is none, it rescues a qualifying inline image (a screenshot that clears `EMAIL_INLINE_IMAGE_MIN_BYTES` and `EMAIL_INLINE_IMAGE_MIN_DIM`). Either way the document runs through the normal OCR/embed/index pipeline. Messages that yield neither an attachment nor a qualifying inline image are moved to Trash. Processed messages are moved to `EMAIL_PROCESSED_FOLDER`; rejected senders are moved to `EMAIL_REJECTED_FOLDER`. The allowed-senders list can be managed in the Settings tab without restarting.

**Inline-image (screenshot) gates:** Forwarded phone screenshots are usually embedded inline rather than as real attachments. To avoid ingesting signature logos and tracking pixels, an inline image is only ingested when it is at least `EMAIL_INLINE_IMAGE_MIN_BYTES` (default 25000) in size **and** at least `EMAIL_INLINE_IMAGE_MIN_DIM` (default 400) px in both width and height. Everything happens locally — no network calls are made anywhere in the email path.

---

## Running

```bash
# Start both services and open the browser
./start.sh

# Stop both services
./stop.sh
```

`start.sh` will:

1. Verify the storage directory exists (reads `DOCVAULT_STORAGE_PATH` from `backend/.env`, falls back to `~/Documents/DocVault`)
2. Start Ollama if it isn't running
3. Warn if either model is missing
4. Start the FastAPI backend on `http://localhost:8777`
5. Start the Next.js frontend on `http://localhost:3777`
6. Open the app in your browser

Logs go to `/tmp/docvault-backend.log` and `/tmp/docvault-frontend.log`.

### Running services individually

```bash
# Backend only
cd backend
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8777 --reload

# Frontend only
cd frontend
npm run dev          # runs on :3777
```

---

## Network & Tailscale Configuration

DocVault is locked to your [Tailscale](https://tailscale.com/) network. Two independent mechanisms enforce this — where the server listens, and who is allowed to call it.

**The backend binds to the Mac's Tailscale IP, not `0.0.0.0`.** `start.sh` runs `uvicorn` with `--host 100.82.222.43` (mac-mini's Tailscale IP). Because it only listens on the Tailscale interface, the backend is unreachable on the local LAN or the open internet — only devices on your tailnet can connect. The phone (iphone-15) can reach it from any physical network — home WiFi, LTE, or roaming abroad — because Tailscale IPs are stable regardless of the underlying network.

**CORS is an explicit allowlist, not a wildcard.** `backend/main.py` lists each permitted origin by exact Tailscale IP rather than matching `100.x.x.x` or `*.ts.net` by pattern. This means an unknown device that somehow joins the tailnet still cannot make browser requests until its origin is added by hand.

### Adding a new device to the tailnet

When you add a device that needs to use DocVault:

1. Find its Tailscale IP at <https://login.tailscale.com/admin/machines>.
2. Add its origin (e.g. `http://100.x.x.x:3777`) to the `allow_origins` list in `backend/main.py`.
3. Restart the backend.

The `uvicorn --host` in `start.sh` does **not** need to change — that only controls where the server listens (always the Mac's own Tailscale IP), not which clients are allowed to call it. Only the CORS allowlist governs who can connect.

### Current device inventory

| Device    | Role        | Tailscale IP    |
| --------- | ----------- | --------------- |
| mac-mini  | Server host | 100.82.222.43   |
| iphone-15 | Client      | 100.81.181.8    |

---

## Storage layout

```text
$DOCVAULT_STORAGE_PATH/        # default: ~/Documents/DocVault
  originals/                   # raw uploaded files
  processed/                   # extracted text (.txt) and thumbnails (.jpg)

~/Library/Application Support/docvault/db/
  metadata.sqlite              # document metadata, tags, jobs, FTS index, vec_chunks
```

The storage path is set via `DOCVAULT_STORAGE_PATH` in `backend/.env` and defaults to `~/Documents/DocVault`. Point it at a NAS or external drive to keep large files off your local disk — search and metadata stay on your SSD regardless.

---

## Supported file types

| Type        | Notes                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| PDF         | Native text extraction via pdfplumber; falls back to Tesseract OCR for scanned PDFs |
| JPG / PNG   | Tesseract OCR with structure-aware bounding-box extraction                          |
| HEIC / HEIF | iPhone photo format; converted to JPEG internally before OCR                        |
| TXT         | Read directly as UTF-8; text extraction                                             |
| CSV         | Parsed into tab-separated rows preserving column alignment; text extraction         |
| DOCX        | Paragraph and table text via python-docx; text extraction                           |
| XLSX        | All sheets with tab-separated cell values via openpyxl; text extraction             |
| PPTX        | Per-slide text frames via python-pptx; text extraction                              |
| MP3 / WAV   | Audio files; stored and indexed but not transcribed in current version              |

---

## Development

```bash
# Frontend type check + production build
cd frontend && npm run build

# Frontend lint
cd frontend && npm run lint

# Backend — add a dependency
cd backend && source .venv/bin/activate
pip install <package> && pip freeze > requirements.txt
```

Full architecture detail, database schema, API endpoints, and color tokens are in [`TECH_SPEC.md`](TECH_SPEC.md).

---

## Troubleshooting

**App shows a red health check for NAS**  
The USB drive isn't mounted. Plug it in — the health screen retries automatically.

**App shows a red health check for Ollama**  
Run `ollama serve` in a terminal, or install Ollama via `brew install ollama`.

**"Ask" tab is greyed out**  
The llama3.2 model isn't pulled. Run `ollama pull llama3.2` (~2 GB download).

**Backend won't start**  
Check `/tmp/docvault-backend.log`. Common cause: Python virtualenv not set up (`cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`).

**Document stuck in "processing" forever**  
Check for a failed job in the Library view — a red "Failed documents" section appears at the top. Click Retry to requeue it. Logs in `/tmp/docvault-backend.log` will show the error.

---

## Health Check Reference

The `/health` endpoint returns a JSON object describing the status of all system
dependencies. You can check it any time at `http://localhost:8777/health`.

### Example response

```json
{
  "status": "pass",
  "checks": {
    "nas": "green",
    "ollama": "green",
    "llm": "green",
    "embedding_quality": "green",
    "database": "green"
  },
  "embedding_quality_score": 0.4711,
  "embedding_gap": 0
}
```

### Field reference

**`status`** — Overall health. `pass` means all critical dependencies are reachable
and the app is functional.

**`checks`**

| Check               | What it verifies                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `nas`               | The USB NAS drive is mounted and writable at `/Volumes/RAID/`. If red, uploads and file reads will fail. |
| `ollama`            | The Ollama service is running and reachable at `localhost:11434`. Required for embeddings and the LLM.   |
| `llm`               | The `llama3.2` model is pulled and available in Ollama. Required for the Ask feature.                    |
| `embedding_quality` | Spot-check that `nomic-embed-text` is producing real, varied vectors. If red, restart Ollama.            |
| `database`          | SQLite is accessible and all schema migrations have run.                                                 |

**`embedding_quality_score`** — A value between 0 and 1 measuring how distinct
embeddings are from each other. Higher means more varied (better). Anything above
~0.3 is healthy. A score near 1.0 indicates degenerate identical vectors (bad).
A typical healthy value is 0.40–0.55.

**`embedding_gap`** — Count of documents marked `complete` in SQLite that have no
vectors in `vec_chunks`. Any value above 0 means those documents are invisible to the Ask
feature. Should be 0 at steady state. If non-zero, go to Audit → Reprocess All to
recover.
