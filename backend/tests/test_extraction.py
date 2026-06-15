"""Smoke tests for extraction.py — fast, no real OCR / pdfplumber / network.

Covers the text-only formats that need no heavyweight deps (TXT, CSV) plus the
dispatcher routing for .pdf (per-format extractor mocked out).
"""
import extraction


def test_txt_extraction_roundtrip(tmp_path):
    p = tmp_path / "note.txt"
    content = "Hello DocVault, this is a plain text file."
    p.write_text(content)

    assert extraction.ocr_file(p, ".txt") == content


def test_csv_extraction_tab_separated(tmp_path):
    p = tmp_path / "data.csv"
    p.write_text("name,amount\nAlice,100\nBob,200\n")

    lines = extraction.ocr_file(p, ".csv").split("\n")
    assert lines == ["name\tamount", "Alice\t100", "Bob\t200"]


def test_ocr_file_pdf_dispatches_to_native(tmp_path, monkeypatch):
    """A .pdf with a usable text layer returns _extract_pdf_native's output
    without falling through to OCR."""
    sentinel = "native pdf text well over ten characters"
    seen = {}

    def fake_native(path, doc_id=None, conn=None):
        seen["path"] = path
        return sentinel

    monkeypatch.setattr(extraction, "_extract_pdf_native", fake_native)

    p = tmp_path / "doc.pdf"
    p.write_bytes(b"%PDF-1.4 fake")

    assert extraction.ocr_file(p, ".pdf") == sentinel
    assert seen["path"] == p
