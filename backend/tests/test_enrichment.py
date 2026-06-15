"""Smoke tests for enrichment.py — no real LLM / HTTP, fast (<100ms each)."""
import json
import sqlite3

import pytest

import enrichment


class _FakeOllamaResp:
    """Minimal stand-in for httpx.Response — only what _local_ollama_json_call touches."""

    def __init__(self, response_text):
        self._response_text = response_text

    def raise_for_status(self):
        return None

    def json(self):
        return {"response": self._response_text}


def _patch_ollama(monkeypatch, response_text):
    """Patch enrichment.httpx.post to return response_text; capture the request."""
    captured = {}

    def _fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return _FakeOllamaResp(response_text)

    monkeypatch.setattr(enrichment.httpx, "post", _fake_post)
    return captured


def test_title_fallback():
    # Happy: dashes/underscores collapse to spaces, extension stripped.
    assert enrichment._title_fallback("monthly-bank_statement.pdf") == "monthly bank statement"
    # Edge: empty / extension-only stem produces an empty title rather than raising.
    assert enrichment._title_fallback("") == ""


def test_merge_suggested_tags_dedupes(seeded_db, db_path, monkeypatch):
    # Repoint enrichment's own DB_PATH binding at the temp DB. Without this,
    # _merge_suggested_tags would connect to the real config.DB_PATH — this
    # patch is non-vacuous (the test would touch production data without it).
    monkeypatch.setattr(enrichment, "DB_PATH", db_path)

    doc_id = "doc-merge-test"
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, "tax"))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, "invoice"))
    conn.commit()
    conn.close()

    # "Tax" dupes existing "tax" (case), "" is dropped, "newtag" is genuinely
    # new. "invoice" is NOT in the suggestions, so it only survives if existing
    # tags were read from the (repointed) temp DB — keeps the patch non-vacuous.
    result = enrichment._merge_suggested_tags(
        doc_id, ["Tax", "newtag", ""]
    )

    assert result == ["invoice", "newtag", "tax"]


def test_detect_json_category():
    data = {"patient": "Jane Doe", "diagnosis": "ICD-10 J45", "notes": "follow up"}
    assert enrichment.detect_json_category(data) == "Medical"
    # The retired Vehicle category must not leak back into the JSON rules.
    categories = {cat for _words, cat in enrichment._JSON_CATEGORY_RULES}
    assert "Vehicle" not in categories


def test_local_ollama_json_call_parses_plain_json(monkeypatch):
    # Happy path: a clean JSON response parses to a dict, and the request
    # contract (endpoint payload + default timeout) is anchored so a future
    # edit to the shared helper can't silently change either.
    captured = _patch_ollama(monkeypatch, '{"title": "Acme Invoice", "summary": "An invoice."}')

    result = enrichment._local_ollama_json_call("user prompt", "system prompt", "generate-title")

    assert result == {"title": "Acme Invoice", "summary": "An invoice."}
    assert captured["json"] == {
        "model": enrichment.LLM_MODEL,
        "prompt": "user prompt",
        "system": "system prompt",
        "stream": False,
    }
    assert captured["timeout"] == 90


def test_local_ollama_json_call_strips_code_fence(monkeypatch):
    # The LLM commonly wraps JSON in a ```json … ``` fence; the helper must
    # strip the fence before json.loads (the path both _local_generate_title_*
    # functions rely on).
    fenced = '```json\n{"title": "Fenced", "summary": "ok"}\n```'
    _patch_ollama(monkeypatch, fenced)

    result = enrichment._local_ollama_json_call("u", "s", "generate-title (locked)")

    assert result == {"title": "Fenced", "summary": "ok"}


def test_local_ollama_json_call_reraises_on_bad_json(monkeypatch, capsys):
    # Failure path: an unparseable response prints the raw text to stderr under
    # the call site's log_label, then re-raises the JSONDecodeError.
    _patch_ollama(monkeypatch, "this is not json")

    with pytest.raises(json.JSONDecodeError):
        enrichment._local_ollama_json_call("u", "s", "generate-title")

    err = capsys.readouterr().err
    assert "generate-title: JSON parse error" in err
    assert "this is not json" in err
