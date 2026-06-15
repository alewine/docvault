"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { IconX } from "@tabler/icons-react";
import BACKEND_URL from "@/app/lib/backend";
import { fetchCategoryNames } from "@/app/lib/categories";

const RECENT_KEY = "docvault_recent_questions";
const RECENT_MAX = 6;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecent(questions: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(questions));
  } catch {
    // localStorage unavailable — degrade gracefully
  }
}

interface Source {
  document_id: string;
  filename: string;
  category: string | null;
  excerpt: string;
  has_thumbnail: boolean;
}

function highlightValues(text: string) {
  const parts = text.split(
    /(\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*(?:\.\d+)?(?:\s*%)?)/g,
  );
  return parts.map((part, i) =>
    /^\$[\d,]+(?:\.\d{2})?$|^\d+(?:,\d{3})*(?:\.\d+)?(?:\s*%)?$/.test(
      part.trim(),
    ) && part.trim() ? (
      <span key={i} className="text-vault-teal font-medium">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export default function AskView({
  onOpenDocument,
}: {
  onOpenDocument: (id: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [recentQuestions, setRecentQuestions] = useState<string[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    setRecentQuestions(loadRecent());
  }, []);

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

  const submitQuestion = async () => {
    if (!question.trim() || loading) return;

    const trimmed = question.trim();
    const updated = [
      trimmed,
      ...recentQuestions.filter((q) => q !== trimmed),
    ].slice(0, RECENT_MAX);
    setRecentQuestions(updated);
    saveRecent(updated);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setAnswer("");
    setSources([]);
    setError(null);
    setDone(false);
    setElapsedMs(null);
    setLoading(true);
    startTimeRef.current = performance.now();

    try {
      const resp = await fetch(`${BACKEND_URL}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          category: category || undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "token") {
            setAnswer((a) => a + event.text);
          } else if (event.type === "done") {
            setSources(event.sources);
            setDone(true);
            if (startTimeRef.current !== null) {
              setElapsedMs(performance.now() - startTimeRef.current);
            }
          } else if (event.type === "error") {
            setError(event.text);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message || "Request failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitQuestion();
  };

  const canSubmit = !!question.trim() && !loading;

  return (
    <div className="max-w-4xl mx-auto px-3 md:px-4 py-6 md:py-8 space-y-6 pb-8">
      <div className="hidden md:block">
        <h2 className="text-xl font-semibold text-vault-text-primary">
          Ask your documents
        </h2>
        <p className="text-sm text-vault-text-muted mt-1">
          Answers are generated from your local documents — nothing is sent to
          the internet.
        </p>
      </div>

      {/* Filter scope */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted mb-2">
          Filter scope
        </p>
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <i
              className="ti ti-filter absolute left-3 top-1/2 -translate-y-1/2 text-vault-teal pointer-events-none"
              style={{ fontSize: 16 }}
            />
            <select
              value={category ?? ""}
              onChange={(e) => setCategory(e.target.value || null)}
              className="w-full bg-vault-input border border-vault-border rounded-lg px-3 py-2 text-base md:text-sm text-vault-text-primary appearance-none"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238A93A8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
                paddingLeft: "2.5rem",
                paddingRight: "2rem",
                touchAction: "manipulation",
              }}
            >
              <option value="">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-xs text-vault-text-muted flex items-center gap-1 mb-4 mt-2">
          <i className="ti ti-info-circle" />
          {category ? `Category: ${category}` : "Searching all documents"}
        </p>
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} style={{ marginTop: 24 }}>
        <div className="flex items-stretch gap-2">
          <div
            className="relative flex-1 flex items-start bg-vault-input px-4 py-3"
            style={{
              border: "1px solid rgba(0,212,170,0.25)",
              borderRadius: 10,
            }}
          >
            <i
              className="ti ti-message-search text-vault-teal flex-shrink-0"
              style={{ fontSize: 18, marginTop: 2 }}
            />
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitQuestion();
                }
              }}
              placeholder="What is my deductible on the Blue Cross plan?"
              rows={3}
              className="flex-1 bg-transparent border-none outline-none text-sm text-vault-text-primary placeholder-vault-text-muted resize-none pl-3 pr-9"
              style={{ touchAction: "manipulation" }}
            />
            {question && (
              <button
                type="button"
                aria-label="Clear question"
                onClick={() => setQuestion("")}
                className="absolute right-4 top-3 text-vault-text-muted hover:text-vault-text-primary"
              >
                <IconX size={16} stroke={2} />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex-shrink-0 text-sm font-semibold transition-colors"
            style={{
              background: canSubmit ? "#00D4AA" : "#2A2F42",
              color: canSubmit ? "#0a2e27" : "#8A93A8",
              border: canSubmit ? "none" : "1px solid #00D4AA",
              borderRadius: 10,
              padding: "0 24px",
              fontWeight: 600,
              minHeight: 44,
            }}
          >
            {loading ? "…" : "Ask"}
          </button>
        </div>
      </form>

      {/* Recent questions */}
      {recentQuestions.length > 0 && (
        <div>
          <p className="text-xs font-semibold tracking-widest text-vault-text-muted uppercase mb-2">
            Recent
          </p>
          <div className="space-y-1">
            {recentQuestions.map((q, i) => (
              <div
                key={i}
                className="flex items-center bg-vault-surface border border-vault-border rounded px-4 py-3"
              >
                <button
                  type="button"
                  onClick={() => setQuestion(q)}
                  className="flex-1 text-sm text-vault-text-primary text-left overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {q}
                </button>
                <button
                  type="button"
                  aria-label="Remove recent question"
                  onClick={() => {
                    const next = recentQuestions.filter((_, idx) => idx !== i);
                    setRecentQuestions(next);
                    saveRecent(next);
                  }}
                  className="text-vault-text-muted hover:text-vault-danger ml-2 flex-shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Keyframes scoped to AskView */}
      <style>{`
        @keyframes askview-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes askview-pulse {
          0%, 100% { opacity: 0.5; }
          50%       { opacity: 1; }
        }
      `}</style>

      {/* Thinking spinner — visible only while loading with no answer text yet */}
      {loading && !answer && (
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              animation: "askview-spin 1.2s linear infinite",
              display: "flex",
              flexShrink: 0,
            }}
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle
                cx="14"
                cy="14"
                r="11"
                stroke="#2E3448"
                strokeWidth="2.5"
              />
              <path
                d="M14 3 A11 11 0 0 1 25 14"
                stroke="#00D4AA"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span
            className="text-vault-text-muted"
            style={{
              fontSize: 14,
              animation: "askview-pulse 1.2s ease-in-out infinite",
            }}
          >
            Searching your documents…
          </span>
        </div>
      )}

      {(answer || (done && sources.length > 0)) && (
        <div className="w-full space-y-6">
          {/* Answer block — shown once tokens start arriving */}
          {answer && (
            <div
              className="w-full bg-vault-surface border border-vault-border"
              style={{ borderRadius: 12, padding: 24 }}
            >
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="rounded-full bg-vault-teal flex-shrink-0"
                  style={{ width: 8, height: 8 }}
                />
                <span
                  className="text-vault-teal font-semibold uppercase tracking-widest"
                  style={{ fontSize: 12 }}
                >
                  Answer
                </span>
              </div>
              <p
                className="text-vault-text-primary whitespace-pre-wrap"
                style={{ fontSize: 15, lineHeight: 1.7 }}
              >
                {highlightValues(answer)}
                {loading && !done && (
                  <span className="text-vault-teal animate-pulse">▌</span>
                )}
              </p>
            </div>
          )}

          {/* Sources */}
          {done && sources.length > 0 && (
            <div className="w-full space-y-3">
              <div className="flex items-center justify-between">
                <p
                  className="text-vault-text-muted font-medium uppercase tracking-widest"
                  style={{ fontSize: 12 }}
                >
                  Sources ({sources.length})
                </p>
                {elapsedMs !== null && (
                  <span
                    className="text-vault-text-muted"
                    style={{ fontSize: 12 }}
                  >
                    {elapsedMs >= 1000
                      ? `${(elapsedMs / 1000).toFixed(1)}s`
                      : `${Math.round(elapsedMs)}ms`}
                  </span>
                )}
              </div>
              <div className="w-full space-y-3">
                {sources.map((src, idx) => (
                  <button
                    key={src.document_id}
                    onClick={() => onOpenDocument(src.document_id)}
                    className="w-full text-left flex items-start gap-3 hover:opacity-90 transition-opacity"
                    style={{
                      background: "#242838",
                      border: "1px solid #2E3448",
                      borderLeft: `3px solid ${idx === 0 ? "#00D4AA" : "#2E3448"}`,
                      borderRadius: 8,
                      padding: "12px 16px",
                      opacity: idx === 0 ? 1 : 0.8,
                    }}
                  >
                    {/* Thumbnail or file icon */}
                    {src.has_thumbnail ? (
                      <Image
                        src={`${BACKEND_URL}/thumbnail/${src.document_id}`}
                        alt=""
                        width={48}
                        height={48}
                        unoptimized
                        className="flex-shrink-0 rounded-lg object-cover"
                        onError={(e) => {
                          const target = e.currentTarget;
                          target.style.display = "none";
                          const fallback =
                            target.nextElementSibling as HTMLElement | null;
                          if (fallback) fallback.style.display = "flex";
                        }}
                      />
                    ) : null}
                    <div
                      className="flex-shrink-0 flex items-center justify-center rounded-lg"
                      style={{
                        width: 48,
                        height: 48,
                        background: "#2A2F42",
                        display: src.has_thumbnail ? "none" : "flex",
                      }}
                    >
                      <i
                        className="ti ti-file-text"
                        style={{
                          fontSize: 20,
                          color: idx === 0 ? "#00D4AA" : "#8A93A8",
                        }}
                      />
                    </div>
                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm text-vault-text-primary truncate flex-1">
                          {src.filename}
                        </span>
                        {src.category && (
                          <span
                            className="flex-shrink-0 text-xs px-2 py-0.5 rounded-full"
                            style={
                              idx === 0
                                ? {
                                    background: "rgba(0,212,170,0.1)",
                                    color: "#00D4AA",
                                  }
                                : {
                                    background: "rgba(138,147,168,0.12)",
                                    color: "#8A93A8",
                                  }
                            }
                          >
                            {src.category}
                          </span>
                        )}
                      </div>
                      <p
                        className="text-vault-text-muted"
                        style={{
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {src.excerpt}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-vault-danger bg-vault-danger-surface px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
