"""Smoke tests for embeddings.py — fast, no real Ollama / HTTP.

chunk_text is pure and deterministic; these cover the chunking contract and
its edge cases. The Ollama embed call is intentionally not exercised here.
"""
import embeddings


def test_chunk_text_empty_and_whitespace():
    assert embeddings.chunk_text("") == []
    assert embeddings.chunk_text("   \n\t  ") == []


def test_chunk_text_short_text_single_chunk():
    text = "the quick brown fox jumps over the lazy dog"
    chunks = embeddings.chunk_text(text)
    assert len(chunks) == 1
    # Below chunk_size, the single chunk reconstructs the original word stream.
    assert chunks[0].split() == text.split()


def test_chunk_text_overlap_reconstructs_with_repeats():
    # 40 distinct words, chunk_size=10, overlap=5 → windows step by 5.
    words = [f"w{i}" for i in range(40)]
    text = " ".join(words)
    chunks = embeddings.chunk_text(text, chunk_size=10, overlap=5)

    # Stride is chunk_size - overlap = 5; ceil(40/5) windows = 8.
    assert len(chunks) == 8
    # Every original word appears in at least one chunk (no data dropped).
    seen = set()
    for c in chunks:
        seen.update(c.split())
    assert seen == set(words)
    # Consecutive chunks share their overlap region (last 5 words of chunk N
    # equal first 5 of chunk N+1).
    first = chunks[0].split()
    second = chunks[1].split()
    assert first[5:10] == second[0:5]
