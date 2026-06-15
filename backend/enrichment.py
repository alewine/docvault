"""LLM-driven semantic enrichment.

Everything here turns extracted document text into derived metadata via the
local LLM (llama3.1:8b) or lightweight heuristics: titles, summaries, category
inference + recategorization, tag suggestion/merging, and document-date
extraction. Plus the JSON-structure heuristics that route a parsed JSON payload
to a category/date without an LLM call.

This is NOT vectorization (chunking/embedding lives in embeddings.py) and NOT
extraction (OCR / per-format text extraction lives in extraction.py). The only
shared surface with embeddings is HTTP transport to Ollama; each module owns
its own httpx call for now (a shared `ollama_client.py` is deferred — to be
evaluated now that both Ollama-using modules exist).

Lazy imports (datetime, dateutil) inside function bodies stay lazy.
"""

import json
import re
import sqlite3
import sys
from pathlib import Path

import httpx

from config import (
    OLLAMA_URL,
    LLM_MODEL,
    DB_PATH,
    VALID_CATEGORIES,
    ALLOWED_CATEGORIES,
)
from db import log_event, connection


def _sanitize_category(raw: str, valid_set: set[str] | None = None) -> str:
    """Validate an AI-generated category name; return 'Other' if not in the allowed set."""
    name = raw.strip().strip("\"'.,;:!?")
    if not name:
        return "Other"
    check_set = valid_set if valid_set is not None else ALLOWED_CATEGORIES
    # Case-insensitive match against the allowed set
    for allowed in check_set:
        if allowed.lower() == name.lower():
            return allowed
    return "Other"


def _title_fallback(filename: str) -> str:
    stem = Path(filename).stem
    return re.sub(r"[-_]+", " ", stem).strip()[:40]


_CATEGORY_SUMMARY_INSTRUCTIONS: dict[str, str] = {
    "Medical": (
        "Focus on the patient name, provider or facility, condition or procedure, "
        "and any key dates or outcomes."
    ),
    "Insurance": (
        "Focus on the policy type, insurer, insured party, coverage period, "
        "and any claim or premium details."
    ),
    "Financial": (
        "Focus on the institution, account or transaction type, amounts, and relevant dates."
    ),
    "Legal": (
        "Focus on the parties involved, the nature of the legal matter, "
        "and any key dates or obligations."
    ),
    "Home": (
        "Focus on the property address, the nature of the document "
        "(deed, inspection, utility, HOA), and key dates or parties."
    ),
    "Education": (
        "Focus on the institution or program, the student or recipient, the degree or course, "
        "and any key dates or outcomes."
    ),
    "Other": "Summarize what the document is and its key information in plain language.",
}

_VALID_CATEGORIES_LIST = ", ".join(sorted(VALID_CATEGORIES))


def _local_ollama_json_call(
    user_msg: str, system_msg: str, log_label: str, timeout: int = 90
) -> dict:
    """POST to Ollama /api/generate, fence-strip the response, and json.loads it.

    Shared tail of _local_generate_title_and_category and _local_generate_title_locked
    (the two call sites differ only in their prompts and the stderr label). Returns the
    parsed dict; lets HTTP errors propagate; on a JSON parse failure, prints the raw
    response to stderr under log_label and re-raises the JSONDecodeError.
    """
    resp = httpx.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": LLM_MODEL, "prompt": user_msg, "system": system_msg, "stream": False},
        timeout=timeout,
    )
    resp.raise_for_status()
    response_text = resp.json().get("response", "")
    raw = response_text.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"{log_label}: JSON parse error. Raw response:\n{response_text}", file=sys.stderr)
        raise


