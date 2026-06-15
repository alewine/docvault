"""Search + Q&A endpoints.

The final router in the decomposition. Two single-word top-level routes
(/search, /ask) with no shared structure to factor, so — like every other
router in this package — NO prefix is used and the path decorators are kept
byte-identical to their old `@app.*` forms.

Mutable/patched dependencies are referenced via attribute access on their
owning modules so conftest monkeypatches flow through at call time:
  - db.DB_PATH              (conftest patches db.DB_PATH)
  - db._vec_conn            (resolves DB_PATH in db's own globals)
  - db._tags_for_documents  (moved to db.py in step 8c)
  - embeddings._normalize
  - embeddings._fetch_vec_chunk
  - config._executor
  - config.OLLAMA_URL / config.EMBED_MODEL / config.LLM_MODEL

`httpx` is imported here directly; the test suite patches it as
`main.httpx.post` / `main.httpx.AsyncClient`, but httpx is a single shared
module object, so those patches land on the same `httpx` this module sees.

`_search_sync`, `_ask_stream`, and `_sanitize_fts` are search-specific and
live here; the endpoints resolve them in this module's namespace.
`_sanitize_fts` is re-exported into main's globals for test compatibility
(tests reach it as `main._sanitize_fts`). This module must never import main.
"""
import asyncio
import json
import re
import sqlite3
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config
import db
import embeddings

router = APIRouter(tags=["search"])


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    limit: int = 20


@router.post("/search")
async def search(req: SearchRequest):
    if not req.query.strip():
        return {"results": [], "total": 0, "query": req.query}
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(config._executor, _search_sync, req)


def _embed_search_query(query: str):
    """Embed the query via Ollama; returns the normalized vector or None on failure."""
    try:
        resp = httpx.post(
            f"{config.OLLAMA_URL}/api/embeddings",
            json={"model": config.EMBED_MODEL, "prompt": query},
            timeout=30.0,
        )
        resp.raise_for_status()
        return embeddings._normalize(resp.json()["embedding"])
    except Exception as e:
        print(f"Search: embedding failed: {e}")
        return None


def _semantic_search(query_embedding) -> tuple[dict, dict]:
    """sqlite-vec top-20 search. Returns (semantic_scores, semantic_excerpts) keyed by doc_id."""
    semantic_scores: dict[str, float] = {}
    semantic_excerpts: dict[str, str] = {}
    if query_embedding is None:
        return semantic_scores, semantic_excerpts
    try:
        import sqlite_vec as _sv
        vc = db._vec_conn()
        try:
            rows = vc.execute(
                """
                SELECT m.document_id, m.chunk_text, distance
                FROM vec_chunks v
                JOIN vec_chunk_meta m ON m.rowid = v.rowid
                WHERE v.embedding MATCH ? AND k = 20
                ORDER BY distance
                """,
                (_sv.serialize_float32(query_embedding),),
            ).fetchall()
        finally:
            vc.close()
        for doc_id, chunk_text, distance in rows:
            score = 1.0 / (1.0 + distance)
            if doc_id not in semantic_scores or score > semantic_scores[doc_id]:
                semantic_scores[doc_id] = score
                semantic_excerpts[doc_id] = chunk_text
    except Exception as e:
        print(f"Search: sqlite-vec query failed: {e}")
    return semantic_scores, semantic_excerpts


def _fts_search(query: str) -> dict:
    """FTS5 BM25 search (top-20), normalized to [0, 1]. Returns fts_scores keyed by doc_id."""
    fts_scores: dict[str, float] = {}
    with db.connection() as conn:
        fts_rows: list = []
        for fts_query in (f'"{query}"', _sanitize_fts(query)):
            if not fts_query:
                continue
            try:
                fts_rows = conn.execute(
                    "SELECT document_id, bm25(documents_fts) FROM documents_fts"
                    " WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 20",
                    (fts_query,),
                ).fetchall()
                if fts_rows:
                    break
            except sqlite3.OperationalError:
                pass

    # Normalize BM25 to [0, 1] (more-negative = better match)
    if fts_rows:
        min_score = min(r[1] for r in fts_rows)
        for doc_id, raw in fts_rows:
            if doc_id:
                fts_scores[doc_id] = raw / min_score if min_score != 0 else 1.0
    return fts_scores


