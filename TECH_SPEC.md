# DocVault — Technical Specification

**Version:** 1.0  
**Date:** June 2026  
**Owner:** Billy

---

## Overview

DocVault is a locally-hosted personal document management system running on a home Mac desktop. It provides OCR-based ingestion, semantic + full-text search, and tag/category organization for personal and family documents (medical, insurance, legal, financial, vehicle, home, etc.).

All processing happens on-device. No document content is transmitted to external services.

---

## System Architecture

Two long-running processes on the Mac, launched via a single startup script:

| Service            | Tech                 | Port             |
| ------------------ | -------------------- | ---------------- |
| Frontend + API     | Next.js (TypeScript) | `localhost:3000` |
| Processing backend | Python (FastAPI)     | `localhost:8000` |

The Next.js app communicates with the Python service via local HTTP. The Python service handles all heavy lifting: OCR, embedding generation, indexing, and search.

---

## Storage Layout

### NAS (USB-mounted, `/Volumes/NAS/`)

```
/Volumes/NAS/docvault/
  originals/          # raw uploaded files (PDF, JPG, PNG, HEIC)
  processed/          # extracted text (.txt), thumbnails (.jpg)
```

### Mac local SSD (`~/Library/Application Support/docvault/`)

```
db/
  metadata.sqlite     # document metadata, tags, categories, job queue, vec_chunks
```

Indexes and embeddings stay on the fast local SSD. The NAS holds only raw files and extracted text, so a NAS slowdown doesn't degrade search performance.

> **Startup check:** On launch, both services verify `/Volumes/NAS/docvault/` is mounted and writable. If not, they surface a clear error rather than silently failing.

---

## Backend — Python (FastAPI)

### Responsibilities

- Receive file uploads from Next.js
- OCR via `pytesseract` + `pdf2image` (PDFs) and `Pillow` (images including HEIC)
- Generate text embeddings via Ollama (`nomic-embed-text`)
- Store vectors in sqlite-vec (`vec_chunks` / `vec_chunk_meta` tables), metadata in SQLite
- Serve hybrid search queries
- Manage background job queue for async processing

### API Endpoints

```
POST   /upload                    Accept file upload, queue for processing, return job ID
GET    /status/{job_id}           Return processing status: queued | processing | complete | error
POST   /search                    Hybrid natural language + filter query, return ranked results
POST   /ask                       RAG-based Q&A — question answered from document context via local LLM, returns answer + source citations
GET    /documents                 Paginated document list with optional tag/category/date filters
GET    /document/{id}             Full document detail: metadata, extracted text, tags
PUT    /document/{id}             Update tags, category, notes
DELETE /document/{id}             Remove document, embeddings, and file from NAS
POST   /document/{id}/reprocess   Reset document status to queued and re-enqueue for OCR processing; used to re-extract after pipeline improvements
GET    /health                    Mount check + service status (used by frontend on load)
```

### OCR Pipeline

1. File arrives at `/upload`
2. Metadata row inserted into SQLite with `status = queued`
3. Background worker picks up job:
   - **PDF (two-stage):**
     1. `pdfplumber` is attempted first. For each page, `extract_tables()` is called and formatted as tab-delimited rows; `extract_text()` captures non-table prose. If the combined result is ≥ 100 characters the extracted text is used as-is.
     2. If `pdfplumber` yields fewer than 100 characters (indicating a scanned or image-only PDF), falls back to `pdf2image` to render pages as images, then runs the bounding-box OCR helper (step 3a) via `pytesseract` on each page.
   - **JPG/PNG:** run OCR directly
   - **HEIC:** convert to JPEG via `pillow-heif`, then run OCR
   - All three paths use the same OCR helper described in step 3a below
     3a. OCR helper — structure-aware extraction (applied to every image regardless of input type):
   - Preprocess image via `preprocess_document_image`: perspective-correct (Canny edge detection → 4-point contour → `cv2.warpPerspective`), upscale to ≥ 2400 px on shortest side (`cv2.INTER_CUBIC`), and binarise with Gaussian adaptive threshold (`cv2.adaptiveThreshold`). Requires `opencv-python-headless` + `numpy`.
   - Call `pytesseract.image_to_data(image, output_type=Output.DICT)` to get per-word bounding boxes and confidence scores
   - Reconstruct rows: group words by vertical center (`top + height / 2`), using a ~10 px tolerance to merge words on the same line
   - Within each row, sort words left-to-right by `left` coordinate and join with tab characters to preserve column alignment
   - Fallback: if the result has low average confidence or too few tokens, re-run with `pytesseract.image_to_string()` and use that output instead