def _local_generate_title_and_category(
    filename: str, extracted_text: str, current_category: str
) -> dict:
    snippet = extracted_text[:3000]
    cat = current_category or "Other"

    system_msg = (
        "You are a document classification and summarization assistant. You will be given raw extracted "
        "text from a scanned or digital document. Your job is to classify and summarize it.\n\n"
        "You must respond with ONLY a valid JSON object — no explanation, no markdown, no preamble. "
        "Do not say the document is not medical or financial or anything else. Just classify and "
        "summarize what is actually there. "
        "Never mention what information is absent or missing from the document. Summarize only what is actually there."
    )

    user_msg = (
        f"Document filename: {filename}\n"
        f"Current category: {cat}\n\n"
        f"Extracted text:\n{snippet}\n\n"
        "Classify this document and return a JSON object with exactly these fields:\n"
        '- "title": a short, specific human-readable title '
        '(e.g. "Kaleidoscope Counseling Superbill — Feb 2025")\n'
        '- "summary": a 2–3 sentence summary describing what this document actually contains. '
        "Do not mention what the document lacks or does not include. Do not speculate about information not present. "
        "Only state what is explicitly in the document.\n"
        '- "suggested_category": the single best-fit category from this list: '
        "Audio, Education, Financial, Home, Insurance, Legal, Medical, Other. "
        "You MUST choose from this list exactly. If the document does not clearly match any category, choose Other.\n"
        '- "category_confidence": "high" if you are confident, "low" if the document is ambiguous\n'
        '- "suggested_tags": an array of 3–8 short lowercase tags useful for filtering — '
        "names, vendors, document types, years, and key topics. Avoid generic tags like "
        '"document" unless there is nothing more specific.\n\n'
        "Category framing guide — use the matching framing in your summary:\n"
        "- Medical: the patient name, provider or facility name, service or procedure performed, diagnosis codes if present, service date, and any amounts billed or paid.\n"
        "- Insurance: policy type, insurer, insured party, coverage period, claim or premium details\n"
        "- Financial: institution, account or transaction type, amounts, relevant dates\n"
        "- Legal: parties involved, nature of the legal matter, key dates or obligations\n"
        "- Home: property address, document type (deed/inspection/utility/HOA), key dates or parties\n"
        "- Education: institution or program, student or recipient, degree or course, key dates or outcomes\n"
        "- Other: plain language description of what the document is and its key information\n\n"
        "Important: A medical superbill, invoice, or billing statement from a healthcare provider is "
        "still categorized as Medical — it documents a medical encounter."
    )

    return _local_ollama_json_call(user_msg, system_msg, "generate-title")


def _local_generate_title_locked(
    filename: str, extracted_text: str, current_category: str
) -> dict:
    """Generate title + summary for a document whose category is manually locked."""
    snippet = extracted_text[:3000]
    cat = current_category or "Other"

    system_msg = (
        "You are a document summarization assistant. You will be given raw extracted text from a "
        "scanned or digital document. Your job is to produce a title and summary.\n\n"
        "You must respond with ONLY a valid JSON object — no explanation, no markdown, no preamble. "
        "Never mention what information is absent or missing from the document. Summarize only what "
        "is actually there."
    )

    user_msg = (
        f"Document filename: {filename}\n"
        f"Category (manually set, do not change): {cat}\n\n"
        f"Extracted text:\n{snippet}\n\n"
        "Return a JSON object with exactly these fields:\n"
        '- "title": a short, specific human-readable title '
        '(e.g. "Kaleidoscope Counseling Superbill — Feb 2025")\n'
        '- "summary": a 2–3 sentence summary describing what this document actually contains. '
        "Do not mention what the document lacks or does not include. Do not speculate about "
        "information not present. Only state what is explicitly in the document.\n"
        '- "suggested_tags": an array of 3–8 short lowercase tags useful for filtering — '
        "names, vendors, document types, years, and key topics. Avoid generic tags like "
        '"document" unless there is nothing more specific.\n\n'
        "Category framing guide — use the matching framing in your summary:\n"
        "- Medical: the patient name, provider or facility name, service or procedure performed, diagnosis codes if present, service date, and any amounts billed or paid.\n"
        "- Insurance: policy type, insurer, insured party, coverage period, claim or premium details\n"
        "- Financial: institution, account or transaction type, amounts, relevant dates\n"
        "- Legal: parties involved, nature of the legal matter, key dates or obligations\n"
        "- Home: property address, document type (deed/inspection/utility/HOA), key dates or parties\n"
        "- Education: institution or program, student or recipient, degree or course, key dates or outcomes\n"
        "- Other: plain language description of what the document is and its key information"
    )

    return _local_ollama_json_call(user_msg, system_msg, "generate-title (locked)")


