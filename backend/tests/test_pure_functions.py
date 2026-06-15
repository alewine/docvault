"""Tests for zero-dependency pure functions in main.py."""

import main

# ---------------------------------------------------------------------------
# chunk_text
# ---------------------------------------------------------------------------

def test_chunk_text_empty_string():
    assert main.chunk_text("") == []


def test_chunk_text_whitespace_only():
    assert main.chunk_text("   \n\t  ") == []


def test_chunk_text_short_text_single_chunk():
    text = " ".join(["word"] * 50)
    chunks = main.chunk_text(text)
    assert len(chunks) == 1
    assert chunks[0].startswith("word")


def test_chunk_text_long_text_creates_multiple_chunks():
    # 400 words → 2+ chunks with default chunk_size=300, overlap=50
    text = " ".join([f"word{i}" for i in range(400)])
    chunks = main.chunk_text(text)
    assert len(chunks) >= 2


def test_chunk_text_overlap_means_words_repeated():
    # With chunk_size=10, overlap=5, first chunk ends at word9;
    # second chunk starts at word5. word5 should appear in both.
    words = [f"w{i}" for i in range(20)]
    text = " ".join(words)
    chunks = main.chunk_text(text, chunk_size=10, overlap=5)
    assert len(chunks) >= 2
    # Last word of chunk 0 should also appear near the start of chunk 1
    chunk0_words = set(chunks[0].split())
    chunk1_words = set(chunks[1].split())
    assert chunk0_words & chunk1_words  # non-empty intersection


def test_chunk_text_long_word_truncated_to_max_chars():
    long_word = "A" * 200
    chunks = main.chunk_text(long_word)
    assert len(chunks) == 1
    # The word should be truncated to _MAX_WORD_CHARS
    assert len(chunks[0]) == main._MAX_WORD_CHARS


def test_chunk_text_single_word():
    chunks = main.chunk_text("hello")
    assert chunks == ["hello"]


def test_chunk_text_no_chunk_exceeds_max_chars():
    # Build a text where each word is exactly _MAX_WORD_CHARS long
    word = "B" * main._MAX_WORD_CHARS
    text = " ".join([word] * 100)
    chunks = main.chunk_text(text)
    for chunk in chunks:
        assert len(chunk) <= main._MAX_CHUNK_CHARS + main._MAX_WORD_CHARS  # one word leeway


# ---------------------------------------------------------------------------
# _sanitize_fts
# ---------------------------------------------------------------------------

def test_sanitize_fts_empty_string():
    assert main._sanitize_fts("") == ""


def test_sanitize_fts_strips_punctuation():
    assert main._sanitize_fts("hello! world?") == "hello world"


def test_sanitize_fts_preserves_numbers():
    assert main._sanitize_fts("form 1040") == "form 1040"


def test_sanitize_fts_removes_special_chars():
    assert main._sanitize_fts("foo@bar.com") == "foobarcom"


def test_sanitize_fts_collapses_multiple_spaces():
    result = main._sanitize_fts("hello   world")
    assert result == "hello world"


def test_sanitize_fts_all_punctuation_returns_empty():
    assert main._sanitize_fts("!!! ???") == ""


def test_sanitize_fts_hyphenated_word():
    # Hyphen is not \w so "well-known" → "wellknown"
    result = main._sanitize_fts("well-known")
    assert result == "wellknown"


def test_sanitize_fts_unicode_word():
    result = main._sanitize_fts("café")
    assert "caf" in result  # \w on Python includes unicode letters


# ---------------------------------------------------------------------------
# _sanitize_category
# ---------------------------------------------------------------------------

def test_sanitize_category_valid_name_passes_through():
    assert main._sanitize_category("Financial") == "Financial"


def test_sanitize_category_valid_two_word():
    # "Home Maintenance" is not in ALLOWED_CATEGORIES — must fall back to Other
    assert main._sanitize_category("Home Maintenance") == "Other"


def test_sanitize_category_strips_punctuation():
    assert main._sanitize_category('"Medical."') == "Medical"


def test_sanitize_category_sentence_returns_other():
    long = "This Is A Financial Document Related To Tax Filing"
    assert main._sanitize_category(long) == "Other"


def test_sanitize_category_four_word_returns_other():
    assert main._sanitize_category("Home And Garden Supplies") == "Other"


def test_sanitize_category_not_in_allowed_returns_other():
    assert main._sanitize_category("Taxes") == "Other"


def test_sanitize_category_empty_returns_other():
    assert main._sanitize_category("") == "Other"


def test_sanitize_category_case_insensitive():
    # Case-insensitive match — "financial" should resolve to "Financial"
    assert main._sanitize_category("financial") == "Financial"


def test_sanitize_category_matches_valid_set():
    result = main._sanitize_category("Financial", {"Financial", "Medical"})
    assert result == "Financial"


def test_sanitize_category_not_in_valid_set_returns_other():
    result = main._sanitize_category("Taxes", {"Financial", "Medical"})
    assert result == "Other"


def test_sanitize_category_education():
    assert main._sanitize_category("Education") == "Education"


# ---------------------------------------------------------------------------
# _extract_email_addr
# ---------------------------------------------------------------------------

def test_extract_email_addr_with_angle_brackets():
    assert main._extract_email_addr("John Doe <john@example.com>") == "john@example.com"


def test_extract_email_addr_plain_address():
    assert main._extract_email_addr("john@example.com") == "john@example.com"


def test_extract_email_addr_lowercases():
    assert main._extract_email_addr("JOHN@EXAMPLE.COM") == "john@example.com"


def test_extract_email_addr_strips_whitespace():
    assert main._extract_email_addr("  user@test.org  ") == "user@test.org"


def test_extract_email_addr_extracts_from_angle_brackets_with_spaces():
    assert main._extract_email_addr("  <alerts@service.io>  ") == "alerts@service.io"


# ---------------------------------------------------------------------------
# _title_fallback
# ---------------------------------------------------------------------------

def test_title_fallback_replaces_dashes():
    assert main._title_fallback("my-document.pdf") == "my document"


def test_title_fallback_replaces_underscores():
    assert main._title_fallback("my_document.pdf") == "my document"


def test_title_fallback_replaces_mixed():
    result = main._title_fallback("invoice-2024_03_15.pdf")
    assert result == "invoice 2024 03 15"


def test_title_fallback_truncates_at_40_chars():
    long_name = "a" * 50 + ".pdf"
    result = main._title_fallback(long_name)
    assert len(result) <= 40


def test_title_fallback_no_extension():
    result = main._title_fallback("nodotfile")
    assert result == "nodotfile"


def test_title_fallback_strips_leading_trailing_spaces():
    result = main._title_fallback("--leading.pdf")
    assert not result.startswith(" ")


def test_title_fallback_collapses_multiple_separators():
    result = main._title_fallback("foo---bar.pdf")
    assert result == "foo bar"
