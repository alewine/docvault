"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  IconArrowsMaximize,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconLayoutGrid,
  IconMail,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconVolume,
} from "@tabler/icons-react";
import { getFileBadgeConfig } from "./fileTypeBadge";
import BACKEND_URL from "@/app/lib/backend";
import { apiGet, apiPost, apiPut, apiDelete } from "@/app/lib/api";
import { formatBytes } from "@/app/lib/formatBytes";
import { fetchCategoryNames, withSelectedCategory } from "@/app/lib/categories";
import type { UploadQueueHandle } from "./UploadButton";
import type { DocumentBase } from "@/app/lib/types";

const TEXT_BASED_EXTS = new Set([".txt", ".csv", ".docx", ".xlsx", ".pptx"]);
const TYPE_BADGE_COLORS: Record<string, string> = {
  ".txt": "#8A93A8",
  ".csv": "#00D4AA",
  ".docx": "#4A90D9",
  ".xlsx": "#27AE60",
  ".pptx": "#E67E22",
};

interface LogEntry {
  id: number;
  document_id: string;
  timestamp: string;
  event_type: string;
  pipeline_path: string | null;
  char_count: number | null;
  chunk_count: number | null;
  status: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
}

function accentColor(type: string): string {
  if (type === "job_complete") return "#22c55e";
  if (type === "index") return "#00D4AA";
  if (type === "embed") return "#f97316";
  if (type === "chunking") return "#eab308";
  if (["ocr_attempt", "ocr_complete", "ocr_error", "extract"].includes(type))
    return "#a78bfa";
  if (type === "text_saved") return "#38bdf8";
  return "var(--vault-btn-border)";
}

function EventBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    upload: "bg-blue-900/50 text-blue-300 border-blue-800",
    job_start: "bg-slate-800 text-slate-300 border-slate-700",
    file_detected: "bg-indigo-900/50 text-indigo-300 border-indigo-800",
    heic_conversion: "bg-violet-900/50 text-violet-300 border-violet-800",
    ocr_attempt: "bg-purple-900/50 text-purple-300 border-purple-800",
    table_extraction: "bg-fuchsia-900/50 text-fuchsia-300 border-fuchsia-800",
    ocr_complete: "bg-green-900/50 text-green-300 border-green-800",
    ocr_error: "bg-red-900/50 text-red-300 border-red-800",
    text_saved: "bg-teal-900/50 text-teal-300 border-teal-800",
    thumbnail: "bg-sky-900/50 text-sky-300 border-sky-800",
    chunking: "bg-amber-900/50 text-amber-300 border-amber-800",
    embed: "bg-orange-900/50 text-orange-300 border-orange-800",
    index: "bg-cyan-900/50 text-cyan-300 border-cyan-800",
    job_complete: "bg-green-900/70 text-green-200 border-green-700",
    reprocess: "bg-yellow-900/50 text-yellow-300 border-yellow-800",
    manual_edit: "bg-emerald-900/50 text-emerald-300 border-emerald-800",
  };
  const cls = colors[type] ?? "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span
      className={`text-[11px] font-medium px-[7px] py-[2px] rounded-[4px] border flex-shrink-0 ${cls}`}
    >
      {type.replace(/_/g, " ")}
    </span>
  );
}

function StatusBadge({
  status,
  fallbackSuccess,
}: {
  status: string | null;
  fallbackSuccess?: boolean;
}) {
  const base = {
    display: "inline-block" as const,
    marginTop: "1px",
    padding: "2px 7px",
    borderRadius: "4px",
    whiteSpace: "nowrap" as const,
    fontSize: "11px",
    fontWeight: 500,
  };
  if (status === "failure" || status === "error") {
    return (
      <span
        style={{
          ...base,
          color: "#f87171",
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.25)",
        }}
      >
        {status}
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span
        style={{
          ...base,
          color: "#fbbf24",
          background: "rgba(251,191,36,0.1)",
          border: "1px solid rgba(251,191,36,0.25)",
        }}
      >
        skipped
      </span>
    );
  }
  if (status === "success" || fallbackSuccess || status) {
    return (
      <span
        style={{
          ...base,
          color: "#4ade80",
          background: "rgba(34,197,94,0.1)",
          border: "1px solid rgba(34,197,94,0.25)",
        }}
      >
        {status ?? "success"}
      </span>
    );
  }
  return null;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <IconChevronDown
      size={13}
      style={{
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.2s ease",
      }}
    />
  );
}