4. Extracted text saved to `/Volumes/NAS/docvault/processed/{id}.txt`
5. Thumbnail generated and saved to `/Volumes/NAS/docvault/processed/{id}_thumb.jpg`
6. Text chunked (512 tokens, 64-token overlap) and embedded via Ollama
7. Vectors stored in sqlite-vec (`vec_chunks` / `vec_chunk_meta`) with document ID metadata
8. SQLite row updated: `status = complete`

### Embedding + Vector Store

- **Model:** `nomic-embed-text` via Ollama (runs at `localhost:11434`)
- **Vector DB:** sqlite-vec; vectors stored in `vec_chunks` / `vec_chunk_meta` tables in the same SQLite DB as document metadata
- **Chunking:** 512-token chunks with 64-token overlap to preserve context across chunk boundaries
- **Batch processing:** Worker processes one job at a time, no parallelism needed at this volume

### Search — Hybrid

Queries run against both engines and results are merged:

1. **Semantic search** — query is embedded, sqlite-vec returns top-20 chunks by cosine similarity
2. **Full-text search** — SQLite FTS5 index on extracted text returns keyword matches
3. **Merge + re-rank** — deduplicate by document ID, combine scores (0.6 × semantic + 0.4 × FTS), return top results with source excerpt

Filters (tag, category, date range) are applied as pre-filters before search and as post-filters on merged results.

### Q&A / RAG

The `/ask` endpoint answers natural language questions using a Retrieval-Augmented Generation (RAG) pipeline running entirely on-device:

1. **Embed the question** — query is embedded using `nomic-embed-text` via Ollama
2. **Retrieve chunks** — sqlite-vec returns the top-10 most similar document chunks by cosine similarity; optional filters (category, tags, date range) narrow the candidate set before retrieval
3. **Confidence gate** — if no chunk exceeds a minimum similarity threshold, the endpoint returns a graceful "not enough information in your documents" message without invoking the LLM
4. **Build context prompt** — retrieved chunks are assembled with source metadata (filename, category, document date) into a structured prompt that instructs the model to answer only from the provided context
5. **Stream LLM response** — `llama3.2` via Ollama generates the answer; the response is streamed back to the client via server-sent events
6. **Return sources** — alongside the streamed answer, the response payload includes a list of source documents (id, filename, category, excerpt) for citation rendering in the frontend

**Model choice — `llama3.2`:** Good balance of quality and speed for a local 3B model; fits comfortably in RAM on typical Mac hardware. The model must be pulled once before the Q&A feature is usable:

```bash
ollama pull llama3.2
```

`start.sh` checks for `llama3.2` availability alongside `nomic-embed-text` and warns at startup if either is missing. The `/health` endpoint reports embedding model and LLM model availability as separate checks.

### Background Job Queue

SQLite-backed queue (no external dependencies):

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  status TEXT DEFAULT 'queued',   -- queued | processing | complete | error
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- Worker polls every 5 seconds
- Max 3 retry attempts on error before marking failed
- Failed jobs surface in the UI with an error state and manual retry button

---

## Frontend — Next.js (TypeScript + Tailwind)

### Views

**Upload (`/upload`)**

- Drag-and-drop zone, multi-file support
- Accepts: PDF, JPG, JPEG, PNG, HEIC, HEIF, TXT, CSV, DOCX, XLSX, PPTX, MP3, WAV
- Frontend upload limit: 20 MB per file
- Shows live processing queue with status indicators (queued / processing / complete / error)
- Optional: pre-fill tags and category before upload

**Library (`/`)**

- Card grid or list toggle
- Filter sidebar: category (enum), tags (multi-select), date range
- Sort: date uploaded, document date, filename
- Each card: thumbnail, filename, category badge, tags, processing status

**Search (`/search`)**

- Natural language input field
- Optional filter chips (category, tags, date)
- Results ranked by relevance with highlighted excerpt showing matched context
- Click result → document detail

**Document Detail (`/document/[id]`)**

- Rendered preview (PDF viewer or image)
- Extracted text panel (collapsible)
- Editable metadata: tags, category, notes, document date
- Download original button
- Delete button (with confirmation)

### Tagging System

| Field           | Type     | Notes                                                      |
| --------------- | -------- | ---------------------------------------------------------- |
| `category`      | Enum     | Medical, Insurance, Financial, Legal, Vehicle, Home, Other |
| `tags`          | String[] | Free-form, e.g. `honda`, `billy`, `2024`, `EOB`            |
| `notes`         | String   | Freeform notes field per document                          |
| `document_date` | Date     | The date on the document (separate from upload date)       |

Tags are stored in SQLite and surfaced as autocomplete suggestions based on existing tags.

### Color Scheme

All colors are defined as custom Tailwind tokens under the `vault` namespace in `tailwind.config.ts`.

