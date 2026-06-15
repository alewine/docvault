"""Audit + cleanup endpoints.

All four paths share the /audit/* surface (/audit/audit, /audit/cleanup,
/audit/dismiss-pair, /audit/dismiss-cluster), so a router prefix would
technically fit — but every other router in this package uses NO prefix,
and the path decorators are kept byte-identical to their old `@app.*`
forms for cross-router consistency. Switching to a prefix here alone
would force a per-router decision that documents.py and search.py would
then have to litigate.

Mutable/patched dependencies are referenced via attribute access on their
owning modules so conftest monkeypatches flow through at call time:
  - db.DB_PATH          (conftest patches db.DB_PATH)
  - db._vec_conn        (resolves DB_PATH in db's own globals)
  - storage.NAS_PATH    (conftest patches storage.NAS_PATH)
  - storage._run_cleanup_sync
  - embeddings._normalize
  - config._executor

`_run_audit_sync` is audit-specific and lives here with run_audit, which
resolves it in this module's namespace. This module must never import main.
"""
import asyncio
import itertools
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import db
import embeddings
import storage

router = APIRouter(tags=["audit"])


@router.post("/audit/audit")
async def run_audit():
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(config._executor, _run_audit_sync)


def _fetch_audit_documents() -> list:
    with db.connection() as conn:
        return conn.execute(
            "SELECT id, filename, original_path, processed_text_path, thumbnail_path,"
            " uploaded_at, file_hash, category FROM documents"
        ).fetchall()


def _find_orphaned_records(docs) -> list[dict]:
    """Orphaned DB records: file missing from NAS."""
    orphaned_records = []
    for doc in docs:
        p = Path(doc["original_path"]) if doc["original_path"] else None
        if not p or not p.exists():
            orphaned_records.append({
                "document_id": doc["id"],
                "filename": doc["filename"],
                "original_path": doc["original_path"],
                "uploaded_at": doc["uploaded_at"],
            })
    return orphaned_records


def _find_orphaned_files(docs) -> list[dict]:
    """Orphaned NAS files: files with no matching DB row. Deletes dotfiles in place."""
    known_ids: set[str] = {doc["id"] for doc in docs}
    orphaned_files = []
    scan_dirs = [
        ("originals", storage.NAS_PATH / "originals"),
        ("processed/text", storage.NAS_PATH / "processed" / "text"),
        ("processed/thumbnails", storage.NAS_PATH / "processed" / "thumbnails"),
    ]
    for subdir_label, dir_path in scan_dirs:
        if not dir_path.exists():
            continue
        for f in dir_path.iterdir():
            if not f.is_file():
                continue
            if f.name.startswith('.'):
                f.unlink(missing_ok=True)
                continue
            # File names are <uuid><ext> or <uuid>_thumb.jpg or <uuid>.txt
            stem = f.stem.replace("_thumb", "")
            if stem not in known_ids:
                try:
                    size = f.stat().st_size
                except Exception:
                    size = None
                orphaned_files.append({
                    "path": str(f),
                    "filename": f.name,
                    "size_bytes": size,
                    "subdir": subdir_label,
                })
    return orphaned_files


def _load_dismissed_set() -> set:
    """Dismissed pairs (persisted across sessions)."""
    with db.connection() as conn_dp:
        dismissed_rows = conn_dp.execute(
            "SELECT doc_id_a, doc_id_b FROM audit_dismissed_pairs"
        ).fetchall()
        return {(r[0], r[1]) for r in dismissed_rows}


def _is_dismissed(id_a: str, id_b: str, dismissed_set: set) -> bool:
    return (min(id_a, id_b), max(id_a, id_b)) in dismissed_set


def _get_file_size(path_str: Optional[str]) -> int:
    if not path_str:
        return 0
    try:
        return Path(path_str).stat().st_size
    except Exception:
        return 0


def _build_doc_meta_map(docs) -> dict[str, dict]:
    return {
        row["id"]: {
            "id": row["id"],
            "filename": row["filename"],
            "category": row["category"] or "",
            "uploaded_at": row["uploaded_at"],
            "file_size": _get_file_size(row["original_path"]),
        }
        for row in docs
    }