function IconButton({
  onClick,
  href,
  download,
  title,
  danger = false,
  disabled = false,
  className = "",
  children,
}: {
  onClick?: () => void;
  href?: string;
  download?: string;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const base =
    "flex items-center justify-center w-8 h-8 rounded transition-colors bg-vault-btn border border-vault-btn-border";
  const colors = danger
    ? "text-red-400 hover:border-red-400/50"
    : "text-vault-text-muted hover:text-vault-text-primary hover:border-vault-border-hover";
  if (href) {
    return (
      <a
        href={href}
        download={download}
        title={title}
        className={`${base} ${colors} ${className}`}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${base} ${colors} disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function TagInput({
  tags,
  tagInput,
  onTagInputChange,
  tagInputRef,
  tagSuggestions,
  onAddTag,
  onRemoveTag,
  compact = false,
}: {
  tags: string[];
  tagInput: string;
  onTagInputChange: (v: string) => void;
  tagInputRef: React.RefObject<HTMLInputElement>;
  tagSuggestions: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  compact?: boolean;
}) {
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
          style={{
            background: "#1A3A38",
            border: "1px solid #2DD4BF",
            color: "#5EEAD4",
          }}
        >
          {tag}
          <button
            onClick={() => onRemoveTag(tag)}
            className="leading-none transition-colors text-vault-teal hover:text-vault-text-primary"
          >
            ×
          </button>
        </span>
      ))}

      <div className="relative">
        <input
          ref={tagInputRef}
          type="text"
          value={tagInput}
          onChange={(e) => onTagInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              e.preventDefault();
              onAddTag(tagInput.trim());
            }
          }}
          placeholder={compact ? "+ add tag" : "Add tag…"}
          className={`rounded-full border border-dashed border-vault-btn-border bg-transparent px-3 py-1 text-xs text-vault-text-muted focus:outline-none focus:border-vault-teal focus:text-vault-text-bright transition-all ${compact ? "" : "w-24 focus:w-36"}`}
        />
        {tagSuggestions.length > 0 && (
          <div
            className="absolute z-20 left-0 mt-1 min-w-max rounded-lg shadow-xl bg-vault-btn border border-vault-btn-border"
            style={{ background: "#252830" }}
          >
            {tagSuggestions.map((s) => (
              <button
                key={s}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAddTag(s);
                }}
                className="w-full text-left px-3 py-1.5 text-xs first:rounded-t-lg last:rounded-b-lg transition-colors text-vault-text-primary hover:bg-vault-surface"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

interface DocDetail extends DocumentBase {
  notes: string | null;
  processing_status: string;
  extracted_text: string | null;
  original_ext: string | null;
  file_size: number | null;
  source: string;
  email_sender: string | null;
}

export default function DocumentDetail({
  docId,
  onBack,
  onDeleted,
  uploadRef,
}: {
  docId: string;
  onBack: () => void;
  onDeleted: () => void;
  uploadRef?: React.RefObject<UploadQueueHandle>;
}) {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [titleGenerating, setTitleGenerating] = useState(false);
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [showText, setShowText] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessMsg, setReprocessMsg] = useState<string | null>(null);

  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [logLoaded, setLogLoaded] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logCopied, setLogCopied] = useState(false);
  const [hoveredPathId, setHoveredPathId] = useState<number | null>(null);

  const [mobileSummaryOpen, setMobileSummaryOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 767px)").matches
      : false,
  );

  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!previewOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewOpen]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { documentId } = (e as CustomEvent<{ documentId: string }>).detail;
      if (documentId !== docId) return;
      (async () => {
        try {
          const updated = await apiGet<DocDetail>(`/document/${docId}`);
          setDoc(updated);
          setTitle(updated.title ?? "");
          setCategory(updated.category ?? "");
          setNotes(updated.notes ?? "");
          setDocumentDate(updated.document_date ?? "");
          setTags(updated.tags);
          if (updated.extracted_text) setShowText(true);
        } catch {
          /* ignore */
        }
        await fetchLog();
        setShowLog(true);
      })();
    };
    window.addEventListener("docvault:document-processed", handler);
    return () =>
      window.removeEventListener("docvault:document-processed", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const names = await fetchCategoryNames();
        if (!cancelled) {
          setCategories(names);
        }
      } catch {
        if (!cancelled) {
          setCategories([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const fetchLog = async () => {
    setLogLoading(true);
    try {
      const data = await apiGet<{ entries?: LogEntry[] }>(
        `/document/${docId}/log`,
      );
      setLogEntries(data.entries ?? []);
      setLogLoaded(true);
    } catch {
      setLogEntries([]);
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet<DocDetail>(`/document/${docId}`);
        setDoc(data);
        setTitle(data.title ?? "");
        setCategory(data.category ?? "");
        setNotes(data.notes ?? "");
        setDocumentDate(data.document_date ?? "");
        setTags(data.tags);
        if (data.original_ext && TEXT_BASED_EXTS.has(data.original_ext)) {
          setShowText(true);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load document",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [docId]);

  useEffect(() => {
    if (!tagInput.trim()) {
      setTagSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const data = await apiGet<{ tags: string[] }>(
          `/tags?q=${encodeURIComponent(tagInput.trim())}`,
        );
        setTagSuggestions(data.tags.filter((s) => !tags.includes(s)));
      } catch {
        setTagSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [tagInput, tags]);

  const addTag = (tag: string) => {
    if (!tags.includes(tag)) setTags((prev) => [...prev, tag]);
    setTagInput("");
    setTagSuggestions([]);
  };

  const removeTag = (tag: string) =>
    setTags((prev) => prev.filter((t) => t !== tag));

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const updated = await apiPut<DocDetail>(`/document/${docId}`, {
        title: title.trim() || null,
        category: category.trim() || null,
        notes: notes.trim() || null,
        document_date: documentDate || null,
        tags,
      });
      setDoc(updated);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "Save failed");
      setTimeout(() => setSaveMsg(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    setReprocessMsg(null);
    setLogLoaded(false);
    try {
      const data = await apiPost<{ job_id: string }>(
        `/document/${docId}/reprocess`,
      );
      const filename = doc?.filename ?? docId;
      if (uploadRef?.current) {
        uploadRef.current.addReprocessJob(docId, filename, data.job_id);
        setReprocessing(false);
        return;
      }
      // Fallback: inline polling when no queue panel is available
      setReprocessMsg("Queued…");
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const statusRes = await fetch(`${BACKEND_URL}/status/${data.job_id}`);
        if (!statusRes.ok) break;
        const statusData = await statusRes.json();
        if (statusData.status === "complete") {
          const docRes = await fetch(`${BACKEND_URL}/document/${docId}`);
          if (docRes.ok) {
            const updated: DocDetail = await docRes.json();
            setDoc(updated);
            setTitle(updated.title ?? "");
            setCategory(updated.category ?? "");
            setNotes(updated.notes ?? "");
            setDocumentDate(updated.document_date ?? "");
            setTags(updated.tags);
            if (updated.extracted_text) setShowText(true);
          }
          await fetchLog();
          setShowLog(true);
          setReprocessMsg("Done");
          setTimeout(() => setReprocessMsg(null), 3000);
          return;
        } else if (statusData.status === "error") {
          throw new Error(statusData.error_message ?? "Processing failed");
        }
        setReprocessMsg("Processing…");
      }
      setReprocessMsg("Timed out");
      setTimeout(() => setReprocessMsg(null), 4000);
    } catch (err) {
      setReprocessMsg(err instanceof Error ? err.message : "Failed");
      setTimeout(() => setReprocessMsg(null), 4000);
    } finally {
      setReprocessing(false);
    }
  };

  const handleGenerateTitle = async () => {
    setTitleGenerating(true);
    try {
      const data = await apiPost<{ title?: string }>(
        `/document/${docId}/generate-title`,
      );
      setTitle(data.title ?? "");
    } catch (err) {
      console.error("Generate title failed:", err);
    } finally {
      setTitleGenerating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiDelete(`/document/${docId}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 bg-vault-bg">
        <p className="text-sm text-vault-text-muted">Loading…</p>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="p-8 space-y-4 bg-vault-bg">
        <button
          onClick={onBack}
          className="text-sm transition-colors text-vault-text-muted hover:text-vault-text-bright"
        >
          ← Library
        </button>
        <p style={{ color: "#F87171" }}>{error ?? "Document not found"}</p>
      </div>
    );
  }

  const badge = getFileBadgeConfig(doc.filename);
  const isAudio = doc.original_ext === ".mp3" || doc.original_ext === ".wav";

  const isDirty =
    category !== (doc.category ?? "") ||
    notes !== (doc.notes ?? "") ||
    documentDate !== (doc.document_date ?? "") ||
    tags.length !== doc.tags.length ||
    tags.some((t, i) => t !== doc.tags[i]);
  const showSavedState = saveMsg === "Saved";

  const reprocessMsgClass =
    reprocessMsg === "Done"
      ? "text-green-400"
      : reprocessMsg &&
          (reprocessMsg.includes("failed") ||
            reprocessMsg.includes("Failed") ||
            reprocessMsg.includes("Timed"))
        ? "text-red-400"
        : "text-vault-text-muted";

  return (
    <div className="text-vault-text-bright" style={{ background: "#1C1F26" }}>
      {/* ===== MOBILE LAYOUT ===== */}
      {isMobile && (
        <div className="flex flex-col">
          {/* Mobile nav bar */}
          <header
            className="sticky top-12 z-20 flex items-center justify-end px-4 flex-shrink-0 border-b border-vault-btn-border"
            style={{
              height: "48px",
              background: "#1C1F26",
            }}
          >
            <div className="flex items-center gap-2 flex-shrink-0">
              {reprocessMsg && (
                <span className={`text-xs ${reprocessMsgClass}`}>
                  {reprocessMsg}
                </span>
              )}

              {/* Download */}
              <IconButton
                href={`${BACKEND_URL}/original/${doc.document_id}`}
                download={doc.filename}
                title="Download original"
              >
                <IconDownload size={14} />
              </IconButton>

              {/* Reprocess */}
              <IconButton
                onClick={handleReprocess}
                disabled={reprocessing}
                title="Re-process document"
              >
                <IconRefresh
                  size={14}
                  className={reprocessing ? "animate-spin" : ""}
                />
              </IconButton>

              {/* Delete */}
              <IconButton
                onClick={() => setConfirmDelete(true)}
                title="Delete document"
                danger
              >
                <IconTrash size={14} />
              </IconButton>
            </div>
          </header>

          {/* Full-bleed thumbnail — tappable for non-audio files */}
          <div
            className="relative w-full flex-shrink-0"
            role={!isAudio ? "button" : undefined}
            onClick={() => {
              if (!isAudio) setPreviewOpen(true);
            }}
            style={{
              height: "180px",
              borderRadius: "12px 12px 0 0",
              overflow: "hidden",
              cursor: !isAudio ? "zoom-in" : "default",
            }}
          >
            {isAudio ? (
              <div
                className="w-full h-full flex items-center justify-center"
                style={{ background: "#111318" }}
              >
                <IconVolume size={52} stroke={1.5} color="#00D4AA" />
              </div>
            ) : doc.has_thumbnail ? (
              <Image
                src={`${BACKEND_URL}/thumbnail/${doc.document_id}`}
                alt={doc.filename}
                fill
                unoptimized
                className="w-full h-full object-cover"
                sizes="100vw"
              />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center"
                style={{ background: "#111318" }}
              >
                <span className="text-3xl font-mono text-vault-text-dim">
                  {doc.original_ext?.replace(".", "").toUpperCase() ?? "FILE"}
                </span>
              </div>
            )}

            {/* Category badge — bottom-left */}
            {doc.category && (
              <span
                className="absolute left-3 bottom-3 text-xs px-2.5 py-0.5 rounded-full"
                style={{
                  background: "#1A3A38",
                  color: "#5EEAD4",
                  border: "1px solid rgba(0,212,170,0.3)",
                }}
              >
                {doc.category}
              </span>
            )}

            {/* File type badge — bottom-right */}
            {doc.original_ext && (
              <span
                className="absolute right-3 bottom-3 text-xs font-bold px-2.5 py-0.5 rounded-full"
                style={{
                  background: "rgba(0,0,0,0.6)",
                  color: "#E2E8F0",
                }}
              >
                {doc.original_ext.replace(".", "").toUpperCase()}
              </span>
            )}
          </div>

          {/* Floating metadata card */}
          <div
            className="mx-3 relative"
            style={{
              marginTop: "-28px",
              zIndex: 10,
              background: "#1C2030",
              borderRadius: "0 0 12px 12px",
              borderTop: "1px solid rgba(0,212,170,0.6)",
              borderRight: "0.5px solid #2E3448",
              borderBottom: "0.5px solid #2E3448",
              borderLeft: "0.5px solid #2E3448",
              padding: "14px",
            }}
          >
            {/* Title row */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <p
                style={{
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "#E2E8F0",
                  lineHeight: "1.4",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {doc.title || doc.filename}
              </p>
              <div className="flex-shrink-0 flex items-center gap-1.5">
                {saveMsg && (
                  <span
                    className="text-[10px]"
                    style={{
                      color: saveMsg === "Saved" ? "#2DD4BF" : "#F87171",
                    }}
                  >
                    {saveMsg}
                  </span>
                )}
                {isDirty && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex-shrink-0 disabled:opacity-40"
                    style={{
                      border: "0.5px solid rgba(0,212,170,0.3)",
                      color: "#00D4AA",
                      background: "transparent",
                      borderRadius: "6px",
                      padding: "3px 8px",
                      fontSize: "10px",
                    }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
            </div>

            {/* Meta row — CATEGORY + DOC DATE */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              {/* CATEGORY tile */}
              <div
                className="relative"
                style={{
                  background: "#242838",
                  borderRadius: "8px",
                  padding: "8px",
                }}
              >
                <span
                  className="block mb-1 font-medium tracking-wide"
                  style={{ fontSize: "10px", color: "var(--vault-text-muted)" }}
                >
                  CATEGORY
                </span>
                <span
                  className="block truncate"
                  style={{ fontSize: "12px", color: "#E2E8F0" }}
                >
                  {category || "Uncategorized"}
                </span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    width: "100%",
                    height: "100%",
                    opacity: 0,
                    zIndex: 1,
                    cursor: "pointer",
                  }}
                >
                  <option value="">Uncategorized</option>
                  {withSelectedCategory(categories, category).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              {/* DOC DATE tile */}
              <div
                className="relative"
                style={{
                  background: "#242838",
                  borderRadius: "8px",
                  padding: "8px",
                }}
              >
                <span
                  className="block mb-1 font-medium tracking-wide text-vault-text-muted"
                  style={{ fontSize: "10px" }}
                >
                  DOC DATE
                </span>
                <span
                  className="block truncate text-vault-text-primary"
                  style={{ fontSize: "12px" }}
                >
                  {documentDate || "—"}
                </span>
                <input
                  type="date"
                  value={documentDate}
                  onChange={(e) => setDocumentDate(e.target.value)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    width: "100%",
                    height: "100%",
                    opacity: 0,
                    zIndex: 1,
                    cursor: "pointer",
                  }}
                />
              </div>
            </div>

            {/* Tags */}
            <div className="mb-3">
              <span
                className="block mb-2 font-medium tracking-wide text-vault-text-muted"
                style={{ fontSize: "10px" }}
              >
                TAGS
              </span>
              <div className="flex flex-wrap gap-1.5">
                <TagInput
                  tags={tags}
                  tagInput={tagInput}
                  onTagInputChange={setTagInput}
                  tagInputRef={tagInputRef}
                  tagSuggestions={tagSuggestions}
                  onAddTag={addTag}
                  onRemoveTag={removeTag}
                  compact
                />
              </div>
            </div>

            {/* Notes */}
            <div className="mb-3">
              <span
                className="block mb-1.5 font-medium tracking-wide text-vault-text-muted"
                style={{ fontSize: "10px" }}
              >
                NOTES
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes…"
                className="w-full focus:outline-none resize-none"
                style={{
                  background: "#2A2F42",
                  border: "none",
                  borderRadius: "8px",
                  color: "#E2E8F0",
                  fontSize: "12px",
                  padding: "8px 10px",
                  minHeight: "60px",
                }}
              />
            </div>

            {/* AI Summary accordion */}
            <div
              style={{
                background: "#242838",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <button
                onClick={() => setMobileSummaryOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3"
                style={{ height: "40px" }}
              >
                <IconSparkles
                  size={14}
                  style={{ color: "#00D4AA", flexShrink: 0 }}
                />
                <span
                  className="flex-1 text-left"
                  style={{ fontSize: "12px", color: "#E2E8F0" }}
                >
                  AI Summary
                </span>
                <span style={{ color: "var(--vault-text-muted)" }}>
                  <Chevron open={mobileSummaryOpen} />
                </span>
              </button>
              {mobileSummaryOpen && (
                <div style={{ padding: "0 12px 12px" }}>
                  {doc.summary ? (
                    <p
                      style={{ fontSize: "12px", lineHeight: "1.5" }}
                      className="text-vault-text-primary"
                    >
                      {doc.summary}
                    </p>
                  ) : (
                    <p
                      style={{ fontSize: "12px" }}
                      className="text-vault-text-muted"
                    >
                      No summary yet — use the Regenerate button in desktop view
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bottom spacing */}
          <div style={{ height: "24px" }} />
        </div>
      )}

      {/* ===== DESKTOP LAYOUT ===== */}
      {!isMobile && (
        <div className="flex flex-col">
          {/* Top bar */}
          <header
            className="sticky top-12 z-20"
            style={{
              background: "#1C1F26",
              borderBottom: "1px solid var(--vault-btn-border)",
            }}
          >
            <div className="w-full max-w-4xl mx-auto px-3 md:px-4 h-14 flex items-center gap-3">
              {/* Left: breadcrumb */}
              <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm transition-colors flex-shrink-0 group min-w-0"
              >
                <IconLayoutGrid size={15} style={{ color: "#2DD4BF" }} />
                <span className="text-vault-text-muted group-hover:text-vault-text-primary transition-colors">
                  Library
                </span>
                <span style={{ color: "#3A4055" }}>/</span>
                <span className="text-vault-text-primary font-medium truncate max-w-[240px]">
                  {doc.filename}
                </span>
                {doc.original_ext && TYPE_BADGE_COLORS[doc.original_ext] && (
                  <span
                    className="flex-shrink-0 text-xs font-bold px-1.5 py-0.5 rounded"
                    style={{
                      background: TYPE_BADGE_COLORS[doc.original_ext] + "22",
                      color: TYPE_BADGE_COLORS[doc.original_ext],
                      border: `1px solid ${TYPE_BADGE_COLORS[doc.original_ext]}55`,
                    }}
                  >
                    {doc.original_ext.replace(".", "").toUpperCase()}
                  </span>
                )}
                {doc.source === "email" && (
                  <span
                    className="flex-shrink-0 flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                    style={{
                      background: "rgba(139,92,246,0.12)",
                      color: "#a78bfa",
                      border: "1px solid rgba(139,92,246,0.3)",
                    }}
                    title={
                      doc.email_sender
                        ? `Received from ${doc.email_sender}`
                        : "Received via email"
                    }
                  >
                    <IconMail size={10} />
                    {doc.email_sender ?? "via email"}
                  </span>
                )}
              </button>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Right: action buttons */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {reprocessMsg && (
                  <span
                    className="text-xs"
                    style={{ color: reprocessMsgColor }}
                  >
                    {reprocessMsg}
                  </span>
                )}
                {saveMsg && saveMsg !== "Saved" && (
                  <span className="text-xs" style={{ color: "#F87171" }}>
                    {saveMsg}
                  </span>
                )}

                {/* Download */}
                <IconButton
                  href={`${BACKEND_URL}/original/${doc.document_id}`}
                  download={doc.filename}
                  title="Download original"
                >
                  <IconDownload size={14} />
                </IconButton>

                {/* Re-process */}
                <IconButton
                  onClick={handleReprocess}
                  disabled={reprocessing}
                  title="Re-process document"
                >
                  <IconRefresh
                    size={14}
                    className={reprocessing ? "animate-spin" : ""}
                  />
                </IconButton>

                {/* Delete */}
                <IconButton
                  onClick={() => setConfirmDelete(true)}
                  title="Delete document"
                  danger
                >
                  <IconTrash size={14} />
                </IconButton>

                {/* Save */}
                <button
                  onClick={handleSave}
                  disabled={saving || !isDirty}
                  className="rounded px-4 py-1.5 text-sm font-semibold transition-colors"
                  style={{
                    background:
                      isDirty || showSavedState ? "#2DD4BF" : "#252830",
                    color:
                      isDirty || showSavedState
                        ? "#1C1F26"
                        : "var(--vault-text-dim)",
                    border:
                      isDirty || showSavedState
                        ? "none"
                        : "1px solid var(--vault-btn-border)",
                    opacity: saving ? 0.4 : 1,
                    cursor: isDirty && !saving ? "pointer" : "not-allowed",
                  }}
                  onMouseEnter={(e) => {
                    if (isDirty && !saving)
                      (e.currentTarget as HTMLElement).style.background =
                        "#5EEAD4";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      isDirty || showSavedState ? "#2DD4BF" : "#252830";
                  }}
                >
                  {saving ? "Saving…" : showSavedState ? "Saved" : "Save"}
                </button>
              </div>
            </div>
          </header>

          {/* Main content */}
          <main className="w-full max-w-4xl mx-auto px-3 md:px-4 py-4">
            <div
              className="rounded-xl flex overflow-hidden"
              style={{ border: "1px solid var(--vault-btn-border)" }}
            >
              {/* Left column — 275px */}
              <div
                className="flex-shrink-0 p-4 flex flex-col gap-3"
                style={{ width: "275px", background: "#252830" }}
              >
                {/* Thumbnail / Audio player */}
                {isAudio ? (
                  <div
                    className="relative w-full rounded-lg overflow-hidden flex flex-col items-center justify-center gap-3 py-6"
                    style={{
                      aspectRatio: "8.5 / 11",
                      background: "#111318",
                      border: "1px solid var(--vault-btn-border)",
                    }}
                  >
                    <span
                      className={`absolute flex items-center gap-1 text-[11px] font-medium z-10 ${badge.colorClass}`}
                      style={{
                        top: 0,
                        left: 0,
                        borderRadius: "0 0 8px 0",
                        paddingTop: "2px",
                        paddingBottom: "2px",
                        paddingLeft: "8px",
                        paddingRight: "10px",
                      }}
                    >
                      <i
                        className={`ti ${badge.icon} text-[12px]`}
                        aria-hidden="true"
                      />
                      {badge.label}
                    </span>
                    <IconVolume size={52} stroke={1.5} color="#00D4AA" />
                    <audio
                      controls
                      src={`${BACKEND_URL}/audio/${doc.document_id}`}
                      className="w-full px-2"
                      style={{ marginTop: "8px" }}
                    />
                    {doc.category && (
                      <span
                        className="absolute inline-flex items-center text-xs z-10"
                        style={{
                          bottom: 0,
                          right: 0,
                          borderRadius: "8px 0 0 0",
                          paddingTop: "4px",
                          paddingBottom: "4px",
                          paddingRight: "14px",
                          paddingLeft: "16px",
                          background: "#1A3A38",
                          color: "#5EEAD4",
                        }}
                      >
                        {doc.category}
                      </span>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setPreviewOpen(true)}
                    className="w-full group focus:outline-none cursor-zoom-in"
                    title="Click to enlarge"
                  >
                    {doc.has_thumbnail ? (
                      <div
                        className="relative w-full overflow-hidden rounded-lg"
                        style={{
                          aspectRatio: "8.5 / 11",
                          border: "1px solid var(--vault-btn-border)",
                        }}
                      >
                        <Image
                          src={`${BACKEND_URL}/thumbnail/${doc.document_id}`}
                          alt={doc.filename}
                          fill
                          unoptimized
                          sizes="(max-width: 768px) 100vw, 40vw"
                          className="w-full h-full object-cover object-left-top"
                          style={{ background: "#1C1F26" }}
                        />
                        <div
                          className="absolute inset-0 rounded-lg transition-colors flex items-end justify-end p-2 opacity-0 group-hover:opacity-100"
                          style={{ background: "rgba(0,0,0,0.3)" }}
                        >
                          <span
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs"
                            style={{
                              background: "rgba(0,0,0,0.7)",
                              color: "var(--vault-text-bright)",
                            }}
                          >
                            <IconArrowsMaximize size={10} />
                            View
                          </span>
                        </div>
                        <span
                          className={`absolute flex items-center gap-1 text-[11px] font-medium z-10 ${badge.colorClass}`}
                          style={{
                            top: 0,
                            left: 0,
                            borderRadius: "0 0 8px 0",
                            paddingTop: "2px",
                            paddingBottom: "2px",
                            paddingLeft: "8px",
                            paddingRight: "10px",
                          }}
                        >
                          <i
                            className={`ti ${badge.icon} text-[12px]`}
                            aria-hidden="true"
                          />
                          {badge.label}
                        </span>
                        {doc.category && (
                          <span
                            className="absolute inline-flex items-center text-xs z-10"
                            style={{
                              bottom: 0,
                              right: 0,
                              borderRadius: "8px 0 0 0",
                              paddingTop: "4px",
                              paddingBottom: "4px",
                              paddingRight: "14px",
                              paddingLeft: "16px",
                              background: "#1A3A38",
                              color: "#5EEAD4",
                            }}
                          >
                            {doc.category}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div
                        className="relative w-full rounded-lg overflow-hidden flex items-center justify-center transition-colors"
                        style={{
                          aspectRatio: "8.5 / 11",
                          background: "#1C1F26",
                          border: "1px solid var(--vault-btn-border)",
                        }}
                      >
                        <span
                          className="text-3xl font-mono"
                          style={{ color: "var(--vault-text-dim)" }}
                        >
                          {doc.original_ext?.replace(".", "").toUpperCase() ??
                            "FILE"}
                        </span>
                        <span
                          className={`absolute flex items-center gap-1 text-[11px] font-medium z-10 ${badge.colorClass}`}
                          style={{
                            top: 0,
                            left: 0,
                            borderRadius: "0 0 8px 0",
                            paddingTop: "2px",
                            paddingBottom: "2px",
                            paddingLeft: "8px",
                            paddingRight: "10px",
                          }}
                        >
                          <i
                            className={`ti ${badge.icon} text-[12px]`}
                            aria-hidden="true"
                          />
                          {badge.label}
                        </span>
                        {doc.category && (
                          <span
                            className="absolute inline-flex items-center text-xs z-10"
                            style={{
                              bottom: 0,
                              right: 0,
                              borderRadius: "8px 0 0 0",
                              paddingTop: "4px",
                              paddingBottom: "4px",
                              paddingRight: "14px",
                              paddingLeft: "16px",
                              background: "#1A3A38",
                              color: "#5EEAD4",
                            }}
                          >
                            {doc.category}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                )}

                {/* Summary */}
                {doc.summary && (
                  <div className="space-y-1">
                    <p
                      className="text-xs font-semibold tracking-wide"
                      style={{ color: "#C4CBD8" }}
                    >
                      Summary
                    </p>
                    <p
                      className="text-xs leading-relaxed"
                      style={{ color: "var(--vault-text-muted)" }}
                    >
                      {doc.summary}
                    </p>
                  </div>
                )}

                {/* Upload date + file size */}
                <div className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-vault-text-primary">Uploaded</span>
                    <span className="text-vault-text-muted">
                      {doc.uploaded_at?.slice(0, 10)}
                    </span>
                  </div>
                  {doc.file_size != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-vault-text-primary">File Size</span>
                      <span className="text-vault-text-muted">
                        {formatBytes(doc.file_size)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Processing status — only if not complete */}
                {doc.processing_status !== "complete" && (
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{
                        background:
                          doc.processing_status === "error"
                            ? "#F87171"
                            : "#fbbf24",
                      }}
                    />
                    <span
                      className="text-xs font-medium"
                      style={{
                        color:
                          doc.processing_status === "error"
                            ? "#F87171"
                            : "#fbbf24",
                      }}
                    >
                      {doc.processing_status}
                    </span>
                  </div>
                )}
              </div>

              {/* Right column */}
              <div
                className="flex-1 min-w-0 p-5 space-y-4"
                style={{ background: "#1C1F26" }}
              >
                {/* Title */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      className="block text-xs font-medium uppercase tracking-wide"
                      style={{ color: "#C4CBD8" }}
                    >
                      Title
                    </label>
                    <button
                      onClick={handleGenerateTitle}
                      disabled={titleGenerating}
                      className="text-xs disabled:opacity-40 transition-colors text-vault-text-dim hover:text-vault-text-muted"
                    >
                      {titleGenerating ? "Generating…" : "Regenerate"}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={(e) => {
                      handleSave();
                      e.currentTarget.style.borderColor =
                        "var(--vault-btn-border)";
                    }}
                    placeholder="Add a title…"
                    maxLength={80}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
                    style={{
                      background: "#252830",
                      border: "1px solid var(--vault-btn-border)",
                      color: "var(--vault-text-bright)",
                    }}
                    onFocus={(e) =>
                      (e.currentTarget.style.borderColor = "#2DD4BF")
                    }
                  />
                </div>

                {/* Category + Document Date */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label
                      className="block text-xs font-medium uppercase tracking-wide"
                      style={{ color: "#C4CBD8" }}
                    >
                      Category
                    </label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
                      style={{
                        background: "#252830",
                        border: "1px solid var(--vault-btn-border)",
                        color: "var(--vault-text-bright)",
                      }}
                      onFocus={(e) =>
                        (e.currentTarget.style.borderColor = "#2DD4BF")
                      }
                      onBlur={(e) =>
                        (e.currentTarget.style.borderColor =
                          "var(--vault-btn-border)")
                      }
                    >
                      <option value="">Uncategorized</option>
                      {withSelectedCategory(categories, category).map(
                        (option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="block text-xs font-medium uppercase tracking-wide"
                      style={{ color: "#C4CBD8" }}
                    >
                      Document date
                    </label>
                    <input
                      type="date"
                      value={documentDate}
                      onChange={(e) => setDocumentDate(e.target.value)}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none [color-scheme:dark] transition-colors"
                      style={{
                        background: "#252830",
                        border: "1px solid var(--vault-btn-border)",
                        color: "var(--vault-text-bright)",
                      }}
                      onFocus={(e) =>
                        (e.currentTarget.style.borderColor = "#2DD4BF")
                      }
                      onBlur={(e) =>
                        (e.currentTarget.style.borderColor =
                          "var(--vault-btn-border)")
                      }
                    />
                  </div>
                </div>

                {/* Tags */}
                <div className="space-y-2">
                  <label
                    className="block text-xs font-medium uppercase tracking-wide"
                    style={{ color: "var(--vault-text-muted)" }}
                  >
                    Tags
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <TagInput
                      tags={tags}
                      tagInput={tagInput}
                      onTagInputChange={setTagInput}
                      tagInputRef={tagInputRef}
                      tagSuggestions={tagSuggestions}
                      onAddTag={addTag}
                      onRemoveTag={removeTag}
                    />
                  </div>
                </div>

                {/* Notes */}
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium uppercase tracking-wide"
                    style={{ color: "#C4CBD8" }}
                  >
                    Notes
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Add notes…"
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none transition-colors"
                    style={{
                      background: "#252830",
                      border: "1px solid var(--vault-btn-border)",
                      color: "var(--vault-text-bright)",
                      minHeight: "60px",
                    }}
                    onFocus={(e) =>
                      (e.currentTarget.style.borderColor = "#2DD4BF")
                    }
                    onBlur={(e) =>
                      (e.currentTarget.style.borderColor =
                        "var(--vault-btn-border)")
                    }
                  />
                </div>

                {/* Extracted text collapsible — hidden for audio files */}
                {!isAudio && (
                  <div
                    className="rounded-lg overflow-hidden"
                    style={{
                      background: "#252830",
                      border: "1px solid var(--vault-btn-border)",
                    }}
                  >
                    <div
                      className={`flex items-center justify-between px-3 h-10 transition-colors text-vault-text-muted ${doc.extracted_text ? "cursor-pointer hover:text-vault-text-primary" : "cursor-default opacity-40"}`}
                      onClick={() =>
                        doc.extracted_text && setShowText((v) => !v)
                      }
                    >
                      <span
                        className="flex-1 text-left text-xs"
                        style={{ color: "inherit" }}
                      >
                        Extracted Text
                      </span>
                      <div
                        className="flex items-center gap-2"
                        style={{ color: "var(--vault-text-muted)" }}
                      >
                        {doc.extracted_text && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(
                                doc.extracted_text ?? "",
                              );
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            }}
                            title="Copy extracted text"
                            className="transition-colors text-vault-text-dim hover:text-vault-text-muted"
                          >
                            {copied ? (
                              <span
                                className="text-xs"
                                style={{ color: "#4ade80" }}
                              >
                                Copied!
                              </span>
                            ) : (
                              <IconCopy size={12} />
                            )}
                          </button>
                        )}
                        <span style={{ color: "var(--vault-text-muted)" }}>
                          <Chevron open={showText && !!doc.extracted_text} />
                        </span>
                      </div>
                    </div>
                    <div
                      className={`overflow-hidden transition-[max-height] duration-300 ease-in-out ${showText && doc.extracted_text ? "max-h-48" : "max-h-0"}`}
                    >
                      <div
                        className="max-h-48 overflow-y-auto"
                        style={{
                          borderTop: "1px solid var(--vault-btn-border)",
                        }}
                      >
                        <pre
                          className="px-3 py-3 text-xs whitespace-pre-wrap break-words"
                          style={{ color: "var(--vault-text-muted)" }}
                        >
                          {doc.extracted_text}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}

                {/* Processing history collapsible */}
                <div
                  className="rounded-lg overflow-hidden"
                  style={{
                    background: "#252830",
                    border: "1px solid var(--vault-btn-border)",
                  }}
                >
                  <div
                    className="flex items-center justify-between px-3 h-10 cursor-pointer transition-colors text-vault-text-muted hover:text-vault-text-primary"
                    onClick={() => {
                      const next = !showLog;
                      setShowLog(next);
                      if (next && !logLoaded) fetchLog();
                    }}
                  >
                    <span
                      className="flex-1 text-left text-xs"
                      style={{ color: "inherit" }}
                    >
                      Processing History
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const text = [...logEntries]
                            .reverse()
                            .map((e) => {
                              const parts: string[] = [
                                new Date(
                                  e.timestamp.replace(" ", "T") + "Z",
                                ).toLocaleString(),
                                e.event_type,
                              ];
                              if (e.pipeline_path)
                                parts.push(`[${e.pipeline_path}]`);
                              if (e.status) parts.push(`(${e.status})`);
                              if (e.char_count !== null)
                                parts.push(
                                  `${e.char_count.toLocaleString()} chars`,
                                );
                              if (e.chunk_count !== null)
                                parts.push(`${e.chunk_count} chunks`);
                              if (e.message) parts.push(e.message);
                              return parts.join("  ");
                            })
                            .join("\n");
                          navigator.clipboard.writeText(text);
                          setLogCopied(true);
                          setTimeout(() => setLogCopied(false), 2000);
                        }}
                        title="Copy processing history"
                        className="transition-colors text-vault-text-dim hover:text-vault-text-muted"
                      >
                        {logCopied ? (
                          <span
                            className="text-xs"
                            style={{ color: "#4ade80" }}
                          >
                            Copied!
                          </span>
                        ) : (
                          <IconCopy size={12} />
                        )}
                      </button>
                      <span style={{ color: "var(--vault-text-muted)" }}>
                        <Chevron open={showLog} />
                      </span>
                    </div>
                  </div>
                  <div
                    className={`overflow-hidden transition-[max-height] duration-300 ease-in-out ${showLog ? "max-h-96" : "max-h-0"}`}
                  >
                    <div
                      className="max-h-96 overflow-y-auto"
                      style={{ borderTop: "1px solid var(--vault-btn-border)" }}
                    >
                      {logLoading ? (
                        <p
                          className="text-xs px-3 py-3"
                          style={{ color: "var(--vault-text-dim)" }}
                        >
                          Loading…
                        </p>
                      ) : logEntries.length === 0 ? (
                        <p
                          className="text-xs px-3 py-3"
                          style={{ color: "var(--vault-text-dim)" }}
                        >
                          No log entries
                        </p>
                      ) : (
                        <div>
                          {[...logEntries].reverse().map((entry, idx, arr) => {
                            const isLast = idx === arr.length - 1;

                            return (
                              <div
                                key={entry.id}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "60px auto 1fr auto",
                                  alignItems: "start",
                                  columnGap: "8px",
                                  padding: "7px 16px",
                                  borderLeft: `3px solid ${accentColor(entry.event_type)}`,
                                  borderBottom: isLast
                                    ? "none"
                                    : "1px solid var(--vault-btn-border)",
                                }}
                              >
                                {/* Timestamp */}
                                <span
                                  className="text-xs font-mono"
                                  style={{
                                    color: "var(--vault-text-dim)",
                                    paddingTop: "3px",
                                  }}
                                >
                                  {new Date(
                                    entry.timestamp.replace(" ", "T") + "Z",
                                  ).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>

                                {/* Stage tag */}
                                <EventBadge type={entry.event_type} />

                                {/* Message + path */}
                                <div
                                  className="flex flex-col min-w-0"
                                  style={{ paddingTop: "2px" }}
                                >
                                  {entry.message && (
                                    <p
                                      className="text-xs truncate"
                                      style={{
                                        color: "var(--vault-text-muted)",
                                      }}
                                    >
                                      {entry.message}
                                    </p>
                                  )}
                                  {entry.pipeline_path && (
                                    <div
                                      className="relative"
                                      onMouseEnter={() =>
                                        setHoveredPathId(entry.id)
                                      }
                                      onMouseLeave={() =>
                                        setHoveredPathId(null)
                                      }
                                    >
                                      <p
                                        className="text-[11px] font-mono truncate"
                                        style={{ color: "#5a6480" }}
                                      >
                                        {entry.pipeline_path}
                                      </p>
                                      {hoveredPathId === entry.id && (
                                        <div
                                          className="absolute pointer-events-none shadow-lg"
                                          style={{
                                            top: "calc(100% + 4px)",
                                            left: 0,
                                            background: "#111318",
                                            border: "1px solid #3A4055",
                                            borderRadius: "6px",
                                            padding: "6px 10px",
                                            fontSize: "11px",
                                            fontFamily: "monospace",
                                            color: "var(--vault-text-muted)",
                                            whiteSpace: "nowrap",
                                            zIndex: 10,
                                          }}
                                        >
                                          {entry.pipeline_path}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Status badge */}
                                <StatusBadge
                                  status={entry.status}
                                  fallbackSuccess={
                                    doc.processing_status === "complete"
                                  }
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      )}

      {/* Thumbnail modal — shared */}
      {previewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto pointer-events-auto"
          style={{ touchAction: "pan-y pinch-zoom" }}
        >
          <div
            className="absolute inset-0 pointer-events-auto touch-none"
            style={{ background: "rgba(0,0,0,0.75)" }}
            onClick={() => setPreviewOpen(false)}
          />
          <div
            className="relative z-10"
            style={{ touchAction: "pinch-zoom" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewOpen(false)}
              className="absolute top-2 right-2 z-10 flex items-center justify-center w-8 h-8 rounded-full text-lg leading-none transition-colors text-vault-text-muted hover:text-vault-text-primary border border-vault-btn-border"
              style={{ background: "rgba(0,0,0,0.6)" }}
              title="Close"
            >
              ×
            </button>
            {doc.has_thumbnail ? (
              <Image
                src={`${BACKEND_URL}/thumbnail/${doc.document_id}`}
                alt={doc.filename}
                width={1200}
                height={1600}
                unoptimized
                className="rounded-xl object-contain"
                style={{ maxWidth: "90vw", maxHeight: "90vh" }}
              />
            ) : (
              <div
                className="rounded-xl flex items-center justify-center"
                style={{
                  width: "400px",
                  height: "500px",
                  background: "#252830",
                  border: "1px solid var(--vault-btn-border)",
                }}
              >
                <span className="text-5xl font-mono text-vault-text-dim">
                  {doc.original_ext?.replace(".", "").toUpperCase() ?? "FILE"}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation modal — shared */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/70">
          <div
            className="rounded-xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-2xl"
            style={{
              background: "#252830",
              border: "1px solid rgba(248,113,113,0.3)",
            }}
          >
            <h3 className="text-sm font-medium text-vault-text-bright">
              Delete document?
            </h3>
            <p className="text-sm text-vault-text-muted">
              <span className="text-vault-text-bright">{doc.filename}</span>{" "}
              will be permanently removed. This cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-medium text-white bg-red-700 hover:bg-red-600 disabled:opacity-40 transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 rounded-lg px-3 py-2 text-sm transition-colors text-vault-text-muted hover:text-vault-text-primary border border-vault-btn-border hover:border-vault-text-dim"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