#### Surfaces (dark-to-light layers)

| Token            | Hex       | Usage                               |
| ---------------- | --------- | ----------------------------------- |
| `vault-bg`       | `#111318` | Page background                     |
| `vault-surface`  | `#1C2030` | Cards, panels, dropdowns            |
| `vault-elevated` | `#242838` | Raised elements, progress bar track |
| `vault-input`    | `#2A2F42` | Input fields, text areas            |

#### Borders

| Token                | Value     | Usage                   |
| -------------------- | --------- | ----------------------- |
| `vault-border`       | `#2E3448` | Default borders         |
| `vault-border-hover` | `#3A4055` | Hovered/focused borders |

#### Teal accent (primary action color)

| Token               | Value                  | Usage                                                 |
| ------------------- | ---------------------- | ----------------------------------------------------- |
| `vault-teal`        | `#00D4AA`              | Primary buttons, links, active states                 |
| `vault-teal-hover`  | `#00B894`              | Hover state for teal elements                         |
| `vault-teal-bg`     | `rgba(0,212,170,0.07)` | Subtle teal fill (e.g. idle upload button background) |
| `vault-teal-border` | `rgba(0,212,170,0.25)` | Teal-tinted borders                                   |

#### Danger

| Token                  | Hex       | Usage                             |
| ---------------------- | --------- | --------------------------------- |
| `vault-danger`         | `#E53E3E` | Destructive actions, error states |
| `vault-danger-surface` | `#2D2030` | Background tint for danger zones  |

#### Text

| Token                | Hex       | Usage                                            |
| -------------------- | --------- | ------------------------------------------------ |
| `vault-text-primary` | `#E2E8F0` | Body text, active labels                         |
| `vault-text-muted`   | `#8A93A8` | Secondary text, placeholders, inactive nav items |

---

## Database Schema (SQLite)

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_path TEXT NOT NULL,       -- path on NAS
  processed_text_path TEXT,          -- path on NAS
  thumbnail_path TEXT,               -- path on NAS
  category TEXT,
  notes TEXT,
  document_date DATE,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processing_status TEXT DEFAULT 'queued'
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  tag TEXT NOT NULL
);

CREATE INDEX idx_tags_tag ON tags(tag);
CREATE INDEX idx_tags_document ON tags(document_id);

-- Full-text search index
CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  extracted_text,
  content='',
  tokenize='porter unicode61'
);
```

---

## Ollama Setup

```bash
# Install Ollama
brew install ollama

# Pull embedding model (~274MB, one-time)
ollama pull nomic-embed-text

# Ollama runs as a background service automatically after install
```

Ollama binds to `localhost:11434` by default. The Python service calls it at this address. No configuration needed beyond the initial pull.

---

## Startup Script

A single shell script (`start.sh`) at the project root:

1. Check `/Volumes/NAS/docvault/` is mounted
2. Start Ollama (if not already running)
3. Start Python FastAPI service (`uvicorn main:app --port 8000`)
4. Start Next.js dev server or production build (`next start --port 3000`)
5. Open `http://localhost:3000` in the default browser

A companion `stop.sh` gracefully shuts down both services.

---

## Authentication (Phase 1 — local only)

A single hardcoded password stored in a `.env` file protects the app. The Next.js middleware checks for a session cookie on every request. Simple and sufficient for localhost-only access.

---

## Security Considerations

- No document content is ever sent to an external API
- Ollama and sqlite-vec run fully offline
- `.env` file (containing the app password) is gitignored
- The NAS mount path is local USB — no network exposure
- In Phase 2, Tailscale provides encrypted remote access without opening any ports

---

## Tech Stack Summary

| Layer          | Technology                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend       | Next.js 14, TypeScript, Tailwind CSS                                                                                                                                                                                                                                |
| Backend        | Python 3.11+, FastAPI, Uvicorn                                                                                                                                                                                                                                      |
| OCR            | Tesseract (`pytesseract`), `pdf2image`, `Pillow`, `pillow-heif`, `pdfplumber` (native text/table extraction for PDFs with embedded text layers), `opencv-python-headless` + `numpy` (image preprocessing: perspective correction, upscaling, adaptive thresholding) |
| Embeddings     | Ollama + `nomic-embed-text`                                                                                                                                                                                                                                         |
| Vector store   | sqlite-vec (`vec_chunks` / `vec_chunk_meta` in the same SQLite DB)                                                                                                                                                                                                  |
| Metadata / FTS | SQLite + FTS5                                                                                                                                                                                                                                                       |
| File storage   | NAS via USB mount (`/Volumes/NAS/`)                                                                                                                                                                                                                                 |
| Remote access  | Tailscale (Phase 2)                                                                                                                                                                                                                                                 |
