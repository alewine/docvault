"use client";

import React, {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  IconClock,
  IconLoader2,
  IconSearch,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";
import BACKEND_URL from "@/app/lib/backend";
import { apiGet, apiPost, apiDelete } from "@/app/lib/api";
import { fetchCategoryNames, withSelectedCategory } from "@/app/lib/categories";
import type { UploadQueueHandle } from "./UploadButton";
import type { DocumentBase, FailedJob } from "@/app/lib/types";

const SESSION_KEY = "docvault:library:filters";

interface LibraryDoc extends DocumentBase {
  source: string;
  email_sender: string | null;
  starred: boolean;
  processing_status: string;
}

interface LibraryResponse {
  documents: LibraryDoc[];
  total: number;
  page: number;
  page_size: number;
}

interface SearchResult extends DocumentBase {
  excerpt: string;
  score: number;
  match_type?: string;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
}

function AudioIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#00D4AA"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function resultToDoc(r: SearchResult, starred = false): LibraryDoc {
  return {
    document_id: r.document_id,
    filename: r.filename,
    title: r.title,
    category: r.category,
    tags: r.tags,
    document_date: r.document_date,
    uploaded_at: r.uploaded_at,
    summary: r.summary,
    has_thumbnail: r.has_thumbnail,
    source: "upload",
    email_sender: null,
    starred,
    processing_status: "complete",
  };
}

const CATEGORY_BADGE_STYLES: Record<
  string,
  { bg: string; color: string; border: string }
> = {
  Audio: {
    bg: "rgba(109,40,217,0.82)",
    color: "#EDE9FE",
    border: "rgba(139,92,246,0.6)",
  },
  Education: {
    bg: "rgba(29,78,216,0.82)",
    color: "#DBEAFE",
    border: "rgba(59,130,246,0.6)",
  },
  Financial: {
    bg: "rgba(21,128,61,0.82)",
    color: "#DCFCE7",
    border: "rgba(34,197,94,0.6)",
  },
  Home: {
    bg: "rgba(194,65,12,0.82)",
    color: "#FFEDD5",
    border: "rgba(251,146,60,0.6)",
  },
  Insurance: {
    bg: "rgba(15,118,110,0.82)",
    color: "#CCFBF1",
    border: "rgba(20,184,166,0.6)",
  },
  Legal: {
    bg: "rgba(185,28,28,0.82)",
    color: "#FEE2E2",
    border: "rgba(239,68,68,0.6)",
  },
  Medical: {
    bg: "rgba(157,23,77,0.82)",
    color: "#FCE7F3",
    border: "rgba(236,72,153,0.6)",
  },
  Other: {
    bg: "rgba(51,65,85,0.82)",
    color: "#E2E8F0",
    border: "rgba(100,116,139,0.6)",
  },
};

const DEFAULT_CATEGORY_STYLE = {
  bg: "rgba(51,65,85,0.82)",
  color: "#E2E8F0",
  border: "rgba(100,116,139,0.6)",
};