def _exact_duplicate_clusters(docs, doc_meta_map: dict, dismissed_set: set) -> tuple[list[dict], set]:
    """Exact duplicate clusters (same file_hash). Returns (clusters, claimed_ids)."""
    clusters: list[dict] = []
    in_cluster: set[str] = set()

    hash_to_ids: dict[str, list[str]] = {}
    for row in docs:
        if row["file_hash"] and row["id"] in doc_meta_map:
            hash_to_ids.setdefault(row["file_hash"], []).append(row["id"])

    for ids in hash_to_ids.values():
        if len(ids) < 2:
            continue
        ids_sorted = sorted(
            [i for i in ids if i in doc_meta_map],
            key=lambda i: doc_meta_map[i]["uploaded_at"] or "",
        )
        if not ids_sorted:
            continue
        anchor_id = ids_sorted[0]
        members = [
            {**doc_meta_map[mid], "similarity": 1.0}
            for mid in ids_sorted[1:]
            if not _is_dismissed(anchor_id, mid, dismissed_set)
        ]
        if not members:
            continue
        in_cluster.add(anchor_id)
        for m in members:
            in_cluster.add(m["id"])
        clusters.append({
            "anchor": {**doc_meta_map[anchor_id], "similarity": 1.0},
            "members": members,
            "max_similarity": 1.0,
            "cluster_size": 1 + len(members),
        })
    return clusters, in_cluster


