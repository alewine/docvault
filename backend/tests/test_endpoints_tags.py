"""Tests for tag management endpoints: GET /tags, PUT /tags/{tag}, DELETE /tags/{tag}."""
import sqlite3

from tests.conftest import insert_document


def _seed_tag(db_path, doc_id, tag):
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, ?)", (doc_id, tag))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# GET /tags — already covered in test_endpoints_simple; deeper tests here
# ---------------------------------------------------------------------------

def test_get_tags_sorted_by_count_desc(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc1 = insert_document(db_path)
    doc2 = insert_document(db_path)
    doc3 = insert_document(db_path)

    _seed_tag(db_path, doc1, "common")
    _seed_tag(db_path, doc2, "common")
    _seed_tag(db_path, doc3, "common")
    _seed_tag(db_path, doc1, "rare")

    resp = client.get("/tags")
    tags = resp.json()["tags"]
    assert tags[0]["tag"] == "common"
    assert tags[0]["count"] == 3
    assert tags[1]["tag"] == "rare"


# ---------------------------------------------------------------------------
# PUT /tags/{tag} — rename
# ---------------------------------------------------------------------------

def test_rename_tag_400_when_new_name_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put("/tags/old", json={"new_name": ""})
    assert resp.status_code == 400


def test_rename_tag_400_when_new_name_whitespace(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put("/tags/old", json={"new_name": "   "})
    assert resp.status_code == 400


def test_rename_tag_updates_all_documents(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc1 = insert_document(db_path)
    doc2 = insert_document(db_path)
    _seed_tag(db_path, doc1, "old-name")
    _seed_tag(db_path, doc2, "old-name")

    resp = client.put("/tags/old-name", json={"new_name": "new-name"})
    assert resp.status_code == 200
    assert resp.json()["updated_count"] == 2

    conn = sqlite3.connect(db_path)
    old_count = conn.execute("SELECT COUNT(*) FROM tags WHERE tag='old-name'").fetchone()[0]
    new_count = conn.execute("SELECT COUNT(*) FROM tags WHERE tag='new-name'").fetchone()[0]
    conn.close()
    assert old_count == 0
    assert new_count == 2


def test_rename_tag_merges_when_new_name_already_exists_on_doc(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc = insert_document(db_path)
    # Doc already has both "old" and "new" — renaming "old" to "new" should
    # delete the "old" tag row (can't have two "new" rows on same doc)
    _seed_tag(db_path, doc, "old")
    _seed_tag(db_path, doc, "new")

    resp = client.put("/tags/old", json={"new_name": "new"})
    assert resp.status_code == 200
    # updated_count is 0 because the rename was a merge (delete not update)
    assert resp.json()["updated_count"] == 0

    conn = sqlite3.connect(db_path)
    tags = [r[0] for r in conn.execute("SELECT tag FROM tags WHERE document_id=?", (doc,)).fetchall()]
    conn.close()
    assert tags == ["new"]


def test_rename_tag_noop_when_no_matching_documents(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put("/tags/nonexistent", json={"new_name": "whatever"})
    assert resp.status_code == 200
    assert resp.json()["updated_count"] == 0


def test_rename_tag_lowercases_new_name(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc = insert_document(db_path)
    _seed_tag(db_path, doc, "old")

    resp = client.put("/tags/old", json={"new_name": "NEW-NAME"})
    assert resp.status_code == 200
    conn = sqlite3.connect(db_path)
    tag = conn.execute("SELECT tag FROM tags WHERE document_id=?", (doc,)).fetchone()[0]
    conn.close()
    assert tag == "new-name"


# ---------------------------------------------------------------------------
# DELETE /tags/{tag}
# ---------------------------------------------------------------------------

def test_delete_tag_removes_from_all_documents(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc1 = insert_document(db_path)
    doc2 = insert_document(db_path)
    _seed_tag(db_path, doc1, "to-delete")
    _seed_tag(db_path, doc2, "to-delete")
    _seed_tag(db_path, doc1, "keep-this")

    resp = client.delete("/tags/to-delete")
    assert resp.status_code == 200
    assert resp.json()["deleted_count"] == 2

    conn = sqlite3.connect(db_path)
    remaining = conn.execute("SELECT tag FROM tags").fetchall()
    conn.close()
    tags = {r[0] for r in remaining}
    assert "to-delete" not in tags
    assert "keep-this" in tags


def test_delete_tag_returns_zero_for_nonexistent(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.delete("/tags/nonexistent")
    assert resp.status_code == 200
    assert resp.json()["deleted_count"] == 0
