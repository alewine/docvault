"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import BACKEND_URL from "@/app/lib/backend";

interface TagEntry {
  tag: string;
  count: number;
}

const PAGE_SIZE = 25;

function IconButton({
  icon,
  tooltip,
  hoverColor,
  onClick,
}: {
  icon: string;
  tooltip: string;
  hoverColor: "teal" | "danger";
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = hovered
    ? hoverColor === "teal"
      ? "#00D4AA"
      : "#E53E3E"
    : "#8A93A8";

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              background: hovered ? "#242838" : "transparent",
              border: "none",
              padding: 6,
              borderRadius: 6,
              cursor: "pointer",
              color,
              transition: "color 0.15s, background 0.15s",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <i className={`ti ${icon}`} style={{ fontSize: 16 }} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={5}
            className="z-50 rounded-lg border border-vault-border bg-vault-elevated px-2.5 py-1.5 text-xs text-vault-text-primary shadow-lg"
          >
            {tooltip}
            <Tooltip.Arrow style={{ fill: "#242838" }} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export default function TagManagerView() {
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [loadingTags, setLoadingTags] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);

  const fetchTags = useCallback(async () => {
    setLoadingTags(true);
    setTagsError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTags(data.tags as TagEntry[]);
    } catch (err) {
      setTagsError(err instanceof Error ? err.message : "Failed to load tags");
    } finally {
      setLoadingTags(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = tableContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, filtered.length));
        }
      },
      { root: container },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  const startRename = (tag: string) => {
    setRenamingTag(tag);
    setRenameValue(tag);
    setDeletingTag(null);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const commitRename = async (oldTag: string) => {
    const newName = renameValue.trim().toLowerCase();
    setRenamingTag(null);
    if (!newName || newName === oldTag) return;
    try {
      const res = await fetch(
        `${BACKEND_URL}/tags/${encodeURIComponent(oldTag)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_name: newName }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTags();
    } catch (err) {
      setTagsError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  const confirmDelete = async (tag: string) => {
    setDeletingTag(null);
    try {
      const res = await fetch(
        `${BACKEND_URL}/tags/${encodeURIComponent(tag)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTags();
    } catch (err) {
      setTagsError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const filtered = tags.filter((t) =>
    t.tag.toLowerCase().includes(search.toLowerCase()),
  );
  const visibleSlice = filtered.slice(0, visibleCount);
  const maxCount =
    visibleSlice.length > 0 ? Math.max(...visibleSlice.map((t) => t.count)) : 1;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="text-vault-text-primary leading-tight"
            style={{ fontSize: 22, fontWeight: 500 }}
          >
            Tag Manager
          </h2>
          <p className="text-vault-text-muted mt-1" style={{ fontSize: 14 }}>
            Rename or delete tags across your vault.
          </p>
        </div>

        {/* Filter input */}
        <div className="relative flex-shrink-0" style={{ minWidth: 220 }}>
          <i
            className="ti ti-search text-vault-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ fontSize: 16 }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tags…"
            className="w-full bg-vault-input border border-vault-border text-vault-text-primary placeholder:text-vault-text-muted focus:outline-none focus:border-[rgba(0,212,170,0.4)]"
            style={{
              borderRadius: 8,
              padding: "8px 14px 8px 34px",
              fontSize: 14,
              transition: "border-color 0.15s",
            }}
          />
        </div>
      </div>

      {tagsError && (
        <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {tagsError}
        </div>
      )}

      {loadingTags ? (
        <p className="text-vault-text-muted" style={{ fontSize: 14 }}>
          Loading…
        </p>
      ) : tags.length === 0 ? (
        <p className="text-vault-text-muted" style={{ fontSize: 14 }}>
          No tags yet.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-vault-text-muted" style={{ fontSize: 14 }}>
          No tags match your filter.
        </p>
      ) : (
        <>
          {/* Table card */}
          <div
            ref={tableContainerRef}
            className="bg-vault-surface border border-vault-border"
            style={{ borderRadius: 12, overflowY: "auto", maxHeight: 740 }}
          >
            <table className="w-full">
              <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
                <tr className="bg-vault-elevated border-b border-vault-border">
                  <th
                    className="text-left text-vault-text-muted uppercase"
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      padding: "10px 20px",
                      fontWeight: 500,
                    }}
                  >
                    Tag
                  </th>
                  <th
                    className="text-left text-vault-text-muted uppercase"
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      padding: "10px 20px",
                      fontWeight: 500,
                      minWidth: 80,
                    }}
                  >
                    Docs
                  </th>
                  <th
                    className="text-right text-vault-text-muted uppercase"
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      padding: "10px 20px",
                      fontWeight: 500,
                    }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSlice.map((entry, idx) => (
                  <tr
                    key={entry.tag}
                    className="hover:bg-white/[.025] transition-colors"
                    style={{
                      borderBottom:
                        idx < visibleSlice.length - 1
                          ? "1px solid #2E3448"
                          : "none",
                    }}
                  >
                    {/* Tag name */}
                    <td style={{ padding: "12px 20px" }}>
                      {renamingTag === entry.tag ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(entry.tag);
                            if (e.key === "Escape") setRenamingTag(null);
                          }}
                          className="bg-vault-input text-vault-text-primary focus:outline-none w-full"
                          style={{
                            border: "1px solid rgba(0,212,170,0.4)",
                            borderRadius: 6,
                            padding: "5px 10px",
                            fontSize: 14,
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="text-vault-text-primary"
                          style={{ fontSize: 14 }}
                        >
                          {entry.tag}
                        </span>
                      )}
                    </td>

                    {/* Doc count + bar */}
                    <td style={{ padding: "12px 20px", minWidth: 80 }}>
                      <span
                        className="text-vault-text-muted"
                        style={{ fontSize: 14 }}
                      >
                        {entry.count}
                      </span>
                      <div
                        style={{
                          marginTop: 4,
                          height: 4,
                          borderRadius: 3,
                          background: "rgba(0,212,170,0.35)",
                          width: `${Math.round((entry.count / maxCount) * 100)}%`,
                          minWidth: 4,
                        }}
                      />
                    </td>

                    {/* Actions */}
                    <td style={{ padding: "12px 20px", textAlign: "right" }}>
                      {renamingTag === entry.tag ? (
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => commitRename(entry.tag)}
                            className="text-vault-teal"
                            style={{
                              fontSize: 14,
                              fontWeight: 500,
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "2px 4px",
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setRenamingTag(null)}
                            className="text-vault-text-muted"
                            style={{
                              fontSize: 14,
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "2px 4px",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : deletingTag === entry.tag ? (
                        <div className="flex items-center gap-2 justify-end">
                          <span
                            className="text-vault-text-muted"
                            style={{ fontSize: 13 }}
                          >
                            Delete?
                          </span>
                          <button
                            onClick={() => confirmDelete(entry.tag)}
                            className="text-white"
                            style={{
                              fontSize: 12,
                              padding: "3px 10px",
                              borderRadius: 6,
                              background: "#E53E3E",
                              border: "none",
                              cursor: "pointer",
                            }}
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setDeletingTag(null)}
                            className="text-vault-text-muted bg-vault-elevated border border-vault-border"
                            style={{
                              fontSize: 12,
                              padding: "3px 10px",
                              borderRadius: 6,
                              cursor: "pointer",
                            }}
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 justify-end">
                          <IconButton
                            icon="ti-pencil"
                            tooltip="Rename tag"
                            hoverColor="teal"
                            onClick={() => startRename(entry.tag)}
                          />
                          <IconButton
                            icon="ti-trash"
                            tooltip="Delete tag"
                            hoverColor="danger"
                            onClick={() => {
                              setDeletingTag(entry.tag);
                              setRenamingTag(null);
                            }}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                <tr ref={sentinelRef} style={{ height: 0 }} />
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
