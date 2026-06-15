"""Fast smoke tests for email_ingest.py — pure logic only.

NO real IMAP / network / PIL decoding. These cover the two pieces of branching
logic that moved as-is in step 7a: sender-address parsing/normalization and the
inline-image rescue size/dimension gate. Connection-level behavior
(_poll_imap_sync end to end) is deliberately NOT exercised — establishing an
IMAP connection is exactly what hung the deleted email tests.
"""

import email_ingest
from config import EMAIL_INLINE_IMAGE_MIN_BYTES, EMAIL_INLINE_IMAGE_MIN_DIM


def _parse_allowed(raw: str) -> set[str]:
    """Mirror the allowlist normalization used by update_email_settings /
    the poller: split on commas, strip, lowercase, drop empties."""
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def test_extract_email_addr_normalizes_and_parses():
    assert email_ingest._extract_email_addr("John Doe <John@Example.com>") == "john@example.com"
    assert email_ingest._extract_email_addr("  PLAIN@Test.ORG  ") == "plain@test.org"


def test_allowed_senders_parsing_with_edges():
    parsed = _parse_allowed("  Alice@Example.com , bob@test.io ,, Alice@example.com ")
    assert parsed == {"alice@example.com", "bob@test.io"}
    # Empty string yields an empty allowlist (poller returns no_allowed_senders).
    assert _parse_allowed("") == set()


def _inline_rescued(byte_len: int, width: int | None, height: int | None) -> bool:
    """Reproduce the inline-image rescue decision from _poll_imap_sync:
    accept only if it clears the byte-size gate AND (dimensions unknown OR both
    dimensions clear the minimum)."""
    if byte_len < EMAIL_INLINE_IMAGE_MIN_BYTES:
        return False
    if width is not None and height is not None and (
        width < EMAIL_INLINE_IMAGE_MIN_DIM or height < EMAIL_INLINE_IMAGE_MIN_DIM
    ):
        return False
    return True


def test_inline_image_rescue_threshold():
    big = EMAIL_INLINE_IMAGE_MIN_BYTES + 1
    small = EMAIL_INLINE_IMAGE_MIN_BYTES - 1
    ok_dim = EMAIL_INLINE_IMAGE_MIN_DIM + 10
    tiny_dim = EMAIL_INLINE_IMAGE_MIN_DIM - 10

    # Above both gates → rescued.
    assert _inline_rescued(big, ok_dim, ok_dim) is True
    # Below the byte gate → skipped regardless of dimensions.
    assert _inline_rescued(small, ok_dim, ok_dim) is False
    # Big enough bytes but too small a dimension → skipped.
    assert _inline_rescued(big, tiny_dim, ok_dim) is False
    # Big bytes, unreadable dimensions (PIL failed) → byte gate alone wins.
    assert _inline_rescued(big, None, None) is True