def _local_recategorize_summary(extracted_text: str, category: str) -> str:
    framing = _CATEGORY_SUMMARY_INSTRUCTIONS.get(
        category, _CATEGORY_SUMMARY_INSTRUCTIONS["Other"]
    )
    snippet = extracted_text[:3000]
    system_msg = (
        "You are a document archivist. Summarize the document in 2–3 sentences "
        "using the framing appropriate for its category. Respond with only the summary text — "
        "no JSON, no preamble."
    )
    user_msg = f"Category: {category}\n\nFraming: {framing}\n\nDocument text:\n{snippet}"
    resp = httpx.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": LLM_MODEL, "prompt": user_msg, "system": system_msg, "stream": False},
        timeout=90,
    )
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


def _merge_suggested_tags(doc_id: str, suggested_tags) -> list[str]:
    """Union the LLM's suggested tags into the document's existing tags.

    Normalizes to lowercase/stripped, dedupes, writes the merged list back to the
    tags table, logs a "tags_updated" event, and returns the final sorted list.
    Returns the existing tags unchanged when there is nothing valid to add.
    """
    if not isinstance(suggested_tags, list):
        suggested_tags = []
    new_tags = {
        t.strip().lower()
        for t in suggested_tags
        if isinstance(t, str) and t.strip()
    }

    with connection() as conn:
        existing = {
            r[0].strip().lower()
            for r in conn.execute(
                "SELECT tag FROM tags WHERE document_id=?", (doc_id,)
            ).fetchall()
            if r[0] and r[0].strip()
        }
        merged = existing | new_tags
        if merged == existing:
            return sorted(existing)

        conn.execute("DELETE FROM tags WHERE document_id=?", (doc_id,))
        for tag in sorted(merged):
            conn.execute(
                "INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, tag)
            )
        conn.commit()
        log_event(
            conn,
            doc_id,
            "tags_updated",
            status="success",
            message=f"Merged {len(new_tags)} suggested tag(s); {len(merged)} total",
            metadata={"added": sorted(new_tags - existing)},
        )
        return sorted(merged)


def auto_categorize(doc_id: str, extracted_text: str, conn: sqlite3.Connection) -> None:
    try:
        existing = conn.execute(
            "SELECT category FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if existing and existing[0]:
            log_event(conn, doc_id, "auto_categorize", status="skipped",
                      message=f"Category already set: {existing[0]}")
            return

        category_list = sorted(ALLOWED_CATEGORIES)

        text_sample = extracted_text[:4000]
        prompt = (
            "You are categorizing a personal document for an average US household. "
            "You MUST choose exactly one category from this list: "
            f"{', '.join(sorted(ALLOWED_CATEGORIES))}. "
            "If the document does not clearly match any category, choose Other. "
            "Respond with ONLY the category name, nothing else.\n\n"
            "Use these definitions to guide your choice:\n"
            "- Financial: invoices, bills, charges, balances, payments, receipts, statements — "
            "including medical bills, EOBs, superbills, insurance invoices. "
            "If the primary content is monetary, it is Financial.\n"
            "- Medical: clinical documents only — diagnoses, lab results, prescriptions, "
            "treatment notes, immunization records, doctor's notes, medical history. NOT billing.\n"
            "- Insurance: insurance policies, coverage documents, declarations pages. "
            "NOT EOBs or claims (those are Financial).\n"
            "- Legal: contracts, court documents, wills, powers of attorney.\n"
            "- Home: mortgage, property tax, HOA, utilities, home maintenance.\n"
            "- Education: transcripts, diplomas, report cards, school records, course certificates.\n"
            "- Audio: MP3, WAV, or other audio recordings — podcasts, voice memos, music.\n"
            "- Other: anything that does not clearly fit the above categories.\n\n"
            f"Document text:\n{text_sample}"
        )

        resp = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": LLM_MODEL, "prompt": prompt, "stream": False},
            timeout=30.0,
        )
        resp.raise_for_status()
        raw = resp.json().get("response", "").strip()
        category = _sanitize_category(raw)

        conn.execute("UPDATE documents SET category=? WHERE id=?", (category, doc_id))
        conn.commit()
        log_event(conn, doc_id, "auto_categorize", status="success",
                  message=f"Category assigned: {category}")
        print(f"auto_categorize: {doc_id} → {category}")

    except Exception as e:
        print(f"auto_categorize: failed for {doc_id}: {e}")
        try:
            conn.execute("UPDATE documents SET category='Other' WHERE id=?", (doc_id,))
            conn.commit()
            log_event(conn, doc_id, "auto_categorize", status="failure",
                      message=f"Categorization failed, falling back to Other: {e}")
        except Exception as e2:
            print(f"auto_categorize: fallback also failed for {doc_id}: {e2}")