def _near_duplicate_clusters(doc_meta_map: dict, dismissed_set: set, hash_claimed: set) -> list[dict]:
    """Near-duplicate clusters via greedy pass on sqlite-vec embeddings (cosine sim >= 0.97)."""
    clusters: list[dict] = []
    try:
        import struct as _struct
        vc = db._vec_conn()
        try:
            raw_rows = vc.execute(
                """
                SELECT m.document_id, v.embedding
                FROM vec_chunks v
                JOIN vec_chunk_meta m ON m.rowid = v.rowid
                WHERE m.chunk_index = 0
                ORDER BY m.document_id
                """
            ).fetchall()
        finally:
            vc.close()

        if len(raw_rows) > 1:
            valid = []
            for doc_id, raw_bytes in raw_rows:
                if doc_id not in doc_meta_map:
                    continue
                n_floats = len(raw_bytes) // 4
                emb = list(_struct.unpack(f'{n_floats}f', raw_bytes))
                valid.append((doc_id, embeddings._normalize(emb)))

        if len(raw_rows) > 1 and len(valid) > 1:
            import numpy as np
            valid_ids = [v[0] for v in valid]
            emb_matrix = np.array([v[1] for v in valid], dtype=np.float64)
            norms = np.linalg.norm(emb_matrix, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            normalized = emb_matrix / norms
            sim_matrix = normalized @ normalized.T

            # Connected-components clustering over the similarity graph so each
            # displayed cluster equals the FULL transitive group. The old
            # anchor-relative greedy pass only displayed the subset of docs
            # within 0.97 of the run's anchor, so a different anchor each run
            # surfaced a new combination and pairwise dismissal could never
            # converge. Building connected components means full-group dismissal
            # (which records every internal pair) removes every edge, and the
            # group can't reform. Docs already in an exact-hash cluster are
            # excluded from this graph.
            n = len(valid_ids)
            parent = list(range(n))

            def _find(x: int) -> int:
                while parent[x] != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                return x

            def _union(a: int, b: int) -> None:
                ra, rb = _find(a), _find(b)
                if ra != rb:
                    parent[ra] = rb

            for i in range(n):
                if valid_ids[i] in hash_claimed:
                    continue
                for j in range(i + 1, n):
                    if valid_ids[j] in hash_claimed:
                        continue
                    if float(sim_matrix[i, j]) < 0.97:
                        continue
                    if _is_dismissed(valid_ids[i], valid_ids[j], dismissed_set):
                        continue
                    _union(i, j)

            components: dict[int, list[int]] = {}
            for i in range(n):
                if valid_ids[i] in hash_claimed:
                    continue
                components.setdefault(_find(i), []).append(i)

            for comp_indices in components.values():
                if len(comp_indices) < 2:
                    continue
                # anchor = earliest-uploaded doc in the component (most likely original)
                anchor_idx = min(
                    comp_indices,
                    key=lambda idx: doc_meta_map[valid_ids[idx]]["uploaded_at"] or "",
                )
                anchor_id = valid_ids[anchor_idx]
                members = [
                    {
                        **doc_meta_map[valid_ids[idx]],
                        "similarity": round(float(sim_matrix[anchor_idx, idx]), 4),
                    }
                    for idx in comp_indices
                    if idx != anchor_idx
                ]
                members.sort(key=lambda x: x["similarity"], reverse=True)
                clusters.append({
                    "anchor": {**doc_meta_map[anchor_id], "similarity": 1.0},
                    "members": members,
                    "max_similarity": members[0]["similarity"],
                    "cluster_size": 1 + len(members),
                })
    except Exception as e:
        print(f"audit: near-duplicate detection failed: {e}")
    return clusters


def _run_audit_sync() -> dict:
    docs = _fetch_audit_documents()

    orphaned_records = _find_orphaned_records(docs)
    orphaned_files = _find_orphaned_files(docs)

    dismissed_set = _load_dismissed_set()
    doc_meta_map = _build_doc_meta_map(docs)

    exact_clusters, in_cluster = _exact_duplicate_clusters(docs, doc_meta_map, dismissed_set)
    near_clusters = _near_duplicate_clusters(doc_meta_map, dismissed_set, in_cluster)
    clusters = exact_clusters + near_clusters

    total_dup_docs = sum(c["cluster_size"] - 1 for c in clusters)

    return {
        "orphaned_records": orphaned_records,
        "orphaned_files": orphaned_files,
        "duplicates": clusters,
        "summary": {
            "orphaned_records": len(orphaned_records),
            "orphaned_files": len(orphaned_files),
            "duplicate_clusters": len(clusters),
            "duplicate_documents": total_dup_docs,
        },
    }


class DismissPairRequest(BaseModel):
    doc_id_a: str
    doc_id_b: str


class DismissClusterRequest(BaseModel):
    doc_ids: list[str]


class CleanupAction(BaseModel):
    action: str  # delete_orphan_record | delete_orphan_file | delete_duplicate
    target_id: Optional[str] = None
    target_path: Optional[str] = None


class CleanupRequest(BaseModel):
    actions: list[CleanupAction]


@router.post("/audit/cleanup")
async def run_cleanup(req: CleanupRequest):
    # Reject any client-supplied target_path that resolves outside the storage
    # directory before doing any work (path-traversal / arbitrary-delete guard).
    nas_root = Path(storage.NAS_PATH).resolve()
    for action in req.actions:
        if action.action == "delete_orphan_file" and action.target_path:
            if not Path(action.target_path).resolve().is_relative_to(nas_root):
                raise HTTPException(status_code=400, detail="Path outside storage directory")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(config._executor, storage._run_cleanup_sync, req)


@router.post("/audit/dismiss-pair")
async def dismiss_pair(req: DismissPairRequest):
    a, b = min(req.doc_id_a, req.doc_id_b), max(req.doc_id_a, req.doc_id_b)
    with db.connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO audit_dismissed_pairs (doc_id_a, doc_id_b) VALUES (?, ?)",
            (a, b),
        )
        conn.commit()
    return {"dismissed": True}


@router.post("/audit/dismiss-cluster")
async def dismiss_cluster(req: DismissClusterRequest):
    # Persist every pairwise combination among the cluster's docs so the whole
    # group can never re-cluster against itself again (regardless of which doc
    # becomes the anchor on a future run).
    unique_ids = list(dict.fromkeys(req.doc_ids))
    if len(unique_ids) < 2:
        return {"dismissed": True, "pairs": 0}

    pairs = [
        (min(a, b), max(a, b))
        for a, b in itertools.combinations(unique_ids, 2)
    ]

    with db.connection() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO audit_dismissed_pairs (doc_id_a, doc_id_b) VALUES (?, ?)",
            pairs,
        )
        conn.commit()
    return {"dismissed": True, "pairs": len(pairs)}
