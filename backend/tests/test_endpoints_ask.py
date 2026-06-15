"""Tests for POST /ask — SSE streaming Q&A endpoint."""
import json
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import insert_document


def _parse_sse(text: str) -> list[dict]:
    """Parse SSE body text into a list of event dicts."""
    events = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events


def _make_async_client(post_return=None, stream_context=None):
    """Build a mock httpx.AsyncClient that works as an async context manager."""
    instance = AsyncMock()
    instance.__aenter__ = AsyncMock(return_value=instance)
    instance.__aexit__ = AsyncMock(return_value=False)
    if post_return is not None:
        instance.post = AsyncMock(return_value=post_return)
    if stream_context is not None:
        instance.stream = MagicMock(return_value=stream_context)
    return instance


def _make_embed_response(embedding=None):
    resp = AsyncMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value={"embedding": embedding or [0.1] * 768})
    return resp


def test_ask_streams_llm_tokens_for_matching_docs(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    from tests.conftest import insert_vec as _insert_vec

    doc_id = insert_document(db_path, processing_status="complete", filename="blood_test.pdf")
    _insert_vec(db_path, doc_id, [0.1] * 768, chunk_text="hemoglobin 14.2 g/dL")

    embed_resp = _make_embed_response()

    async def _fake_aiter_lines():
        yield json.dumps({"message": {"content": "The "}, "done": False})
        yield json.dumps({"message": {"content": "result"}, "done": False})
        yield json.dumps({"done": True})

    stream_resp = MagicMock()
    stream_resp.raise_for_status = MagicMock()
    stream_resp.aiter_lines = _fake_aiter_lines
    stream_resp.__aenter__ = AsyncMock(return_value=stream_resp)
    stream_resp.__aexit__ = AsyncMock(return_value=False)

    # First AsyncClient call → embedding, second → LLM streaming
    embed_client = _make_async_client(post_return=embed_resp)
    stream_client = AsyncMock()
    stream_client.__aenter__ = AsyncMock(return_value=stream_client)
    stream_client.__aexit__ = AsyncMock(return_value=False)
    stream_client.stream = MagicMock(return_value=stream_resp)

    with patch("main.httpx.AsyncClient", side_effect=[embed_client, stream_client]):
        resp = client.post("/ask", json={"question": "What was my hemoglobin?"})

    events = _parse_sse(resp.text)
    token_texts = [e["text"] for e in events if e.get("type") == "token"]
    done_events = [e for e in events if e.get("type") == "done"]

    assert "".join(token_texts) == "The result"
    assert done_events
    assert done_events[0]["sources"][0]["document_id"] == doc_id