_METADATA_PROMPT = """\
You are a document classifier. Analyze the document text below and return metadata.

Return ONLY valid JSON in exactly this shape — no markdown, no explanation:
{{
  "category": "<one of: Medical, Insurance, Financial, Legal, Home, Other>",
  "tags": ["<tag1>", "<tag2>"],
  "document_date": "<YYYY-MM-DD or null>"
}}

Rules:
- category: single best fit from the allowed values only
- tags: 3–6 lowercase proper nouns and key identifiers (company names, people's names, product names, policy/account numbers if short). No generic words like "document" or "form".
- document_date: date ON the document (policy effective date, statement date, invoice date). Return null if no clear date is found.

Document text:
{text}
"""


_SKIP_DATE_LABELS = re.compile(
    r"(?:service|of\s+service|dos)\s*$",
    re.IGNORECASE,
)
# Matches "<optional label words>date :" or "<...>date " followed by a date value.
# Separator may be a colon or whitespace, so "Date   Jun 05, 2026" matches like "Date: ...".
# Four date-value patterns: "8 January 2025", "January 8, 2025", "01/08/2025", "2025-01-08"
_LABELED_DATE_RE = re.compile(
    r"([\w\s]{0,30}?)date\s*[:\s]\s*"
    r"(\d{1,2}\s+\w+\s+\d{4}"
    r"|\w+\.?\s+\d{1,2},?\s+\d{4}"
    r"|\d{1,2}[/-]\d{1,2}[/-]\d{4}"
    r"|\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)


def _extract_document_date(text: str) -> str | None:
    """Return the first non-service labeled date as YYYY-MM-DD, or None."""
    from dateutil import parser as _dup
    from dateutil.parser import ParserError

    for m in _LABELED_DATE_RE.finditer(text):
        label_prefix = m.group(1).strip()
        if _SKIP_DATE_LABELS.search(label_prefix):
            continue
        try:
            dt = _dup.parse(m.group(2), dayfirst=False)
            if 1900 <= dt.year <= 2100:
                return dt.date().isoformat()
        except (ParserError, OverflowError, ValueError):
            continue
    return None


def auto_extract_metadata(doc_id: str, extracted_text: str, conn: sqlite3.Connection) -> None:
    if not extracted_text.strip():
        return
    doc_date = _extract_document_date(extracted_text)
    if doc_date:
        try:
            conn.execute(
                "UPDATE documents SET document_date=? WHERE id=?",
                (doc_date, doc_id),
            )
            conn.commit()
            log_event(conn, doc_id, "metadata_extracted", status="success",
                      message=f"document_date set to {doc_date} (source: regex)")
        except Exception as e:
            log_event(conn, doc_id, "metadata_extracted", status="failure",
                      message=f"Failed to write document_date: {e}")
    else:
        log_event(conn, doc_id, "metadata_extracted", status="success",
                  message="No document_date found in text (regex)")

    try:
        prompt = _METADATA_PROMPT.format(text=extracted_text[:4000])
        resp = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": LLM_MODEL, "prompt": prompt, "stream": False},
            timeout=60.0,
        )
        resp.raise_for_status()
        raw = resp.json().get("response", "").strip()
        parsed = json.loads(raw)
        tags = parsed.get("tags") or []
        tags = [t.lower().strip() for t in tags if isinstance(t, str) and t.strip()]
        conn.execute("DELETE FROM tags WHERE document_id=?", (doc_id,))
        for tag in tags:
            conn.execute(
                "INSERT INTO tags (document_id, tag) VALUES (?, ?)",
                (doc_id, tag),
            )
        conn.commit()
        log_event(conn, doc_id, "tags_extracted", status="success",
                  message=f"tags: {', '.join(tags)}" if tags else "no tags returned")

        # Fall back to the LLM's document_date when the regex found nothing.
        # Never overwrite a date already present (e.g. seeded from the email body).
        if not doc_date:
            llm_date = parsed.get("document_date")
            if isinstance(llm_date, str) and llm_date.strip():
                llm_date = llm_date.strip()
                import datetime as _dt
                valid = False
                try:
                    _parsed_dt = _dt.datetime.strptime(llm_date, "%Y-%m-%d")
                    valid = 1900 <= _parsed_dt.year <= 2100
                except (ValueError, TypeError):
                    valid = False
                if valid:
                    _existing_date = conn.execute(
                        "SELECT document_date FROM documents WHERE id=?", (doc_id,)
                    ).fetchone()
                    if not _existing_date or not _existing_date[0]:
                        conn.execute(
                            "UPDATE documents SET document_date=? WHERE id=?",
                            (llm_date, doc_id),
                        )
                        conn.commit()
                        log_event(conn, doc_id, "metadata_extracted", status="success",
                                  message=f"document_date set to {llm_date} (source: llm)")
    except Exception as e:
        log_event(conn, doc_id, "tags_extracted", status="failure",
                  message=f"LLM tag extraction failed: {e}")