function DocCard({
  doc,
  onClick,
  onDelete,
  onStar,
  viewMode,
}: {
  doc: LibraryDoc;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onStar: (e: React.MouseEvent) => void;
  viewMode: "grid" | "list";
}) {
  const ext = doc.filename.split(".").pop()?.toUpperCase() ?? "FILE";
  const isAudio = ext === "MP3" || ext === "WAV";
  const displayDate = doc.document_date ?? doc.uploaded_at?.slice(0, 10);
  const isInProgress =
    doc.processing_status === "queued" ||
    doc.processing_status === "processing";

  if (viewMode === "list") {
    return (
      <div
        className={`relative flex items-stretch gap-3 rounded-lg bg-gray-900 overflow-hidden transition-colors group min-h-[80px] max-h-[80px] ${isInProgress ? "opacity-40 pointer-events-none" : "cursor-pointer"}`}
        style={{ border: "1.5px solid rgba(0, 212, 170, 0.33)" }}
        onClick={isInProgress ? undefined : onClick}
      >
        {isInProgress && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 bg-black/50">
            {doc.processing_status === "processing" ? (
              <IconLoader2
                size={20}
                className="animate-spin"
                style={{ color: "#00D4AA" }}
              />
            ) : (
              <IconClock size={20} style={{ color: "#00D4AA" }} />
            )}
            <span
              className="text-xs"
              style={{ color: "var(--vault-text-bright)" }}
            >
              {doc.processing_status === "processing"
                ? "Processing…"
                : "Queued"}
            </span>
          </div>
        )}
        <div className="relative flex-shrink-0 self-stretch overflow-hidden border-r border-vault-border">
          {isAudio ? (
            <div
              className="w-[110px] h-full flex items-center justify-center"
              style={{ background: "#111318" }}
            >
              <AudioIcon size={22} />
            </div>
          ) : doc.has_thumbnail ? (
            <Image
              src={`${BACKEND_URL}/thumbnail/${doc.document_id}`}
              alt={doc.filename}
              width={110}
              height={110}
              unoptimized
              className="w-[110px] h-full object-cover object-top bg-gray-800 opacity-70"
            />
          ) : (
            <div className="w-[110px] h-full bg-gray-800 flex items-center justify-center">
              <span className="text-[10px] text-gray-600 font-mono">{ext}</span>
            </div>
          )}
          {doc.category &&
            (() => {
              const cs =
                CATEGORY_BADGE_STYLES[doc.category] ?? DEFAULT_CATEGORY_STYLE;
              return (
                <span
                  className="absolute flex items-center text-[10px] font-medium z-10 truncate max-w-[90px]"
                  style={{
                    top: 0,
                    left: 0,
                    borderRadius: "0 0 8px 0",
                    paddingTop: "2px",
                    paddingBottom: "2px",
                    paddingLeft: "8px",
                    paddingRight: "10px",
                    background: cs.bg,
                    color: cs.color,
                    border: `1px solid ${cs.border}`,
                    borderTop: "none",
                    borderLeft: "none",
                  }}
                >
                  {doc.category.toUpperCase()}
                </span>
              );
            })()}
        </div>
        <div className="absolute top-1.5 right-1.5 z-10 flex gap-1">
          <button
            onClick={onStar}
            title={doc.starred ? "Unstar document" : "Star document"}
            className={`flex items-center justify-center w-7 h-7 rounded transition-opacity ${doc.starred ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            style={{
              color: doc.starred ? "#F6AD55" : "var(--vault-text-muted)",
            }}
          >
            {doc.starred ? (
              <IconStarFilled size={14} />
            ) : (
              <IconStar size={14} />
            )}
          </button>
          <button
            onClick={onDelete}
            title="Delete document"
            className="flex items-center justify-center w-7 h-7 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: "#F87171" }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-w-0 py-2.5 pr-3 flex flex-col">
          <div>
            {doc.title ? (
              <>
                <p className="text-sm font-medium text-white truncate">
                  {doc.title}
                </p>
                <p
                  className="text-xs font-mono truncate"
                  style={{ color: "var(--vault-text-dim)" }}
                >
                  {doc.filename}
                </p>
              </>
            ) : (
              <p className="text-sm text-white truncate">{doc.filename}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-1 mt-1">
            {doc.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-gray-800 border border-gray-700 px-2 py-0.5 text-xs text-gray-400"
              >
                {tag}
              </span>
            ))}
            {doc.source === "email" && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                style={{
                  background: "rgba(139,92,246,0.12)",
                  border: "1px solid rgba(139,92,246,0.3)",
                  color: "#a78bfa",
                }}
                title={
                  doc.email_sender ? `From ${doc.email_sender}` : "Via email"
                }
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="20" height="16" x="2" y="4" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
                email
              </span>
            )}
          </div>
          {isAudio && (
            <div className="mt-auto pr-12" onClick={(e) => e.stopPropagation()}>
              <audio
                controls
                src={`${BACKEND_URL}/audio/${doc.document_id}`}
                className="w-full"
                style={{ height: "28px" }}
              />
            </div>
          )}
        </div>
        {displayDate && (
          <span
            className="absolute inline-flex items-center text-[10px] text-gray-400"
            style={{
              bottom: 0,
              left: 0,
              borderRadius: "0 8px 0 0",
              background: "rgba(17,20,28,0.65)",
              paddingTop: "2px",
              paddingBottom: "2px",
              paddingLeft: "14px",
              paddingRight: "16px",
            }}
          >
            {displayDate}
          </span>
        )}
        <span
          className="absolute flex items-center text-[10px] font-medium z-10"
          style={{
            bottom: 0,
            right: 0,
            borderRadius: "8px 0 0 0",
            paddingTop: "2px",
            paddingBottom: "2px",
            paddingRight: "10px",
            paddingLeft: "8px",
            background: "rgba(30,64,175,0.85)",
            color: "#BFDBFE",
            border: "1px solid rgba(59,130,246,0.5)",
          }}
        >
          {ext}
        </span>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div
            className={`relative rounded-xl bg-gray-900 overflow-hidden transition-colors group flex flex-col ${isInProgress ? "opacity-40 pointer-events-none" : "cursor-pointer hover:border-gray-600"}`}
            style={{
              border: "1.5px solid rgba(0, 212, 170, 0.33)",
              ...(isAudio ? {} : { height: "216px" }),
            }}
            onClick={isInProgress ? undefined : onClick}
          >
            {isInProgress && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 bg-black/50">
                {doc.processing_status === "processing" ? (
                  <IconLoader2
                    size={24}
                    className="animate-spin"
                    style={{ color: "#00D4AA" }}
                  />
                ) : (
                  <IconClock size={24} style={{ color: "#00D4AA" }} />
                )}
                <span
                  className="text-xs"
                  style={{ color: "var(--vault-text-bright)" }}
                >
                  {doc.processing_status === "processing"
                    ? "Processing…"
                    : "Queued"}
                </span>
              </div>
            )}
            <div className="absolute top-1.5 right-1.5 z-10 flex gap-1">
              <button
                onClick={onStar}
                title={doc.starred ? "Unstar document" : "Star document"}
                className={`flex items-center justify-center w-7 h-7 rounded transition-opacity ${doc.starred ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                style={{
                  background: "rgba(17,20,28,0.75)",
                  color: doc.starred ? "#F6AD55" : "var(--vault-text-muted)",
                }}
              >
                {doc.starred ? (
                  <IconStarFilled size={13} />
                ) : (
                  <IconStar size={13} />
                )}
              </button>
              <button
                onClick={onDelete}
                title="Delete document"
                className="flex items-center justify-center w-7 h-7 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: "rgba(17,20,28,0.75)", color: "#F87171" }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
            {doc.category &&
              (() => {
                const cs =
                  CATEGORY_BADGE_STYLES[doc.category] ?? DEFAULT_CATEGORY_STYLE;
                return (
                  <span
                    className="absolute flex items-center text-[10px] font-medium z-10"
                    style={{
                      top: 0,
                      left: 0,
                      borderRadius: "0 0 8px 0",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      paddingLeft: "8px",
                      paddingRight: "10px",
                      background: cs.bg,
                      color: cs.color,
                      border: `1px solid ${cs.border}`,
                      borderTop: "none",
                      borderLeft: "none",
                    }}
                  >
                    {doc.category.toUpperCase()}
                  </span>
                );
              })()}
            <div className="w-full h-[110px] flex-shrink-0 bg-gray-800 flex items-center justify-center overflow-hidden border-b border-gray-700">
              {isAudio ? (
                <div
                  className="w-full h-full flex items-center justify-center"
                  style={{ background: "#111318" }}
                >
                  <AudioIcon size={36} />
                </div>
              ) : doc.has_thumbnail ? (
                <Image
                  src={`${BACKEND_URL}/thumbnail/${doc.document_id}`}
                  alt={doc.filename}
                  width={110}
                  height={110}
                  unoptimized
                  className="w-full h-full object-cover object-top opacity-70"
                />
              ) : (
                <span className="text-2xl font-mono text-gray-600">{ext}</span>
              )}
            </div>
            <div className="px-3 pt-2 pb-1.5 flex flex-col flex-1 min-h-0">
              {doc.title ? (
                <>
                  <p className="text-sm font-medium text-white truncate">
                    {doc.title}
                  </p>
                  <p
                    className="text-xs font-mono truncate"
                    style={{ color: "var(--vault-text-dim)" }}
                  >
                    {doc.filename}
                  </p>
                </>
              ) : (
                <p className="text-sm text-white truncate">{doc.filename}</p>
              )}
              <div
                className="flex flex-wrap gap-1 mt-1 overflow-hidden"
                style={{ maxHeight: "18px" }}
              >
                {doc.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full bg-gray-800 border border-gray-700 px-1.5 py-px text-[10px] text-gray-400"
                  >
                    {tag}
                  </span>
                ))}
                {doc.source === "email" && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px]"
                    style={{
                      background: "rgba(139,92,246,0.12)",
                      border: "1px solid rgba(139,92,246,0.3)",
                      color: "#a78bfa",
                    }}
                    title={
                      doc.email_sender
                        ? `From ${doc.email_sender}`
                        : "Via email"
                    }
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    email
                  </span>
                )}
              </div>
              {isAudio && (
                <div className="pb-2 pt-1" onClick={(e) => e.stopPropagation()}>
                  <audio
                    controls
                    src={`${BACKEND_URL}/audio/${doc.document_id}`}
                    className="w-full"
                    style={{ height: "28px" }}
                  />
                </div>
              )}
              <p className="text-[10px] text-gray-400">{displayDate ?? "—"}</p>
            </div>
            <span
              className="absolute flex items-center text-[10px] font-medium z-10"
              style={{
                bottom: 0,
                right: 0,
                borderRadius: "8px 0 0 0",
                paddingTop: "2px",
                paddingBottom: "2px",
                paddingLeft: "8px",
                paddingRight: "10px",
                background: "rgba(30,64,175,0.85)",
                color: "#BFDBFE",
                border: "1px solid rgba(59,130,246,0.5)",
              }}
            >
              {ext}
            </span>
          </div>
        </Tooltip.Trigger>
        {doc.summary && (
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={8}
              className="z-50 bg-vault-elevated border border-vault-border-hover rounded-xl shadow-xl p-4 max-w-[280px] text-xs text-vault-text-primary leading-relaxed"
            >
              {doc.summary}
              <Tooltip.Arrow style={{ fill: "#2E3448" }} />
            </Tooltip.Content>
          </Tooltip.Portal>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function FailedJobsSection({
  jobs,
  onRetry,
  onCancel,
}: {
  jobs: FailedJob[];
  onRetry: (id: string) => void;
  onCancel: (id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({});

  const handleCancel = async (id: string) => {
    setCancellingIds((prev) => new Set(prev).add(id));
    setCancelErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await onCancel(id);
    } catch (err) {
      setCancelErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Delete failed",
      }));
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="rounded-xl border border-red-900/60 bg-red-950/30 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="text-sm font-medium text-red-400">
          {jobs.length} failed document{jobs.length !== 1 ? "s" : ""}
        </span>
        <span className="text-red-700 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <ul className="border-t border-red-900/40 divide-y divide-red-900/30">
          {jobs.map((job) => {
            const busy = cancellingIds.has(job.document_id);
            return (
              <li
                key={job.document_id}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <span className="text-red-400 text-sm">✗</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300 truncate">
                    {job.filename}
                  </p>
                  {cancelErrors[job.document_id] ? (
                    <p className="text-xs text-red-400 truncate">
                      {cancelErrors[job.document_id]}
                    </p>
                  ) : job.error_message ? (
                    <p className="text-xs text-red-400 truncate">
                      {job.error_message}
                    </p>
                  ) : null}
                </div>
                <button
                  disabled={busy}
                  onClick={() => onRetry(job.document_id)}
                  className="flex-shrink-0 text-xs px-2 py-1 rounded border border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Retry
                </button>
                <button
                  disabled={busy}
                  onClick={() => handleCancel(job.document_id)}
                  className="flex-shrink-0 text-xs px-2 py-1 rounded border border-gray-800 bg-transparent text-gray-500 hover:border-gray-600 hover:text-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? "…" : "Cancel"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function loadFilters() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveFilters(filters: object) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(filters));
  } catch {
    /* storage unavailable */
  }
}

function defaultViewMode(): "grid" | "list" {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
  ) {
    return "list";
  }
  return "grid";
}

export default function LibraryView({
  onOpenDocument,
  uploadRef,
}: {
  onOpenDocument: (id: string) => void;
  uploadRef?: React.RefObject<UploadQueueHandle>;
}) {
  const saved = loadFilters();

  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">(defaultViewMode);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [pendingDelete, setPendingDelete] = useState<LibraryDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pendingDeleteIdRef = useRef<string | null>(null);

  const [category, setCategory] = useState<string>(saved?.category ?? "");
  const [categories, setCategories] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>(
    saved?.selectedTags ?? [],
  );
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<string>(saved?.sortBy ?? "uploaded_at");
  const [sortDir, setSortDir] = useState<string>(saved?.sortDir ?? "desc");
  const [starredOnly, setStarredOnly] = useState<boolean>(
    saved?.starredOnly ?? false,
  );
  const [showMedical, setShowMedical] = useState<boolean>(
    saved?.showMedical ?? false,
  );
  const [medicalCount, setMedicalCount] = useState<number | null>(null);

  // Per-document starred state, seeded from server and updated optimistically
  const [starredById, setStarredById] = useState<Record<string, boolean>>({});

  // Infinite scroll
  const pageRef = useRef(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const isFetching = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [fetchKey, setFetchKey] = useState(0);

  // Search state
  const [searchInput, setSearchInput] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null,
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const isSearchMode = activeSearch.length > 0;

  useEffect(() => {
    saveFilters({
      category,
      selectedTags,
      sortBy,
      sortDir,
      starredOnly,
      showMedical,
    });
  }, [category, selectedTags, sortBy, sortDir, starredOnly, showMedical]);

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

  useEffect(() => {
    let cancelled = false;
    pageRef.current = 1;
    setDocs([]);
    setHasMore(true);
    setLoading(true);
    setError(null);
    isFetching.current = true;

    (async () => {
      try {
        const params = new URLSearchParams();
        if (category) params.set("category", category);
        if (!showMedical) params.set("exclude_category", "Medical");
        selectedTags.forEach((t) => params.append("tags", t));
        params.set("sort_by", sortBy);
        params.set("sort_dir", sortDir);
        params.set("page", "1");
        params.set("page_size", "24");
        if (starredOnly) params.set("starred", "true");

        const data = await apiGet<LibraryResponse>(`/documents?${params}`);

        if (!cancelled) {
          setDocs(data.documents);
          setTotal(data.total);
          setHasMore(data.documents.length === 24);
          pageRef.current = 2;
          setStarredById((prev) => {
            const next = { ...prev };
            data.documents.forEach((d) => {
              next[d.document_id] = d.starred;
            });
            return next;
          });
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load documents",
          );
      } finally {
        if (!cancelled) setLoading(false);
        isFetching.current = false;
      }
    })();

    return () => {
      cancelled = true;
      isFetching.current = false;
    };
  }, [
    category,
    selectedTags,
    sortBy,
    sortDir,
    starredOnly,
    showMedical,
    fetchKey,
  ]);

  // Count of medical documents matching the current filters (independent of
  // the showMedical toggle). Used to annotate the "Medical" filter button.
  useEffect(() => {
    // While a search is active the badge uses an in-memory count over
    // searchResults, so the library count request is unused — skip it.
    if (searchResults !== null) return;

    // A non-Medical category constraint plus a Medical constraint yields
    // nothing — short-circuit without firing a request.
    if (category && category !== "Medical") {
      setMedicalCount(0);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams();
        params.set("category", "Medical");
        selectedTags.forEach((t) => params.append("tags", t));
        params.set("page", "1");
        params.set("page_size", "1");
        if (starredOnly) params.set("starred", "true");

        const data = await apiGet<LibraryResponse>(`/documents?${params}`);
        if (!cancelled) setMedicalCount(data.total);
      } catch {
        // Fail silently — leave the prior count in place.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [category, selectedTags, starredOnly, searchResults]);

  // When a search is active, count medical docs directly from the raw
  // (non-paginated) result set — independent of the showMedical toggle.
  const searchMedicalCount = useMemo(
    () =>
      searchResults === null
        ? null
        : searchResults.filter((r) => r.category === "Medical").length,
    [searchResults],
  );

  const loadMore = useCallback(async () => {
    if (isFetching.current || !hasMore) return;
    isFetching.current = true;
    setIsLoadingMore(true);

    const currentPage = pageRef.current;

    try {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (!showMedical) params.set("exclude_category", "Medical");
      selectedTags.forEach((t) => params.append("tags", t));
      params.set("sort_by", sortBy);
      params.set("sort_dir", sortDir);
      params.set("page", String(currentPage));
      params.set("page_size", "24");
      if (starredOnly) params.set("starred", "true");

      const data = await apiGet<LibraryResponse>(`/documents?${params}`);

      setDocs((prev) => [...prev, ...data.documents]);
      setHasMore(data.documents.length === 24);
      pageRef.current = currentPage + 1;
      setStarredById((prev) => {
        const next = { ...prev };
        data.documents.forEach((d) => {
          next[d.document_id] = d.starred;
        });
        return next;
      });
    } catch {
      // Silent — don't surface load-more failures
    } finally {
      setIsLoadingMore(false);
      isFetching.current = false;
    }
  }, [
    category,
    selectedTags,
    sortBy,
    sortDir,
    starredOnly,
    showMedical,
    hasMore,
  ]);

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  const fetchFailedJobs = useCallback(async () => {
    try {
      const data = await apiGet<{ failed_jobs?: FailedJob[] }>(`/jobs/failed`);
      setFailedJobs(data.failed_jobs ?? []);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    fetchFailedJobs();
  }, [fetchFailedJobs]);

  // Poll while any visible doc is queued/processing
  useEffect(() => {
    const hasInProgress = docs.some(
      (d) =>
        d.processing_status === "queued" ||
        d.processing_status === "processing",
    );
    if (!hasInProgress) return;

    const timer = setInterval(() => {
      setFetchKey((k) => k + 1);
    }, 8000);
    return () => clearInterval(timer);
  }, [docs]);

  const handleRetry = async (docId: string) => {
    const job = failedJobs.find((j) => j.document_id === docId);
    setFailedJobs((jobs) => jobs.filter((j) => j.document_id !== docId));
    try {
      const data = await apiPost<{ job_id: string }>(
        `/document/${docId}/reprocess`,
      );
      if (uploadRef?.current && job) {
        uploadRef.current.addReprocessJob(docId, job.filename, data.job_id);
      }
    } catch {
      /* ignore */
    }
  };

  const handleCancelFailed = async (docId: string) => {
    await apiDelete(`/document/${docId}`);
    setFailedJobs((jobs) => jobs.filter((j) => j.document_id !== docId));
  };

  const handleStar = useCallback(
    async (docId: string) => {
      const currentStarred = starredById[docId] ?? false;
      const newStarred = !currentStarred;

      // Optimistic update
      setStarredById((prev) => ({ ...prev, [docId]: newStarred }));
      if (starredOnly && !newStarred) {
        setDocs((prev) => prev.filter((d) => d.document_id !== docId));
      }

      try {
        await apiPost(`/document/${docId}/star`);
      } catch (err) {
        console.error("Star toggle failed:", err);
        setStarredById((prev) => ({ ...prev, [docId]: currentStarred }));
        if (starredOnly && !newStarred) {
          setFetchKey((k) => k + 1);
        }
      }
    },
    [starredById, starredOnly],
  );

  const handleDeleteDoc = async () => {
    const targetId = pendingDeleteIdRef.current;
    if (!targetId || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiDelete(`/document/${targetId}`);
      setPendingDelete(null);
      setDocs((prev) => prev.filter((d) => d.document_id !== targetId));
      setSearchResults((prev) =>
        prev ? prev.filter((r) => r.document_id !== targetId) : null,
      );
    } catch (err) {
      setPendingDelete(null);
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

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
        setTagSuggestions(data.tags.filter((t) => !selectedTags.includes(t)));
      } catch {
        setTagSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [tagInput, selectedTags]);

  const addTag = (tag: string) => {
    if (!selectedTags.includes(tag)) setSelectedTags((prev) => [...prev, tag]);
    setTagInput("");
    setTagSuggestions([]);
  };

  const removeTag = (tag: string) => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  };

  const clearSearch = () => {
    setSearchResults(null);
    setActiveSearch("");
    setSearchInput("");
    setSearchError(null);
  };

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!searchInput.trim()) {
      clearSearch();
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    setActiveSearch(searchInput.trim());
    try {
      const data = await apiPost<SearchResponse>(`/search`, {
        query: searchInput.trim(),
        category: category || null,
        tags: selectedTags.length ? selectedTags : undefined,
      });
      setSearchResults(data.results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setSearchResults(null);
    } finally {
      setSearchLoading(false);
    }
  };

  const visibleSearchResults =
    searchResults === null
      ? null
      : showMedical
        ? searchResults
        : searchResults.filter((r) => r.category !== "Medical");

  return (
    <div className="max-w-4xl mx-auto px-3 md:px-4 py-4 md:py-6 space-y-4">
      {/* Search bar — full width above sidebar+docs */}
      <form onSubmit={handleSearch}>
        <div className="flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-vault-teal pointer-events-none">
              <IconSearch size={16} stroke={2} />
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search your documents…"
              maxLength={500}
              className="w-full rounded-lg py-2.5 pl-9 pr-9 text-sm placeholder-vault-text-soft focus:outline-none transition-colors"
              style={{
                background: "#252830",
                border: "1px solid var(--vault-btn-border)",
                color: "var(--vault-text-bright)",
                minHeight: "44px",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "#2DD4BF")}
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--vault-btn-border)")
              }
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={clearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-vault-text-muted hover:text-vault-text-primary"
              >
                <IconX size={16} stroke={2} />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={searchLoading}
            className="rounded-lg px-5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{
              background: "#2DD4BF",
              color: "#1C1F26",
              minHeight: "44px",
            }}
            onMouseEnter={(e) => {
              if (!searchLoading)
                (e.currentTarget as HTMLElement).style.background = "#5EEAD4";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "#2DD4BF";
            }}
          >
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {/* Horizontal filter bar — single line, scrolls if narrow */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
          }}
          className="flex-shrink-0 rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
          style={{
            background: "#252830",
            border: "1px solid var(--vault-btn-border)",
            color: "var(--vault-text-bright)",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "#2DD4BF")}
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--vault-btn-border)")
          }
        >
          <option value="">All Categories</option>
          {withSelectedCategory(categories, category).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="text-xs whitespace-nowrap"
            style={{ color: "var(--vault-text-muted)" }}
          ></span>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
            }}
            className="rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
            style={{
              background: "#252830",
              border: "1px solid var(--vault-btn-border)",
              color: "var(--vault-text-bright)",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "#2DD4BF")}
            onBlur={(e) =>
              (e.currentTarget.style.borderColor = "var(--vault-btn-border)")
            }
          >
            <option value="uploaded_at">Upload date</option>
            <option value="document_date">Document date</option>
            <option value="filename">Filename</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="text-xs whitespace-nowrap"
            style={{ color: "var(--vault-text-muted)" }}
          ></span>
          <select
            value={sortDir}
            onChange={(e) => {
              setSortDir(e.target.value);
            }}
            className="rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
            style={{
              background: "#252830",
              border: "1px solid var(--vault-btn-border)",
              color: "var(--vault-text-bright)",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "#2DD4BF")}
            onBlur={(e) =>
              (e.currentTarget.style.borderColor = "var(--vault-btn-border)")
            }
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>

        <button
          onClick={() => {
            setStarredOnly((v) => !v);
          }}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors"
          style={{
            background: starredOnly ? "rgba(45,212,191,0.12)" : "#252830",
            border: `1px solid ${starredOnly ? "#2DD4BF" : "var(--vault-btn-border)"}`,
            color: starredOnly ? "#2DD4BF" : "var(--vault-text-muted)",
          }}
        >
          {starredOnly ? <IconStarFilled size={14} /> : <IconStar size={14} />}
          Starred
        </button>

        <button
          onClick={() => setShowMedical(!showMedical)}
          title={
            showMedical ? "Hide medical documents" : "Show medical documents"
          }
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors"
          style={{
            background: showMedical ? "rgba(45,212,191,0.12)" : "#252830",
            border: `1px solid ${showMedical ? "#2DD4BF" : "var(--vault-btn-border)"}`,
            color: showMedical ? "#2DD4BF" : "var(--vault-text-muted)",
          }}
        >
          <i
            className="ti ti-medical-cross"
            aria-hidden="true"
            style={{ fontSize: "14px" }}
          />
          {(() => {
            const badge =
              searchResults !== null ? searchMedicalCount : medicalCount;
            return `Medical${badge != null ? ` (${badge})` : ""}`;
          })()}
        </button>

        <div className="relative flex-shrink-0">
          <input
            ref={tagInputRef}
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagInput.trim()) {
                e.preventDefault();
                addTag(tagInput.trim());
              }
            }}
            placeholder="Filter by tag…"
            className="rounded-lg px-3 py-2 text-sm placeholder-vault-text-soft focus:outline-none transition-all"
            style={{
              background: "#252830",
              border: "1px solid var(--vault-btn-border)",
              color: "var(--vault-text-bright)",
              width: "110px",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "#2DD4BF";
              e.currentTarget.style.width = "160px";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--vault-btn-border)";
              e.currentTarget.style.width = "110px";
            }}
          />
          {tagSuggestions.length > 0 && (
            <div className="absolute z-20 left-0 mt-1 rounded border border-gray-700 bg-gray-900 shadow-lg">
              {tagSuggestions.map((s) => (
                <button
                  key={s}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 whitespace-nowrap"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {(selectedTags.length > 0 ||
          category ||
          starredOnly ||
          showMedical) && (
          <button
            onClick={() => {
              setSelectedTags([]);
              setCategory("");
              setStarredOnly(false);
              setShowMedical(false);
              setTagInput("");
            }}
            className="flex-shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors"
            style={{
              background: "#252830",
              border: "1px solid var(--vault-btn-border)",
              color: "var(--vault-text-muted)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#FCA5A5";
              (e.currentTarget as HTMLElement).style.borderColor =
                "rgba(248,113,113,0.4)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color =
                "var(--vault-text-muted)";
              (e.currentTarget as HTMLElement).style.borderColor =
                "var(--vault-btn-border)";
            }}
          >
            <IconX size={14} />
            Clear
          </button>
        )}
      </div>

      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-gray-800 border border-gray-700 px-2 py-0.5 text-xs text-gray-300"
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="text-gray-500 hover:text-gray-200"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {failedJobs.length > 0 && (
        <FailedJobsSection
          jobs={failedJobs}
          onRetry={handleRetry}
          onCancel={handleCancelFailed}
        />
      )}

      {/* Search mode */}
      {isSearchMode ? (
        <>
          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg"
            style={{
              background: "rgba(45,212,191,0.08)",
              border: "1px solid rgba(45,212,191,0.25)",
            }}
          >
            <span
              className="text-sm min-w-0 truncate"
              style={{ color: "var(--vault-text-bright)" }}
            >
              Searching:{" "}
              <span style={{ color: "#2DD4BF" }}>
                &ldquo;{activeSearch}&rdquo;
              </span>
              {!searchLoading && visibleSearchResults !== null && (
                <span
                  style={{ color: "var(--vault-text-muted)" }}
                  className="ml-2"
                >
                  — {visibleSearchResults.length} result
                  {visibleSearchResults.length !== 1 ? "s" : ""}
                </span>
              )}
            </span>
            <button
              onClick={clearSearch}
              className="flex-shrink-0 text-xs px-3 py-1.5 rounded transition-colors"
              style={{
                color: "var(--vault-text-muted)",
                border: "1px solid var(--vault-btn-border)",
                minHeight: "44px",
                minWidth: "44px",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color =
                  "var(--vault-text-bright)";
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--vault-text-dim)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color =
                  "var(--vault-text-muted)";
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--vault-btn-border)";
              }}
            >
              Clear
            </button>
          </div>

          {searchLoading && (
            <div
              className="text-center py-8 text-sm"
              style={{ color: "var(--vault-text-muted)" }}
            >
              Searching…
            </div>
          )}

          {searchError && (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
              {searchError}
            </div>
          )}

          {!searchLoading &&
            visibleSearchResults !== null &&
            (visibleSearchResults.length === 0 ? (
              <div className="text-center py-12 space-y-1">
                <p style={{ color: "var(--vault-text-muted)" }}>
                  No results for &ldquo;{activeSearch}&rdquo;
                </p>
                <p
                  className="text-sm"
                  style={{ color: "var(--vault-text-dim)" }}
                >
                  Try different keywords or remove filters
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">
                    {visibleSearchResults.length} result
                    {visibleSearchResults.length !== 1 ? "s" : ""}
                  </p>
                  <div className="flex gap-1">
                    {(["grid", "list"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setViewMode(m)}
                        className={`px-2.5 py-1 rounded text-sm transition-colors ${
                          viewMode === m
                            ? "bg-gray-800 text-white"
                            : "text-gray-500 hover:text-gray-300"
                        }`}
                      >
                        {m === "grid" ? "⊞" : "☰"}
                      </button>
                    ))}
                  </div>
                </div>
                {viewMode === "grid" ? (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4">
                    {visibleSearchResults.map((r) => (
                      <DocCard
                        key={r.document_id}
                        doc={resultToDoc(
                          r,
                          starredById[r.document_id] ?? false,
                        )}
                        viewMode="grid"
                        onClick={() => onOpenDocument(r.document_id)}
                        onDelete={(e) => {
                          e.stopPropagation();
                          pendingDeleteIdRef.current = r.document_id;
                          setPendingDelete(resultToDoc(r));
                        }}
                        onStar={(e) => {
                          e.stopPropagation();
                          handleStar(r.document_id);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-[13px]">
                    {visibleSearchResults.map((r) => (
                      <DocCard
                        key={r.document_id}
                        doc={resultToDoc(
                          r,
                          starredById[r.document_id] ?? false,
                        )}
                        viewMode="list"
                        onClick={() => onOpenDocument(r.document_id)}
                        onDelete={(e) => {
                          e.stopPropagation();
                          pendingDeleteIdRef.current = r.document_id;
                          setPendingDelete(resultToDoc(r));
                        }}
                        onStar={(e) => {
                          e.stopPropagation();
                          handleStar(r.document_id);
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            ))}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              {loading
                ? "Loading…"
                : `${total} document${total !== 1 ? "s" : ""}`}
            </p>
            <div className="flex gap-1">
              {(["grid", "list"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-2.5 py-1 rounded text-sm transition-colors ${
                    viewMode === m
                      ? "bg-gray-800 text-white"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {m === "grid" ? "⊞" : "☰"}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && docs.length === 0 && (
            <div className="flex items-center justify-center py-16">
              <div
                className="w-6 h-6 rounded-full border-2 animate-spin"
                style={{
                  borderColor: "#2DD4BF",
                  borderTopColor: "transparent",
                }}
              />
            </div>
          )}

          {!loading && !error && docs.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              No documents found
            </div>
          )}

          {viewMode === "grid" ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4">
              {docs.map((doc) => (
                <DocCard
                  key={doc.document_id}
                  doc={{
                    ...doc,
                    starred: starredById[doc.document_id] ?? doc.starred,
                  }}
                  viewMode="grid"
                  onClick={() => onOpenDocument(doc.document_id)}
                  onDelete={(e) => {
                    e.stopPropagation();
                    pendingDeleteIdRef.current = doc.document_id;
                    setPendingDelete(doc);
                  }}
                  onStar={(e) => {
                    e.stopPropagation();
                    handleStar(doc.document_id);
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-[13px]">
              {docs.map((doc) => (
                <DocCard
                  key={doc.document_id}
                  doc={{
                    ...doc,
                    starred: starredById[doc.document_id] ?? doc.starred,
                  }}
                  viewMode="list"
                  onClick={() => onOpenDocument(doc.document_id)}
                  onDelete={(e) => {
                    e.stopPropagation();
                    pendingDeleteIdRef.current = doc.document_id;
                    setPendingDelete(doc);
                  }}
                  onStar={(e) => {
                    e.stopPropagation();
                    handleStar(doc.document_id);
                  }}
                />
              ))}
            </div>
          )}

          <div ref={sentinelRef} className="h-0" />
          {isLoadingMore && (
            <div className="flex items-center justify-center py-6">
              <div
                className="w-5 h-5 rounded-full border-2 animate-spin"
                style={{
                  borderColor: "#2DD4BF",
                  borderTopColor: "transparent",
                }}
              />
            </div>
          )}
          {!hasMore && docs.length > 0 && (
            <p
              className="text-center text-xs py-4"
              style={{ color: "var(--vault-text-dim)" }}
            >
              All documents loaded
            </p>
          )}
        </>
      )}

      {/* Delete error banner */}
      {deleteError && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-xl"
          style={{
            background: "#3B1212",
            border: "1px solid rgba(248,113,113,0.4)",
            color: "#FCA5A5",
          }}
        >
          <span>Delete failed: {deleteError}</span>
          <button
            onClick={() => setDeleteError(null)}
            className="ml-1 opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/70">
          <div
            className="rounded-xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-2xl"
            style={{
              background: "#252830",
              border: "1px solid rgba(248,113,113,0.3)",
            }}
          >
            <h3
              className="text-sm font-medium"
              style={{ color: "var(--vault-text-bright)" }}
            >
              Delete document?
            </h3>
            <p className="text-sm" style={{ color: "var(--vault-text-muted)" }}>
              <span style={{ color: "var(--vault-text-bright)" }}>
                {pendingDelete.filename}
              </span>{" "}
              will be permanently removed. This cannot be undone.
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleDeleteDoc}
                disabled={deleting}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-medium text-white bg-red-700 hover:bg-red-600 disabled:opacity-40 transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => setPendingDelete(null)}
                className="flex-1 rounded-lg px-3 py-2 text-sm transition-colors"
                style={{
                  border: "1px solid var(--vault-btn-border)",
                  color: "var(--vault-text-muted)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--vault-text-dim)";
                  (e.currentTarget as HTMLElement).style.color =
                    "var(--vault-text-bright)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--vault-btn-border)";
                  (e.currentTarget as HTMLElement).style.color =
                    "var(--vault-text-muted)";
                }}
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
