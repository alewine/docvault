"""Embedding / vectorization.

Deterministic per-chunk vectorization: split extracted text into chunks,
embed each via Ollama `nomic-embed-text`, and store the vectors in sqlite-vec.
Plus the small vec-similarity query helpers that read those vectors back.

This is NOT enrichment — there is no LLM free-form generation here (title /
summary / category / tags / dates live in enrichment.py). The only shared
surface with enrichment is HTTP transport to Ollama; each module owns its own
httpx call for now (a shared `ollama_client.py` is deferred — see step 5b).

Lazy imports (sqlite_vec, traceback) inside function bodies stay lazy.
"""

import math
import sqlite3

import httpx

from config import OLLAMA_URL, EMBED_MODEL
from db import log_event, _vec_conn, delete_document_vectors


_MAX_WORD_CHARS = 80   # longer "words" are OCR artifacts; truncate them
_MAX_CHUNK_CHARS = 2000  # ~600 tokens at 3 chars/token, safely under nomic-embed-text's 2048-token limit


def chunk_text(text: str, chunk_size: int = 300, overlap: int = 50) -> list[str]:
    # Drop/truncate OCR garbage words before chunking
    words = [w[:_MAX_WORD_CHARS] for w in text.split() if w]
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        chunk_words: list[str] = []
        char_count = 0
        for word in words[start : start + chunk_size]:
            needed = len(word) + (1 if chunk_words else 0)
            if char_count + needed > _MAX_CHUNK_CHARS:
                break
            chunk_words.append(word)
            char_count += needed
        if not chunk_words:
            # Single word too long after truncation — take it anyway
            chunk_words = [words[start]]
        chunks.append(" ".join(chunk_words))
        start += chunk_size - overlap
    return chunks


def _normalize(emb: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(x * x for x in emb))
    if magnitude == 0:
        return emb
    return [x / magnitude for x in emb]


def _check_embedding_quality() -> tuple[bool, float]:
    """Probe Ollama with two semantically distinct strings and return (is_healthy, cross_similarity).

    Degenerate models collapse all inputs to nearly-identical vectors; cross-similarity >= 0.85
    indicates Ollama is returning useless embeddings.
    """
    _PROBE_A = "the patient has a fever and needs medication"
    _PROBE_B = "the invoice total is due by end of quarter"
    try:
        def _embed(prompt: str) -> list[float]:
            resp = httpx.post(
                f"{OLLAMA_URL}/api/embeddings",
                json={"model": EMBED_MODEL, "prompt": prompt},
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json()["embedding"]

        emb_a = _embed(_PROBE_A)
        emb_b = _embed(_PROBE_B)

        dot = sum(a * b for a, b in zip(emb_a, emb_b))
        norm_a = math.sqrt(sum(x * x for x in emb_a))
        norm_b = math.sqrt(sum(x * x for x in emb_b))
        if not (math.isfinite(dot) and norm_a > 0 and norm_b > 0):
            return False, 0.0
        score = dot / (norm_a * norm_b)
        score = score if math.isfinite(score) else 0.0
        return score < 0.85, round(score, 4)
    except Exception:
        return False, 0.0


def _fetch_vec_chunk(doc_id: str) -> str | None:
    """Return the first stored chunk (chunk_index=0) for a document, or None.

    Lifted from a nested closure in the /ask stream so vec-meta reads live with
    the vectorization layer; captures nothing beyond its doc_id argument.
    """
    try:
        vc = _vec_conn()
        try:
            row = vc.execute(
                "SELECT chunk_text FROM vec_chunk_meta WHERE document_id=? AND chunk_index=0 LIMIT 1",
                (doc_id,),
            ).fetchone()
            return row[0] if row else None
        finally:
            vc.close()
    except Exception:
        return None


def embed_document(doc_id: str, text: str, conn: sqlite3.Connection | None = None) -> None:
    import traceback as _tb

    chunks = chunk_text(text)
    if not chunks:
        if conn:
            log_event(conn, doc_id, "embed_verify", status="skipped",
                      message="No text to embed — document will not participate in RAG")
        return

    if conn:
        log_event(conn, doc_id, "chunking",
                  message=f"Text split into {len(chunks)} chunks (300 words, 50 overlap)",
                  chunk_count=len(chunks))

    embeddings = []
    try:
        for i, chunk in enumerate(chunks):
            resp = httpx.post(
                f"{OLLAMA_URL}/api/embeddings",
                json={"model": EMBED_MODEL, "prompt": chunk},
                timeout=60.0,
            )
            resp.raise_for_status()
            emb = _normalize(resp.json()["embedding"])
            if i == 0:
                is_healthy, score = _check_embedding_quality()
                if not is_healthy:
                    raise ValueError(
                        f"Ollama returned degenerate embeddings (cross-similarity={score:.4f})"
                        " — Ollama may need restart"
                    )
            embeddings.append(emb)
    except Exception as e:
        if conn:
            log_event(conn, doc_id, "embed", status="failure",
                      message=f"{e}\n\n{_tb.format_exc()}",
                      chunk_count=len(chunks),
                      metadata={"model": EMBED_MODEL, "ollama_url": OLLAMA_URL})
        raise

    try:
        import sqlite_vec as _sv
        vc = _vec_conn()
        try:
            delete_document_vectors(doc_id, vc)
            for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
                vc.execute(
                    "INSERT INTO vec_chunk_meta (document_id, chunk_index, chunk_text) VALUES (?,?,?)",
                    (doc_id, i, chunk),
                )
                rowid = vc.execute("SELECT last_insert_rowid()").fetchone()[0]
                vc.execute(
                    "INSERT INTO vec_chunks (rowid, embedding) VALUES (?,?)",
                    (rowid, _sv.serialize_float32(emb)),
                )
            vc.commit()
        finally:
            vc.close()
    except Exception as e:
        if conn:
            log_event(conn, doc_id, "index", pipeline_path="sqlite_vec", status="failure",
                      message=f"{e}\n\n{_tb.format_exc()}",
                      chunk_count=len(chunks))
        raise

    if conn:
        log_event(conn, doc_id, "embed", status="success",
                  message=f"Sent {len(chunks)} chunks to Ollama {EMBED_MODEL}",
                  chunk_count=len(chunks),
                  metadata={"model": EMBED_MODEL, "ollama_url": OLLAMA_URL})
        log_event(conn, doc_id, "index", pipeline_path="sqlite_vec", status="success",
                  message=f"Stored {len(chunks)} vectors in sqlite-vec",
                  chunk_count=len(chunks))
