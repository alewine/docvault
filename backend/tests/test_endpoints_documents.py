"""Tests for document CRUD endpoints."""
import sqlite3

from tests.conftest import insert_document

# ---------------------------------------------------------------------------
# GET /document/{doc_id}
# ---------------------------------------------------------------------------

def test_get_document_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/document/nonexistent-id")
    assert resp.status_code == 404


def test_get_document_returns_fields(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(
        db_path,
        filename="report.pdf",
        category="Medical",
        notes="important",
        processing_status="complete",
    )

    resp = client.get(f"/document/{doc_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["document_id"] == doc_id
    assert data["filename"] == "report.pdf"
    assert data["category"] == "Medical"
    assert data["notes"] == "important"
    assert data["tags"] == []
    assert data["processing_status"] == "complete"


def test_get_document_returns_tags(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'urgent')", (doc_id,))
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'reviewed')", (doc_id,))
    conn.commit()
    conn.close()

    resp = client.get(f"/document/{doc_id}")
    assert set(resp.json()["tags"]) == {"urgent", "reviewed"}


def test_get_document_returns_extracted_text_when_file_exists(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    text_file = nas_dir / "processed" / "text" / "doc1.txt"
    text_file.write_text("Hello extracted text")
    doc_id = insert_document(
        db_path, processed_text_path=str(text_file), processing_status="complete"
    )

    resp = client.get(f"/document/{doc_id}")
    assert resp.json()["extracted_text"] == "Hello extracted text"


def test_get_document_returns_none_extracted_text_when_no_file(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    resp = client.get(f"/document/{doc_id}")
    assert resp.json()["extracted_text"] is None


# ---------------------------------------------------------------------------
# PUT /document/{doc_id}
# ---------------------------------------------------------------------------

def test_update_document_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.put("/document/nonexistent", json={"category": "Legal"})
    assert resp.status_code == 404


def test_update_document_category(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, category="Other")

    resp = client.put(f"/document/{doc_id}", json={"category": "Medical"})
    assert resp.status_code == 200
    assert resp.json()["category"] == "Medical"


def test_update_document_notes(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.put(f"/document/{doc_id}", json={"notes": "reviewed by doctor"})
    assert resp.status_code == 200
    assert resp.json()["notes"] == "reviewed by doctor"


def test_update_document_replaces_tags(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'old-tag')", (doc_id,))
    conn.commit()
    conn.close()

    resp = client.put(f"/document/{doc_id}", json={"tags": ["new-tag", "another"]})
    assert resp.status_code == 200
    tags = set(resp.json()["tags"])
    assert "old-tag" not in tags
    assert "new-tag" in tags
    assert "another" in tags


def test_update_document_clears_tags_when_empty_list(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'tag1')", (doc_id,))
    conn.commit()
    conn.close()

    resp = client.put(f"/document/{doc_id}", json={"tags": []})
    assert resp.status_code == 200
    assert resp.json()["tags"] == []


def test_update_document_strips_blank_tags(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.put(f"/document/{doc_id}", json={"tags": ["  ", "valid", "  "]})
    assert resp.status_code == 200
    tags = resp.json()["tags"]
    assert "valid" in tags
    assert "" not in tags
    assert " " not in tags


def test_update_document_title(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.put(f"/document/{doc_id}", json={"title": "My Custom Title"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "My Custom Title"


def test_update_document_date(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.put(f"/document/{doc_id}", json={"document_date": "2024-01-15"})
    assert resp.status_code == 200
    assert resp.json()["document_date"] == "2024-01-15"


# ---------------------------------------------------------------------------
# DELETE /document/{doc_id}
# ---------------------------------------------------------------------------

def test_delete_document_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.delete("/document/nonexistent")
    assert resp.status_code == 404


def test_delete_document_removes_from_db(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.delete(f"/document/{doc_id}")
    assert resp.status_code == 200
    assert resp.json()["deleted"] == doc_id

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    conn.close()
    assert row is None


def test_delete_document_removes_nas_files(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    orig = nas_dir / "originals" / "test.pdf"
    orig.write_bytes(b"pdf content")
    text_file = nas_dir / "processed" / "text" / "test.txt"
    text_file.write_text("extracted text")

    doc_id = insert_document(
        db_path,
        original_path=str(orig),
        processed_text_path=str(text_file),
    )

    client.delete(f"/document/{doc_id}")
    assert not orig.exists()
    assert not text_file.exists()


def test_delete_document_cascades_tags(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'test')", (doc_id,))
    conn.commit()
    conn.close()

    client.delete(f"/document/{doc_id}")

    conn = sqlite3.connect(db_path)
    tags = conn.execute("SELECT * FROM tags WHERE document_id=?", (doc_id,)).fetchall()
    conn.close()
    assert tags == []


# ---------------------------------------------------------------------------
# GET /documents (list with filters)
# ---------------------------------------------------------------------------

def test_list_documents_returns_all_statuses_sorted(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    insert_document(db_path, processing_status="complete")
    insert_document(db_path, processing_status="queued")
    insert_document(db_path, processing_status="error")

    resp = client.get("/documents")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    statuses = [d["processing_status"] for d in data["documents"]]
    assert statuses[0] == "complete"


def test_list_documents_pagination(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    for _ in range(30):
        insert_document(db_path, processing_status="complete")

    resp = client.get("/documents?page=1&page_size=10")
    data = resp.json()
    assert data["total"] == 30
    assert len(data["documents"]) == 10
    assert data["page"] == 1

    resp2 = client.get("/documents?page=2&page_size=10")
    ids1 = {d["document_id"] for d in resp.json()["documents"]}
    ids2 = {d["document_id"] for d in resp2.json()["documents"]}
    assert ids1.isdisjoint(ids2)


def test_list_documents_filter_by_category(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    insert_document(db_path, category="Medical", processing_status="complete")
    insert_document(db_path, category="Legal", processing_status="complete")

    resp = client.get("/documents?category=Medical")
    docs = resp.json()["documents"]
    assert all(d["category"] == "Medical" for d in docs)
    assert len(docs) == 1


def test_list_documents_filter_by_tag(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc1 = insert_document(db_path, processing_status="complete")
    doc2 = insert_document(db_path, processing_status="complete")
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tags (document_id, tag) VALUES (?, 'urgent')", (doc1,))
    conn.commit()
    conn.close()

    resp = client.get("/documents?tags=urgent")
    ids = {d["document_id"] for d in resp.json()["documents"]}
    assert doc1 in ids
    assert doc2 not in ids


def test_list_documents_returns_correct_fields(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    insert_document(db_path, processing_status="complete", filename="my-doc.pdf")

    resp = client.get("/documents")
    doc = resp.json()["documents"][0]
    assert "document_id" in doc
    assert "filename" in doc
    assert "tags" in doc
    assert doc["filename"] == "my-doc.pdf"


# ---------------------------------------------------------------------------
# POST /document/{doc_id}/reprocess
# ---------------------------------------------------------------------------

def test_reprocess_document_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.post("/document/nonexistent/reprocess")
    assert resp.status_code == 404


def test_reprocess_document_creates_new_job(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path, processing_status="error")

    resp = client.post(f"/document/{doc_id}/reprocess")
    assert resp.status_code == 200
    job_id = resp.json()["job_id"]

    conn = sqlite3.connect(db_path)
    job = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    doc = conn.execute("SELECT processing_status FROM documents WHERE id=?", (doc_id,)).fetchone()
    conn.close()
    assert job[0] == "queued"
    assert doc[0] == "queued"


# ---------------------------------------------------------------------------
# GET /document/{doc_id}/log
# ---------------------------------------------------------------------------

def test_get_document_log_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/document/nonexistent/log")
    assert resp.status_code == 404


def test_get_document_log_empty(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)

    resp = client.get(f"/document/{doc_id}/log")
    assert resp.status_code == 200
    assert resp.json()["entries"] == []


def test_get_document_log_returns_entries(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    doc_id = insert_document(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO document_log (document_id, event_type, status, message)"
        " VALUES (?, 'ocr', 'ok', 'done')",
        (doc_id,),
    )
    conn.execute(
        "INSERT INTO document_log (document_id, event_type, status, message)"
        " VALUES (?, 'embed', 'ok', 'embedded')",
        (doc_id,),
    )
    conn.commit()
    conn.close()

    resp = client.get(f"/document/{doc_id}/log")
    entries = resp.json()["entries"]
    assert len(entries) == 2
    event_types = {e["event_type"] for e in entries}
    assert event_types == {"ocr", "embed"}


# ---------------------------------------------------------------------------
# GET /original/{doc_id}
# ---------------------------------------------------------------------------

def test_get_original_404_for_unknown(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    resp = client.get("/original/nonexistent")
    assert resp.status_code == 404


def test_get_original_serves_file(isolated_app):
    client, main, db_path, nas_dir = isolated_app
    orig = nas_dir / "originals" / "sample.txt"
    orig.write_bytes(b"file content here")
    doc_id = insert_document(db_path, original_path=str(orig), filename="sample.txt")

    resp = client.get(f"/original/{doc_id}")
    assert resp.status_code == 200
    assert resp.content == b"file content here"
