"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import HealthScreen from "./components/HealthScreen";
import LibraryView from "./components/LibraryView";
import AskView from "./components/AskView";
import DocumentDetail from "./components/DocumentDetail";
import UploadButton, {
  type UploadQueueHandle,
} from "./components/UploadButton";
import TagManagerView from "./components/TagManagerView";
import AuditView from "./components/AuditView";
import SettingsView from "./components/SettingsView";
import PullToRefresh from "./components/PullToRefresh";
import BACKEND_URL from "./lib/backend";
import { getDroppedFiles } from "./lib/fileDropUtils";

type View = "library" | "ask" | "tags" | "audit" | "settings";

export default function Page() {
  const [healthy, setHealthy] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState(false);
  const [nasOk, setNasOk] = useState(true);
  const [view, setView] = useState<View>("library");
  const [detailDocId, setDetailDocId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const uploadRef = useRef<UploadQueueHandle>(null);

  const onHealthy = useCallback((llmOk: boolean) => {
    setHealthy(true);
    setLlmAvailable(llmOk);
  }, []);

  const onUploaded = useCallback(() => {
    if (view === "library") setResetKey((k) => k + 1);
  }, [view]);

  // Periodic NAS health check after initial startup
  useEffect(() => {
    if (!healthy) return;
    const check = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          setNasOk(data.checks?.nas === "green");
        }
      } catch {
        /* network hiccup — keep last state */
      }
    };
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [healthy]);

  // Global drag-and-drop handlers
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const files = await getDroppedFiles(e.dataTransfer);
    if (files.length) uploadRef.current?.addFiles(files);
  }, []);

  if (!healthy) return <HealthScreen onHealthy={onHealthy} />;

  return (
    <PullToRefresh>
      <div
        className="min-h-screen flex flex-col text-vault-text-bright"
        style={{ background: "#1C1F26", color: "var(--vault-text-bright)" }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {/* NAS offline warning */}
        {!nasOk && (
          <div className="bg-yellow-900/80 border-b border-yellow-700 px-4 py-2 text-sm text-yellow-200 text-center">
            NAS drive not detected — uploads and file access unavailable.{" "}
            <button
              onClick={() => setNasOk(true)}
              className="underline opacity-70 hover:opacity-100 ml-2"
            >
              Dismiss
            </button>
          </div>
        )}

        <header
          className="sticky top-0 z-40 border-b border-vault-btn-border"
          style={{ background: "#1C1F26" }}
        >
          <div className="max-w-4xl mx-auto px-3 md:px-4">
            <div className="h-12 flex items-center gap-3 md:gap-6">
              <button
                onClick={() => window.location.reload()}
                title="Reload"
                className="cursor-pointer"
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: "24px",
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  background: "none",
                  border: "none",
                  padding: 0,
                }}
              >
                <span className="text-vault-text-primary">Doc</span>
                <span className="text-vault-teal font-bold">Vault</span>
              </button>
              <nav className="hidden md:flex gap-1">
                {(["library"] as View[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => {
                      if (v === "library") {
                        setView("library");
                        setDetailDocId(null);
                        if (view === "library" && !detailDocId)
                          setResetKey((k) => k + 1);
                      } else if (view === v) {
                        setResetKey((k) => k + 1);
                      } else {
                        setView(v);
                        setDetailDocId(null);
                      }
                    }}
                    className={
                      view === v
                        ? "rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm font-medium capitalize text-vault-teal transition-colors hover:bg-vault-teal hover:text-vault-bg"
                        : "rounded-lg border border-transparent px-3 py-1 text-sm font-medium capitalize text-vault-text-soft transition-colors hover:text-vault-text-bright"
                    }
                  >
                    {v === "library" ? "Library" : v}
                  </button>
                ))}
                <div className="relative group">
                  <button
                    onClick={() => {
                      if (!llmAvailable) return;
                      if (view === "ask") setResetKey((k) => k + 1);
                      else {
                        setView("ask");
                        setDetailDocId(null);
                      }
                    }}
                    className={
                      llmAvailable && view === "ask"
                        ? "rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm font-medium text-vault-teal transition-colors hover:bg-vault-teal hover:text-vault-bg"
                        : llmAvailable
                          ? "rounded-lg border border-transparent px-3 py-1 text-sm font-medium text-vault-text-soft transition-colors hover:text-vault-text-bright"
                          : "rounded-lg border border-transparent px-3 py-1 text-sm font-medium text-vault-text-dim transition-colors"
                    }
                    style={{ cursor: llmAvailable ? "pointer" : "not-allowed" }}
                  >
                    Ask
                  </button>
                  {!llmAvailable && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 invisible group-hover:visible rounded-lg px-3 py-2 text-xs whitespace-nowrap bg-vault-btn border border-vault-btn-border text-vault-text-muted"
                      style={{ background: "#252830" }}
                    >
                      Run{" "}
                      <span className="font-mono" style={{ color: "#2DD4BF" }}>
                        ollama pull llama3.2
                      </span>{" "}
                      to enable
                    </div>
                  )}
                </div>
                {(["tags"] as View[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => {
                      if (view === v) {
                        setResetKey((k) => k + 1);
                      } else {
                        setView(v);
                        setDetailDocId(null);
                      }
                    }}
                    className={
                      view === v
                        ? "rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm font-medium capitalize text-vault-teal transition-colors hover:bg-vault-teal hover:text-vault-bg"
                        : "rounded-lg border border-transparent px-3 py-1 text-sm font-medium capitalize text-vault-text-soft transition-colors hover:text-vault-text-bright"
                    }
                  >
                    {v}
                  </button>
                ))}
                <button
                  onClick={() => {
                    if (view === "audit") setResetKey((k) => k + 1);
                    else {
                      setView("audit");
                      setDetailDocId(null);
                    }
                  }}
                  className={
                    view === "audit"
                      ? "rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm font-medium text-vault-teal transition-colors hover:bg-vault-teal hover:text-vault-bg"
                      : "rounded-lg border border-transparent px-3 py-1 text-sm font-medium text-vault-text-soft transition-colors hover:text-vault-text-bright"
                  }
                >
                  Audit
                </button>
                <button
                  onClick={() => {
                    if (view === "settings") setResetKey((k) => k + 1);
                    else {
                      setView("settings");
                      setDetailDocId(null);
                    }
                  }}
                  className={
                    view === "settings"
                      ? "rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm font-medium text-vault-teal transition-colors hover:bg-vault-teal hover:text-vault-bg"
                      : "rounded-lg border border-transparent px-3 py-1 text-sm font-medium text-vault-text-soft transition-colors hover:text-vault-text-bright"
                  }
                >
                  Settings
                </button>
              </nav>
              <div className="ml-auto">
                <UploadButton
                  ref={uploadRef}
                  onUploaded={onUploaded}
                  onDocumentSelect={setDetailDocId}
                />
              </div>
            </div>
            <div className="flex md:hidden border-t border-vault-btn-border">
              {(["library", "ask"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    if (v === "library") {
                      setView("library");
                      setDetailDocId(null);
                      if (view === "library" && !detailDocId)
                        setResetKey((k) => k + 1);
                    } else if (view === v) {
                      setResetKey((k) => k + 1);
                    } else {
                      setView(v);
                      setDetailDocId(null);
                    }
                  }}
                  className={`flex-1 py-2.5 text-sm capitalize border-b-2 min-h-[44px] transition-colors ${view === v ? "border-vault-teal text-vault-teal" : "border-transparent text-vault-text-muted"}`}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="flex-1">
          {detailDocId ? (
            <DocumentDetail
              docId={detailDocId}
              onBack={() => setDetailDocId(null)}
              onDeleted={() => setDetailDocId(null)}
              uploadRef={uploadRef}
            />
          ) : (
            <>
              {view === "library" && (
                <LibraryView
                  key={resetKey}
                  onOpenDocument={setDetailDocId}
                  uploadRef={uploadRef}
                />
              )}
              {view === "ask" && (
                <AskView key={resetKey} onOpenDocument={setDetailDocId} />
              )}
              {view === "tags" && <TagManagerView key={resetKey} />}
              {view === "audit" && <AuditView key={resetKey} />}
              {view === "settings" && <SettingsView key={resetKey} />}
            </>
          )}
        </div>

        {/* Full-page drop overlay */}
        {dragging && (
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="absolute inset-0 bg-blue-950/70 border-4 border-dashed border-blue-500 rounded-2xl m-4" />
            <div className="relative text-center space-y-2">
              <p className="text-2xl font-semibold text-blue-200">
                Drop to upload
              </p>
              <p className="text-sm text-blue-400">
                PDF, JPG, PNG, HEIC, HEIF, TXT, CSV, DOCX, XLSX, PPTX, MP3, WAV
              </p>
            </div>
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
