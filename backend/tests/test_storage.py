"""Smoke tests for the storage layer (path helpers + NAS init).

Fast, no external I/O — each runs against a tmp_path, never the real NAS.
"""

import storage


def test_path_helpers_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "NAS_PATH", tmp_path)
    doc_id = "abc-123"

    orig = storage.original_path(doc_id, ".pdf")
    text = storage.text_path(doc_id)
    thumb = storage.thumbnail_path(doc_id)

    # Live under the expected roots derived from the patched NAS_PATH.
    assert orig == tmp_path / "originals" / "abc-123.pdf"
    assert text == tmp_path / "processed" / "text" / "abc-123.txt"
    assert thumb == tmp_path / "processed" / "thumbnails" / "abc-123_thumb.jpg"


def test_nas_subdirs_under_root(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "NAS_PATH", tmp_path)
    subdirs = storage.nas_subdirs()

    assert tmp_path / "originals" in subdirs
    assert tmp_path / "processed" / "text" in subdirs
    assert tmp_path / "processed" / "thumbnails" in subdirs
    for d in subdirs:
        assert tmp_path in d.parents or d == tmp_path / "originals" or d == tmp_path / "processed"


def test_init_nas_creates_subdirs(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "NAS_PATH", tmp_path)

    storage.init_nas()

    assert (tmp_path / "originals").is_dir()
    assert (tmp_path / "processed").is_dir()
    assert (tmp_path / "processed" / "text").is_dir()
    assert (tmp_path / "processed" / "thumbnails").is_dir()