def build_summary_prompts(extracted_text: str, category: str) -> tuple:
    snippet = extracted_text[:4000]
    cat = (category or "").strip()

    if cat == "Medical":
        title_prompt = (
            "Return only a concise document title capturing the document type, date if present, "
            "and primary medical concern. 5 words maximum. No punctuation. No preamble or explanation.\n\n"
            f"{snippet}"
        )
        summary_prompt = (
            "Extract and summarize the following medical document in 3–5 sentences. "
            "Include all of the following that are present: document type, chief complaint, "
            "surgical or procedure history with dates, current medications with dosages, "
            "physical examination findings, symptoms including quality/aggravating/relieving factors, "
            "and any diagnoses or impressions. "
            "Summarize the following document in 3-5 sentences. Output only the summary. Do not announce it, label it, or add any closing sentence.\n\n"
            f"{snippet}"
        )
    elif cat == "Financial":
        title_prompt = (
            "Return only a concise document title capturing the document type, institution if present, "
            "and time period or tax year. 5 words maximum. No punctuation. No preamble or explanation.\n\n"
            f"{snippet}"
        )
        summary_prompt = (
            "Extract and summarize the following financial document in 3–5 sentences. "
            "Include: document type, institution or parties involved, time period or tax year, "
            "key financial figures (amounts, totals, balances), and any notable line items or conclusions. "
            "Summarize the following document in 3-5 sentences. Output only the summary. Do not announce it, label it, or add any closing sentence.\n\n"
            f"{snippet}"
        )
    elif cat == "Insurance":
        title_prompt = (
            "Return only a concise document title capturing the document type, insurer, "
            "and coverage type or policy period. 5 words maximum. No punctuation. No preamble or explanation.\n\n"
            f"{snippet}"
        )
        summary_prompt = (
            "Extract and summarize the following insurance document in 3–5 sentences. "
            "Include: insurer name, policy type, coverage dates, key coverage amounts or limits, "
            "deductibles, copays, and any claim details if present. "
            "Summarize the following document in 3-5 sentences. Output only the summary. Do not announce it, label it, or add any closing sentence.\n\n"
            f"{snippet}"
        )
    elif cat == "Legal":
        title_prompt = (
            "Return only a concise document title capturing the document type "
            "and parties involved if present. 5 words maximum. No punctuation. No preamble or explanation.\n\n"
            f"{snippet}"
        )
        summary_prompt = (
            "Extract and summarize the following legal document in 3–5 sentences. "
            "Include: document type, parties involved, effective dates, key obligations or terms, "
            "and any notable clauses or amounts. "
            "Summarize the following document in 3-5 sentences. Output only the summary. Do not announce it, label it, or add any closing sentence.\n\n"
            f"{snippet}"
        )
    else:
        title_prompt = (
            "Return only a short descriptive document title. "
            "5 words maximum. No punctuation. No preamble or explanation.\n\n"
            f"{snippet}"
        )
        summary_prompt = (
            "Write a 2–3 sentence plain-language summary of the following document. "
            "Capture the document's main subject, key details, and any dates or parties involved. "
            "Summarize the following document in 3-5 sentences. Output only the summary. Do not announce it, label it, or add any closing sentence.\n\n"
            f"{snippet}"
        )

    return title_prompt, summary_prompt