def _rank_search_results(semantic_scores: dict, fts_scores: dict) -> list:
    """Merge and re-rank (0.6 semantic + 0.4 FTS); drop docs below the 0.1 floor."""
    all_ids = set(semantic_scores) | set(fts_scores)
    return [
        d for d in sorted(
            all_ids,
            key=lambda d: 0.6 * semantic_scores.get(d, 0.0) + 0.4 * fts_scores.get(d, 0.0),
            reverse=True,
        )
        if 0.6 * semantic_scores.get(d, 0.0) + 0.4 * fts_scores.get(d, 0.0) >= 0.1
    ]


def _passes_search_filters(req, category, document_date, doc_tags) -> bool:
    """Shared category/date/tags predicate for search results. False => skip."""
    if req.category and category != req.category:
        return False
    if req.date_from and document_date and document_date < req.date_from:
        return False
    if req.date_to and document_date and document_date > req.date_to:
        return False
    if req.tags and not all(t in doc_tags for t in req.tags):
        return False
    return True


def _build_search_results(req, ranked, semantic_scores, semantic_excerpts, fts_scores) -> list:
    """Fetch metadata for ranked doc_ids, apply filters, and build the result dicts."""
    with db.connection() as conn:
        tags_by_doc = db._tags_for_documents(conn, ranked)
        results = []
        for doc_id in ranked:
            row = conn.execute(
                "SELECT filename, category, document_date, uploaded_at,"
                " thumbnail_path, processed_text_path, summary, title"
                " FROM documents WHERE id=? AND processing_status='complete'",
                (doc_id,),
            ).fetchone()
            if not row:
                continue

            filename, category, document_date, uploaded_at, thumbnail_path, text_path, summary, title = row

            doc_tags = tags_by_doc.get(doc_id, [])

            if not _passes_search_filters(req, category, document_date, doc_tags):
                continue

            excerpt = semantic_excerpts.get(doc_id, "")
            if not excerpt and text_path:
                try:
                    excerpt = Path(text_path).read_text(encoding="utf-8")[:500]
                except Exception:
                    pass

            sem = semantic_scores.get(doc_id, 0.0)
            fts = fts_scores.get(doc_id, 0.0)

            results.append({
                "document_id": doc_id,
                "filename": filename,
                "title": title or None,
                "category": category,
                "tags": doc_tags,
                "document_date": document_date,
                "uploaded_at": uploaded_at,
                "summary": summary or None,
                "excerpt": excerpt[:500],
                "score": round(0.6 * sem + 0.4 * fts, 4),
                "has_thumbnail": bool(thumbnail_path and Path(thumbnail_path).exists()),
            })
    return results


def _audio_filename_results(req, query, existing_ids) -> list:
    """Audio filename search — audio files are excluded from sqlite-vec/FTS."""
    results = []
    with db.connection() as conn:
        pattern = f"%{query}%"
        audio_rows = conn.execute(
            "SELECT id, filename, category, document_date, uploaded_at, summary, title"
            " FROM documents"
            " WHERE processing_status='complete'"
            " AND LOWER(filename) LIKE LOWER(?)"
            " AND (original_path LIKE '%.mp3' OR original_path LIKE '%.wav')"
            " LIMIT 20",
            (pattern,),
        ).fetchall()
        audio_tags_by_doc = db._tags_for_documents(conn, [r[0] for r in audio_rows])
        for a_id, a_filename, a_category, a_date, a_uploaded, a_summary, a_title in audio_rows:
            if a_id in existing_ids:
                continue
            a_tags = audio_tags_by_doc.get(a_id, [])
            if not _passes_search_filters(req, a_category, a_date, a_tags):
                continue
            results.append({
                "document_id": a_id,
                "filename": a_filename,
                "title": a_title or None,
                "category": a_category,
                "tags": a_tags,
                "document_date": a_date,
                "uploaded_at": a_uploaded,
                "summary": a_summary or None,
                "excerpt": "",
                "score": 0.0,
                "has_thumbnail": False,
                "match_type": "filename",
            })
    return results


def _search_sync(req: SearchRequest) -> dict:
    query = req.query.strip()

    query_embedding = _embed_search_query(query)
    semantic_scores, semantic_excerpts = _semantic_search(query_embedding)
    fts_scores = _fts_search(query)
    ranked = _rank_search_results(semantic_scores, fts_scores)

    results = _build_search_results(req, ranked, semantic_scores, semantic_excerpts, fts_scores)

    existing_ids = {r["document_id"] for r in results}
    results.extend(_audio_filename_results(req, query, existing_ids))

    return {"results": results[: req.limit], "total": len(results), "query": query}