def generate_document_title(filename: str, extracted_text: str, category: str = "") -> str:
    if not extracted_text:
        return _title_fallback(filename)

    title_prompt, _ = build_summary_prompts(extracted_text, category)
    resp = httpx.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": LLM_MODEL, "prompt": title_prompt, "stream": False},
        timeout=60.0,
    )
    resp.raise_for_status()
    title = resp.json().get("response", "").strip().strip("\"'.,")
    if not title:
        return _title_fallback(filename)
    return title[:80]


_SUMMARY_SYSTEM = (
    "You are a document summarizer. You output only the requested content — "
    "no preamble, no labels, no meta-commentary. Never begin a response with phrases "
    "like 'Here is', 'Here are', 'The following', or any announcement of what you are "
    "about to write."
)


def generate_document_summary(extracted_text: str, category: str = "") -> str:
    _, summary_prompt = build_summary_prompts(extracted_text, category)
    resp = httpx.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": LLM_MODEL, "system": _SUMMARY_SYSTEM, "prompt": summary_prompt, "stream": False},
        timeout=60.0,
    )
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


# ---------------------------------------------------------------------------
# JSON enrichment helpers (category routing + date inference)
#
# These interpret JSON content semantically rather than extracting readable
# text, so they belong with enrichment, not extraction. (JSON *text* extraction
# lives in extraction.extract_json_text.)
# ---------------------------------------------------------------------------

_JSON_CATEGORY_RULES: list[tuple[set[str], str]] = [
    ({"diagnosis", "medication", "patient", "icd", "npi", "rx"}, "Medical"),
    ({"premium", "policy", "claim", "coverage", "deductible", "beneficiary"}, "Insurance"),
    ({"amount", "transaction", "balance", "account", "routing", "invoice", "total", "tax"}, "Financial"),
    ({"contract", "agreement", "clause", "party", "jurisdiction", "plaintiff", "defendant"}, "Legal"),
    ({"grade", "gpa", "course", "enrollment", "transcript", "student"}, "Education"),
]

_JSON_DATE_KEYS = {
    "date", "created_at", "updated_at", "timestamp",
    "issued_date", "document_date", "service_date", "transaction_date",
}


def _collect_json_keys(obj: object, keys: set[str], depth: int, max_depth: int) -> None:
    if depth >= max_depth:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            _collect_json_keys(v, keys, depth + 1, max_depth)
    elif isinstance(obj, list):
        for item in obj[:20]:
            _collect_json_keys(item, keys, depth + 1, max_depth)


def detect_json_category(data: object) -> str | None:
    keys: set[str] = set()
    _collect_json_keys(data, keys, depth=0, max_depth=3)
    lower_keys = {k.lower() for k in keys}
    for pattern_words, category in _JSON_CATEGORY_RULES:
        for key in lower_keys:
            if any(word in key for word in pattern_words):
                return category
    return None


def extract_json_date(data: object) -> str | None:
    from dateutil import parser as _dup
    from dateutil.parser import ParserError

    candidates: list[object] = []

    if isinstance(data, dict):
        for k, v in data.items():
            if k.lower() in _JSON_DATE_KEYS:
                candidates.append(v)
            elif isinstance(v, dict):
                for k2, v2 in v.items():
                    if k2.lower() in _JSON_DATE_KEYS:
                        candidates.append(v2)
    elif isinstance(data, list):
        for item in data[:20]:
            if isinstance(item, dict):
                for k, v in item.items():
                    if k.lower() in _JSON_DATE_KEYS:
                        candidates.append(v)

    for val in candidates:
        if not isinstance(val, str) or not val.strip():
            continue
        try:
            dt = _dup.parse(val, dayfirst=False)
            if 1900 <= dt.year <= 2100:
                return dt.date().isoformat()
        except (ParserError, OverflowError, ValueError):
            continue
    return None