def _sanitize_fts(query: str) -> str:
    tokens = [re.sub(r"[^\w]", "", w) for w in query.split()]
    return " ".join(t for t in tokens if t)


# ---------------------------------------------------------------------------
# Document Q&A
# ---------------------------------------------------------------------------

class AskRequest(BaseModel):
    question: str
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None


@router.post("/ask")
async def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty")
    return StreamingResponse(
        _ask_stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: dict) -> str:
    """Format an event dict as an SSE `data:` line. Byte format is load-bearing."""
    return f"data: {json.dumps(event)}\n\n"


async def _embed_question(question: str):
    """Embed the question via Ollama (async). Returns the normalized vector; raises on failure.

    Async sibling of the sync `_embed_search_query` used by `_search_sync` — kept
    separate (AsyncClient vs httpx.post); do NOT consolidate the two.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{config.OLLAMA_URL}/api/embeddings",
            json={"model": config.EMBED_MODEL, "prompt": question},
        )
        resp.raise_for_status()
        return embeddings._normalize(resp.json()["embedding"])


def _vec_query_ask(q_embedding) -> list:
    """sqlite-vec top-10 chunk search for Q&A. Returns (document_id, chunk_text, distance) rows."""
    import sqlite_vec as _sv
    vc = db._vec_conn()
    try:
        rows = vc.execute(
            """
            SELECT m.document_id, m.chunk_text, distance
            FROM vec_chunks v
            JOIN vec_chunk_meta m ON m.rowid = v.rowid
            WHERE v.embedding MATCH ? AND k = 10
            ORDER BY distance
            """,
            (_sv.serialize_float32(q_embedding),),
        ).fetchall()
        return rows  # list of (document_id, chunk_text, distance)
    finally:
        vc.close()


def _fts_query_ask(question: str) -> list:
    """FTS5 BM25 top-10 search for Q&A. Returns (document_id, bm25) rows, or [] on no match."""
    with db.connection() as fts_conn:
        for fts_q in (f'"{question}"', _sanitize_fts(question)):
            if not fts_q:
                continue
            try:
                rows = fts_conn.execute(
                    "SELECT document_id, bm25(documents_fts) FROM documents_fts"
                    " WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 10",
                    (fts_q,),
                ).fetchall()
                if rows:
                    return rows
            except sqlite3.OperationalError:
                pass
        return []


async def _gather_ask_context(q_embedding, question: str) -> tuple[list, list]:
    """Run the sqlite-vec and FTS lookups in parallel. Returns (vec_rows, fts_rows); raises on failure."""
    loop = asyncio.get_running_loop()
    return await asyncio.gather(
        loop.run_in_executor(config._executor, _vec_query_ask, q_embedding),
        loop.run_in_executor(config._executor, _fts_query_ask, question),
    )


def _semantic_best_chunks(vec_rows) -> dict:
    """Best chunk per doc from vec rows: doc_id -> (chunk_text, score)."""
    semantic_best: dict[str, tuple[str, float]] = {}
    for doc_id, chunk_text, dist in (vec_rows or []):
        score = 1.0 / (1.0 + dist)
        if doc_id not in semantic_best or score > semantic_best[doc_id][1]:
            semantic_best[doc_id] = (chunk_text, score)
    return semantic_best


def _normalize_ask_fts(fts_rows) -> dict:
    """Normalize FTS BM25 scores to [0, 1] (more-negative raw = better match). Keyed by doc_id."""
    fts_scores: dict[str, float] = {}
    if fts_rows:
        min_bm25 = min(r[1] for r in fts_rows)
        for doc_id, raw in fts_rows:
            if doc_id:
                fts_scores[doc_id] = raw / min_bm25 if min_bm25 != 0 else 1.0
    return fts_scores


async def _merge_ask_candidates(semantic_best: dict, fts_scores: dict) -> dict:
    """Merge semantic + FTS hits into doc_id -> (chunk_text, merged_score).

    For FTS-only hits not in the vec results, fetch the first chunk from sqlite-vec
    via embeddings._fetch_vec_chunk.
    """
    loop = asyncio.get_running_loop()
    merged: dict[str, tuple[str, float]] = {}
    for doc_id in set(semantic_best) | set(fts_scores):
        sem_score = semantic_best[doc_id][1] if doc_id in semantic_best else 0.0
        fts_score = fts_scores.get(doc_id, 0.0)
        merged_score = max(sem_score, fts_score)

        if doc_id in semantic_best:
            chunk_text, _ = semantic_best[doc_id]
        else:
            chunk_text = await loop.run_in_executor(config._executor, embeddings._fetch_vec_chunk, doc_id)
            if chunk_text is None:
                continue

        merged[doc_id] = (chunk_text, merged_score)
    return merged


def _rank_ask_candidates(merged: dict) -> list:
    """Apply the confidence gate and sort by score desc. Returns [(doc_id, chunk, score)]."""
    # Apply confidence gate; lowered to 0.35 to rescue keyword-heavy sparse docs
    ASK_MIN_SCORE = 0.35
    return sorted(
        [
            (doc_id, chunk, score)
            for doc_id, (chunk, score) in merged.items()
            if score >= ASK_MIN_SCORE
        ],
        key=lambda x: x[2],
        reverse=True,
    )


def _build_ask_context(req: AskRequest, candidates: list) -> tuple[list, list]:
    """Fetch metadata for ranked candidates, apply optional filters, and build the LLM
    context blocks + source citations. Falls back to document summaries when no chunk
    passes the filters. Returns (context_parts, sources).

    The per-candidate filter reuses `_passes_search_filters` (same predicate as
    `_search_sync`); tags are fetched lazily only when `req.tags` is set so the
    no-tags path issues no extra query — behavior identical to the prior inline form.
    """
    context_parts: list[str] = []
    sources: list[dict] = []
    seen_doc_ids: set[str] = set()

    with db.connection() as conn:
        for doc_id, chunk_text, _score in candidates:
            row = conn.execute(
                "SELECT filename, category, document_date, thumbnail_path, summary"
                " FROM documents WHERE id=? AND processing_status='complete'",
                (doc_id,),
            ).fetchone()
            if not row:
                continue

            filename = row["filename"]
            category = row["category"]
            doc_date = row["document_date"]
            thumb = row["thumbnail_path"]
            summary = row["summary"] or ""

            doc_tags = [r[0] for r in conn.execute(
                "SELECT tag FROM tags WHERE document_id=?", (doc_id,)
            ).fetchall()] if req.tags else []
            if not _passes_search_filters(req, category, doc_date, doc_tags):
                continue

            label = filename + (f" ({category})" if category else "")
            block = f"[{label}]\nSummary: {summary}\n\nExcerpt: {chunk_text}" if summary else f"[{label}]\n{chunk_text}"
            context_parts.append(block)

            if doc_id not in seen_doc_ids:
                seen_doc_ids.add(doc_id)
                sources.append({
                    "document_id": doc_id,
                    "filename": filename,
                    "category": category,
                    "excerpt": chunk_text[:300],
                    "has_thumbnail": bool(thumb and Path(thumb).exists()),
                })
        # Fallback: if chunks passed no filters, try summaries from matching docs
        if not context_parts:
            filter_clauses = ["processing_status='complete'", "summary IS NOT NULL", "summary != ''"]
            filter_params: list = []
            if req.category:
                filter_clauses.append("category=?")
                filter_params.append(req.category)
            if req.date_from:
                filter_clauses.append("(document_date IS NULL OR document_date >= ?)")
                filter_params.append(req.date_from)
            if req.date_to:
                filter_clauses.append("(document_date IS NULL OR document_date <= ?)")
                filter_params.append(req.date_to)
            where = " AND ".join(filter_clauses)
            summary_rows = conn.execute(
                f"SELECT id, filename, category, thumbnail_path, summary FROM documents WHERE {where}",
                filter_params,
            ).fetchall()
            for srow in summary_rows:
                if req.tags:
                    doc_tags = [r[0] for r in conn.execute(
                        "SELECT tag FROM tags WHERE document_id=?", (srow["id"],)
                    ).fetchall()]
                    if not all(t in doc_tags for t in req.tags):
                        continue
                label = srow["filename"] + (f" ({srow['category']})" if srow["category"] else "")
                context_parts.append(f"[{label}]\nSummary: {srow['summary']}")
                sources.append({
                    "document_id": srow["id"],
                    "filename": srow["filename"],
                    "category": srow["category"],
                    "excerpt": (srow["summary"] or "")[:300],
                    "has_thumbnail": bool(srow["thumbnail_path"] and Path(srow["thumbnail_path"]).exists()),
                })
    return context_parts, sources


def _build_ask_prompt(question: str, context_parts: list) -> tuple[str, str]:
    """Assemble the (system_prompt, user_message) pair from retrieved context."""
    context = "\n\n---\n\n".join(context_parts)
    system_prompt = (
        "You are a document assistant. Your ONLY job is to answer the user's question using the document excerpts below.\n\n"
        "STRICT RULES:\n"
        "(1) The answer IS in the excerpts. Read them carefully before concluding otherwise.\n"
        "(1a) The Summary field for each document contains clean, verified facts. Prefer facts from the Summary over the Excerpt when they conflict.\n"
        "(2) Answer in 1–3 sentences maximum. No preamble, no restating the question, no closing remarks.\n"
        "(3) Extract specific facts — dates, addresses, names, dollar amounts — verbatim from the excerpts.\n"
        "(4) Never say 'the conversation mentions' or 'based on our conversation'. These are document excerpts, not a conversation.\n"
        "(5) If after careful reading the answer truly is not present, say exactly: 'That information is not in your documents.' Nothing more.\n"
        "Never use hedging phrases like 'it appears', 'you might want to check', or 'if you have a document'."
    )
    user_message = f"DOCUMENT EXCERPTS:\n\n{context}\n\n---\n\nQuestion: {question}\n\nAnswer directly from the excerpts above:"
    return system_prompt, user_message


async def _stream_llm_response(system_prompt: str, user_message: str, sources: list) -> AsyncIterator[str]:
    """Stream the LLM completion from Ollama, forwarding each token as an SSE event.

    Owns the terminal SSE: on success emits per-token events then a single `done`
    event carrying `sources`; on failure emits an `error` event and returns with NO
    `done`. Putting `done` here (rather than in the orchestrator) means the caller
    never needs a success/failure signal back — the stream's outcome is encapsulated.
    Tripwire: do NOT add a `finally: yield done` — that would emit `done` on the error
    path and break the SSE contract. Token/done/error byte format must stay identical.
    """
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{config.OLLAMA_URL}/api/chat",
                json={
                    "model": config.LLM_MODEL,
                    "stream": True,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message},
                    ],
                },
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    token = chunk.get("message", {}).get("content")
                    if token:
                        yield _sse({"type": "token", "text": token})
                    if chunk.get("done"):
                        break
    except Exception as e:
        yield _sse({"type": "error", "text": f"LLM error: {e}"})
        return

    yield _sse({"type": "done", "sources": sources})


async def _ask_stream(req: AskRequest) -> AsyncIterator[str]:
    question = req.question.strip()

    # 1. Embed the question
    try:
        q_embedding = await _embed_question(question)
    except Exception as e:
        yield _sse({"type": "error", "text": f"Embedding failed: {e}"})
        return

    # 2. Query sqlite-vec for top-10 chunks and run FTS in parallel
    try:
        vec_rows, fts_rows = await _gather_ask_context(q_embedding, question)
    except Exception as e:
        yield _sse({"type": "error", "text": f"Search failed: {e}"})
        return

    # Three terminal early-exits follow, each with a deliberate fallback string:
    #   - no search rows at all          -> "No documents found in your vault."
    #   - rows but none clear the gate   -> "I don't have enough information ..."
    #   - candidates but none pass filters (post-context) -> same "I don't have enough ..."
    # The strings are intentional per-exit; do NOT swap or unify them.
    if not vec_rows and not fts_rows:
        yield _sse({"type": "token", "text": "No documents found in your vault."})
        yield _sse({"type": "done", "sources": []})
        return

    # 3. Merge semantic + FTS hits, then gate + rank
    merged = await _merge_ask_candidates(
        _semantic_best_chunks(vec_rows), _normalize_ask_fts(fts_rows)
    )
    candidates = _rank_ask_candidates(merged)

    if not candidates:
        fallback = "I don't have enough information in your documents to answer this question."
        yield _sse({"type": "token", "text": fallback})
        yield _sse({"type": "done", "sources": []})
        return

    # 4. Fetch metadata and build context (applies optional filters + summary fallback)
    context_parts, sources = _build_ask_context(req, candidates)

    if not context_parts:
        fallback = "I don't have enough information in your documents to answer this question."
        yield _sse({"type": "token", "text": fallback})
        yield _sse({"type": "done", "sources": []})
        return

    # 5. Build the prompt, then stream the answer (sub-generator owns token/done/error SSE)
    system_prompt, user_message = _build_ask_prompt(question, context_parts)
    async for chunk in _stream_llm_response(system_prompt, user_message, sources):
        yield chunk
