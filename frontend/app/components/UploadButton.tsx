"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  IconUpload,
  IconCpu,
  IconRefresh,
  IconCheck,
  IconX,
  IconClock,
  IconLock,
  IconBan,
  IconCopy,
} from "@tabler/icons-react";
import BACKEND_URL from "@/app/lib/backend";
import { formatBytes } from "@/app/lib/formatBytes";

const MAX_CONCURRENT = 2;
const AUTOCLEAR_DELAY = 3000;
const POLL_INTERVAL = 3000;
const SYNC_INTERVAL = 10000;
const SUPPORTED_RE =
  /\.(pdf|jpg|jpeg|png|heic|heif|txt|csv|docx|xlsx|pptx|mp3|wav|json)$/i;

function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function computeSHA256(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function deriveStageLabel(text: string): string {
  if (/ocr|tesseract/.test(text)) return "OCR · extracting text";
  if (/embed/.test(text)) return "Embedding · indexing content";
  if (/fts|index/.test(text)) return "Indexing · building search index";
  if (/thumbnail/.test(text)) return "Generating thumbnail";
  return "Processing";
}

type ItemStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "done"
  | "error"
  | "needs_password"
  | "duplicate"
  | "unsupported";

type BackendStatus =
  | "queued"
  | "processing"
  | "complete"
  | "error"
  | "needs_password";

interface QueueItem {
  id: string;
  filename: string;
  file?: File;
  status: ItemStatus;
  progress: number;
  uploadedBytes?: number;
  totalBytes?: number;
  jobId?: string;
  documentId?: string;
  error?: string;
  duplicateOf?: { id: string; filename: string };
  unlocking?: boolean;
  unlockError?: string;
  backendStatus?: BackendStatus;
  stageLabel?: string;
}

export interface UploadQueueHandle {
  addFiles: (files: FileList | File[]) => void;
  addReprocessJob: (docId: string, filename: string, jobId: string) => void;
}

function isTransferItem(item: QueueItem): boolean {
  return (
    item.status === "queued" ||
    item.status === "uploading" ||
    item.status === "duplicate" ||
    item.status === "unsupported" ||
    (item.status === "error" && !item.documentId)
  );
}

// ── Item icon: 28×28 rounded square, color-coded by state ──────────────────

interface ItemIconProps {
  status: ItemStatus;
  backendStatus?: BackendStatus;
}

function ItemIcon({ status, backendStatus }: ItemIconProps) {
  const isActiveProcessing =
    status === "processing" && backendStatus === "processing";
  const isUploading = status === "uploading";
  const isQueuedUpload = status === "queued";
  const isBackendQueued =
    status === "processing" && (backendStatus === "queued" || !backendStatus);
  const isDone = status === "done";
  const isError = status === "error" || status === "unsupported";
  const isDuplicate = status === "duplicate";
  const isPassword = status === "needs_password";

  let bgColor: string;
  let iconColor: string;
  if (isActiveProcessing || isUploading) {
    bgColor = "rgba(0,212,170,0.1)";
    iconColor = "#00D4AA";
  } else if (isQueuedUpload || isBackendQueued) {
    bgColor = "rgba(138,147,168,0.12)";
    iconColor = "#8A93A8";
  } else if (isDone) {
    bgColor = "rgba(99,153,34,0.12)";
    iconColor = "#7dba3a";
  } else if (isError) {
    bgColor = "rgba(229,62,62,0.1)";
    iconColor = "#E53E3E";
  } else if (isDuplicate) {
    bgColor = "rgba(186,117,23,0.12)";
    iconColor = "#d4902a";
  } else if (isPassword) {
    bgColor = "rgba(250,204,21,0.1)";
    iconColor = "#FBBF24";
  } else {
    bgColor = "rgba(138,147,168,0.12)";
    iconColor = "#8A93A8";
  }

  const sz = {
    width: 14,
    height: 14,
    color: iconColor,
    flexShrink: 0 as const,
  };

  let icon: React.ReactNode;
  if (isActiveProcessing) {
    icon = <IconRefresh style={sz} className="animate-spin" />;
  } else if (isUploading) {
    icon = <IconUpload style={sz} />;
  } else if (isQueuedUpload || isBackendQueued) {
    icon = <IconClock style={sz} />;
  } else if (isDone) {
    icon = <IconCheck style={sz} />;
  } else if (status === "unsupported") {
    icon = <IconBan style={sz} />;
  } else if (isError) {
    icon = <IconX style={sz} />;
  } else if (isDuplicate) {
    icon = <IconCopy style={sz} />;
  } else if (isPassword) {
    icon = <IconLock style={sz} />;
  } else {
    icon = <IconClock style={sz} />;
  }

  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: bgColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {icon}
    </div>
  );
}

// ── State badge label ───────────────────────────────────────────────────────

function stateBadgeStyle(
  status: ItemStatus,
  backendStatus?: BackendStatus,
): React.CSSProperties {
  const isActive =
    status === "uploading" ||
    (status === "processing" && backendStatus === "processing");
  const isDone = status === "done";
  const isError = status === "error" || status === "unsupported";
  const isDuplicate = status === "duplicate";

  if (isActive)
    return {
      color: "#00D4AA",
      background: "rgba(0,212,170,0.1)",
      border: "1px solid rgba(0,212,170,0.2)",
    };
  if (isDone)
    return {
      color: "#7dba3a",
      background: "rgba(99,153,34,0.12)",
      border: "1px solid rgba(99,153,34,0.2)",
    };
  if (isError)
    return {
      color: "#E53E3E",
      background: "rgba(229,62,62,0.1)",
      border: "1px solid rgba(229,62,62,0.2)",
    };
  if (isDuplicate)
    return {
      color: "#d4902a",
      background: "rgba(186,117,23,0.12)",
      border: "1px solid rgba(186,117,23,0.2)",
    };
  return {
    color: "#8A93A8",
    background: "rgba(138,147,168,0.08)",
    border: "1px solid rgba(138,147,168,0.15)",
  };
}

// ── Section header ──────────────────────────────────────────────────────────

function SectionHeader({
  label,
  Icon,
  count,
}: {
  label: string;
  Icon: React.ElementType;
  count: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px 6px",
      }}
    >
      <Icon style={{ width: 12, height: 12, color: "#8A93A8" }} />
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "#8A93A8",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "#8A93A8",
          background: "rgba(138,147,168,0.12)",
          border: "1px solid rgba(138,147,168,0.15)",
          borderRadius: 4,
          padding: "0 5px",
          lineHeight: "16px",
        }}
      >
        {count}
      </span>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default forwardRef<
  UploadQueueHandle,
  { onUploaded?: () => void; onDocumentSelect?: (docId: string) => void }
>(function UploadButton({ onUploaded, onDocumentSelect }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const activeIds = useRef(new Set<string>());
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(
    new Map(),
  );
  const autoclearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldSyncRef = useRef(false);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((q) =>
      q.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const clearItemActivity = useCallback((itemId: string) => {
    const timer = pollTimers.current.get(itemId);
    if (timer) {
      clearInterval(timer);
      pollTimers.current.delete(itemId);
    }
    activeIds.current.delete(itemId);
  }, []);

  const scheduleAutoClear = useCallback((itemId: string) => {
    const timer = setTimeout(() => {
      autoclearTimers.current.delete(itemId);
      setQueue((q) => q.filter((i) => i.id !== itemId));
    }, AUTOCLEAR_DELAY);
    autoclearTimers.current.set(itemId, timer);
  }, []);

  const startPolling = useCallback(
    (itemId: string, jobId: string, documentId?: string) => {
      const timer = setInterval(async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/status/${jobId}`);
          if (res.status === 404) {
            clearItemActivity(itemId);
            updateItem(itemId, {
              status: "error",
              backendStatus: "error",
              error: "Document not found (deleted externally)",
            });
            return;
          }

          const data = await res.json();

          if (data.status === "complete") {
            clearItemActivity(itemId);
            updateItem(itemId, { status: "done", backendStatus: "complete" });
            if (documentId) {
              window.dispatchEvent(
                new CustomEvent("docvault:document-processed", {
                  detail: { documentId },
                }),
              );
            }
            scheduleAutoClear(itemId);
            onUploaded?.();
          } else if (data.status === "error") {
            clearItemActivity(itemId);
            updateItem(itemId, {
              status: "error",
              backendStatus: "error",
              error: data.error_message ?? "Processing failed",
            });
          } else if (data.status === "needs_password") {
            clearItemActivity(itemId);
            updateItem(itemId, {
              status: "needs_password",
              backendStatus: "needs_password",
            });
          } else if (data.status === "processing") {
            updateItem(itemId, { backendStatus: "processing" });
            if (documentId) {
              try {
                const logRes = await fetch(
                  `${BACKEND_URL}/document/${documentId}/log`,
                );
                if (logRes.ok) {
                  const logData = await logRes.json();
                  const entries: Array<{
                    message?: string;
                    event_type?: string;
                  }> = logData.entries ?? [];
                  if (entries.length > 0) {
                    const latest = entries[entries.length - 1];
                    const text =
                      `${latest.message ?? ""} ${latest.event_type ?? ""}`.toLowerCase();
                    updateItem(itemId, { stageLabel: deriveStageLabel(text) });
                  }
                }
              } catch {
                /* log fetch failed — keep existing stageLabel */
              }
            }
          } else if (data.status === "queued") {
            updateItem(itemId, { backendStatus: "queued" });
          }
        } catch {
          /* keep polling */
        }
      }, POLL_INTERVAL);
      pollTimers.current.set(itemId, timer);
    },
    [clearItemActivity, updateItem, scheduleAutoClear, onUploaded],
  );

  // Keep queueRef in sync so syncActiveJobs can read current state without stale closure
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const syncActiveJobs = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/jobs/active`);
      if (!res.ok) return;
      const data = await res.json();
      const jobs: Array<{
        job_id: string;
        document_id: string;
        filename: string;
        status: string;
      }> = data.jobs ?? [];

      const currentTrackedDocIds = new Set(
        queueRef.current.map((i) => i.documentId).filter(Boolean),
      );
      const newJobs = jobs.filter(
        (j) => !currentTrackedDocIds.has(j.document_id),
      );
      if (newJobs.length === 0) return;

      const newItems: QueueItem[] = newJobs.map((j) => ({
        id: `sync-${j.document_id}`,
        filename: j.filename,
        status: "processing" as const,
        progress: 100,
        documentId: j.document_id,
        jobId: j.job_id,
        backendStatus: j.status as BackendStatus,
        stageLabel: "Processing…",
      }));

      setQueue((q) => [...q, ...newItems]);
      newJobs.forEach((j) =>
        startPolling(`sync-${j.document_id}`, j.job_id, j.document_id),
      );
      setPanelOpen(true);
    } catch {
      // silently ignore — sync is best-effort
    }
  }, [startPolling]);

  const processItem = useCallback(
    async (item: QueueItem) => {
      if (!item.file) return;
      updateItem(item.id, { status: "uploading", progress: 0 });

      try {
        const hash = await computeSHA256(item.file);
        if (hash) {
          const dupForm = new FormData();
          dupForm.append("file_hash", hash);
          const dupRes = await fetch(`${BACKEND_URL}/check-duplicate`, {
            method: "POST",
            body: dupForm,
          });
          if (dupRes.ok) {
            const dupData = await dupRes.json();
            if (dupData.duplicate) {
              activeIds.current.delete(item.id);
              updateItem(item.id, {
                status: "duplicate",
                duplicateOf: {
                  id: dupData.document_id,
                  filename: dupData.filename,
                },
              });
              return;
            }
          }
        }

        const formData = new FormData();
        formData.append("file", item.file!);

        const { jobId, documentId } = await new Promise<{
          jobId: string;
          documentId: string;
        }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${BACKEND_URL}/upload`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              updateItem(item.id, {
                progress: Math.round((e.loaded / e.total) * 100),
                uploadedBytes: e.loaded,
                totalBytes: e.total,
              });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const data = JSON.parse(xhr.responseText);
              resolve({ jobId: data.job_id, documentId: data.document_id });
            } else {
              try {
                reject(
                  new Error(
                    JSON.parse(xhr.responseText).detail ?? `HTTP ${xhr.status}`,
                  ),
                );
              } catch {
                reject(new Error(`HTTP ${xhr.status}`));
              }
            }
          };
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.send(formData);
        });

        updateItem(item.id, {
          status: "processing",
          jobId,
          documentId,
          backendStatus: "queued",
        });
        startPolling(item.id, jobId, documentId);
      } catch (err) {
        activeIds.current.delete(item.id);
        updateItem(item.id, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [updateItem, startPolling],
  );

  const handleUnlock = useCallback(
    async (item: QueueItem) => {
      const pwd = passwords[item.id] ?? "";
      if (!pwd || !item.documentId || !item.jobId) return;

      setPasswords((p) => ({ ...p, [item.id]: "" }));
      updateItem(item.id, { unlocking: true, unlockError: undefined });

      try {
        const res = await fetch(`${BACKEND_URL}/unlock/${item.documentId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd }),
        });

        if (res.status === 400) {
          updateItem(item.id, {
            unlocking: false,
            unlockError: "Incorrect password, try again.",
          });
          return;
        }
        if (!res.ok) {
          updateItem(item.id, {
            unlocking: false,
            unlockError: "Unlock failed, please try again.",
          });
          return;
        }

        updateItem(item.id, {
          status: "processing",
          unlocking: false,
          unlockError: undefined,
          backendStatus: "queued",
        });
        startPolling(item.id, item.jobId, item.documentId);
      } catch {
        updateItem(item.id, {
          unlocking: false,
          unlockError: "Network error, please try again.",
        });
      }
    },
    [passwords, updateItem, startPolling],
  );

  // Start queued upload items when under the concurrency limit
  useEffect(() => {
    const queued = queue.filter((i) => i.status === "queued");
    const slots = MAX_CONCURRENT - activeIds.current.size;
    queued.slice(0, slots).forEach((item) => {
      if (!activeIds.current.has(item.id)) {
        activeIds.current.add(item.id);
        processItem(item);
      }
    });
  }, [queue, processItem]);

  // Clean up timers on unmount
  useEffect(() => {
    const polls = pollTimers.current;
    const clears = autoclearTimers.current;
    return () => {
      polls.forEach(clearInterval);
      clears.forEach(clearTimeout);
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    };
  }, []);

  // Close panel/menus on outside click
  useEffect(() => {
    if (!panelOpen && !showUploadMenu) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
        setShowUploadMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [panelOpen, showUploadMenu]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(event.matches);
    };
    handleChange(mediaQuery);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;
    if (isMobile) {
      folderInput.removeAttribute("webkitdirectory");
      folderInput.removeAttribute("directory");
      return;
    }
    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, [isMobile]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const MAX_FILE_SIZE = 20 * 1024 * 1024;
    const arr = Array.from(files);
    if (!arr.length) return;
    const newItems = arr.map((f) => {
      if (f.size > MAX_FILE_SIZE) {
        return {
          id: generateId(),
          filename: f.name,
          file: f,
          status: "unsupported" as const,
          progress: 0,
          error: "File exceeds 20 MB limit",
        };
      }
      if (SUPPORTED_RE.test(f.name)) {
        return {
          id: generateId(),
          filename: f.name,
          file: f,
          status: "queued" as const,
          progress: 0,
        };
      }
      const ext = f.name.match(/\.[^.]+$/)?.[0] ?? "(no extension)";
      return {
        id: generateId(),
        filename: f.name,
        file: f,
        status: "unsupported" as const,
        progress: 0,
        error: `Unsupported file type: ${ext}`,
      };
    });
    setQueue((q) => [...q.filter((i) => i.status !== "done"), ...newItems]);
    setPanelOpen(true);
  }, []);

  const addReprocessJob = useCallback(
    (docId: string, filename: string, jobId: string) => {
      const itemId = generateId();
      setQueue((q) => [
        ...q.filter((i) => i.status !== "done"),
        {
          id: itemId,
          filename,
          status: "processing" as const,
          progress: 100,
          documentId: docId,
          jobId,
          backendStatus: "queued" as const,
          stageLabel: "Reprocessing…",
        },
      ]);
      setPanelOpen(true);
      startPolling(itemId, jobId, docId);
    },
    [startPolling],
  );

  const openFilePicker = useCallback(() => inputRef.current?.click(), []);
  const openFolderPicker = useCallback(
    () => folderInputRef.current?.click(),
    [],
  );

  const handleUploadButtonClick = useCallback(() => {
    if (isMobile) {
      setShowUploadMenu(false);
      openFilePicker();
      return;
    }
    setShowUploadMenu((open) => !open);
  }, [isMobile, openFilePicker]);

  useImperativeHandle(ref, () => ({ addFiles, addReprocessJob }), [
    addFiles,
    addReprocessJob,
  ]);

  // Initial hydration: pick up any jobs already running when the component mounts
  useEffect(() => {
    syncActiveJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep shouldSyncRef in sync so the periodic timer can gate without re-creating itself
  useEffect(() => {
    const hasActiveJobs = queue.some(
      (i) =>
        i.status === "uploading" ||
        i.status === "queued" ||
        i.status === "processing",
    );
    shouldSyncRef.current = panelOpen || hasActiveJobs;
  }, [panelOpen, queue]);

  // Periodic sync: runs every SYNC_INTERVAL ms while there is something to watch
  useEffect(() => {
    syncTimerRef.current = setInterval(() => {
      if (shouldSyncRef.current) syncActiveJobs();
    }, SYNC_INTERVAL);
    return () => {
      if (syncTimerRef.current) {
        clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissItem = useCallback((id: string) => {
    const t = autoclearTimers.current.get(id);
    if (t) {
      clearTimeout(t);
      autoclearTimers.current.delete(id);
    }
    setQueue((q) => q.filter((i) => i.id !== id));
  }, []);

  const dismissDone = useCallback(() => {
    autoclearTimers.current.forEach(clearTimeout);
    autoclearTimers.current.clear();
    setQueue((q) =>
      q.filter(
        (i) =>
          i.status === "queued" ||
          i.status === "uploading" ||
          i.status === "processing",
      ),
    );
  }, []);

  const retryItem = useCallback(
    async (item: QueueItem) => {
      if (item.documentId) {
        updateItem(item.id, {
          status: "processing",
          progress: 0,
          error: undefined,
          backendStatus: "queued",
          stageLabel: undefined,
        });
        try {
          const res = await fetch(
            `${BACKEND_URL}/document/${item.documentId}/reprocess`,
            { method: "POST" },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          updateItem(item.id, { jobId: data.job_id });
          startPolling(item.id, data.job_id, item.documentId);
        } catch (err) {
          updateItem(item.id, {
            status: "error",
            error: err instanceof Error ? err.message : "Retry failed",
          });
        }
      } else {
        updateItem(item.id, {
          status: "queued",
          progress: 0,
          error: undefined,
        });
      }
    },
    [updateItem, startPolling],
  );

  const cancelItem = useCallback(
    async (item: QueueItem) => {
      clearItemActivity(item.id);
      const t = autoclearTimers.current.get(item.id);
      if (t) {
        clearTimeout(t);
        autoclearTimers.current.delete(item.id);
      }
      setQueue((q) => q.filter((i) => i.id !== item.id));
      if (!item.documentId) return;
      try {
        await fetch(`${BACKEND_URL}/document/${item.documentId}`, {
          method: "DELETE",
        });
      } catch {
        /* item is already removed locally */
      }
    },
    [clearItemActivity],
  );

  // ── Derived state ─────────────────────────────────────────────────────────

  const transferItems = queue.filter(isTransferItem);
  const processingItems = queue.filter((i) => !isTransferItem(i));

  const activeCount = queue.filter(
    (i) =>
      i.status === "uploading" ||
      i.status === "queued" ||
      i.status === "processing",
  ).length;

  const problemCount = queue.filter(
    (i) =>
      i.status === "error" ||
      i.status === "duplicate" ||
      i.status === "unsupported" ||
      i.status === "needs_password",
  ).length;

  const uploadingCount = queue.filter((i) => i.status === "uploading").length;
  const processingCount = queue.filter((i) => i.status === "processing").length;
  const failedCount = queue.filter(
    (i) => i.status === "error" || i.status === "unsupported",
  ).length;

  const queuedInBackend = processingItems.filter(
    (i) =>
      i.status === "processing" &&
      (i.backendStatus === "queued" || !i.backendStatus),
  );

  // ── Upload menu dropdown ──────────────────────────────────────────────────

  const UploadMenu = (
    <div
      style={{
        position: "absolute",
        right: 0,
        top: "calc(100% + 4px)",
        width: 120,
        background: "#252C3E",
        border: "1px solid #3A4359",
        borderRadius: 8,
        overflow: "hidden",
        zIndex: 60,
      }}
    >
      <button
        onClick={() => {
          setShowUploadMenu(false);
          openFilePicker();
        }}
        className="w-full px-3 py-2 text-sm text-left text-vault-text-primary hover:bg-white/10"
      >
        Files
      </button>
      {!isMobile && (
        <button
          onClick={() => {
            setShowUploadMenu(false);
            openFolderPicker();
          }}
          className="w-full px-3 py-2 text-sm text-left text-vault-text-primary hover:bg-white/10"
        >
          Folder
        </button>
      )}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative" ref={panelRef}>
      <input
        ref={inputRef}
        type="file"
        multiple={!isMobile}
        accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.txt,.csv,.docx,.xlsx,.pptx,.mp3,.wav,.json"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* ── Trigger ──────────────────────────────────────────────────────── */}
      {queue.length === 0 ? (
        <div className="relative">
          <button
            onClick={handleUploadButtonClick}
            className="rounded-lg border border-vault-teal-border bg-vault-teal-bg px-3 py-1 text-sm text-vault-teal hover:bg-vault-teal hover:text-vault-bg transition-colors font-medium"
          >
            + Upload
          </button>
          {showUploadMenu && UploadMenu}
        </div>
      ) : (
        <button
          onClick={() => setPanelOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            borderRadius: 20,
            border: "1px solid rgba(0,212,170,0.28)",
            background: "rgba(0,212,170,0.12)",
            padding: "4px 12px",
            fontSize: 13,
            fontWeight: 500,
            color: "#00D4AA",
            cursor: "pointer",
          }}
        >
          {activeCount > 0 ? (
            <span
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#00D4AA",
                flexShrink: 0,
              }}
              className="animate-pulse"
            />
          ) : (
            <span
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: problemCount > 0 ? "#E53E3E" : "#7dba3a",
                flexShrink: 0,
              }}
            />
          )}
          <span>
            {activeCount > 0
              ? `${activeCount} active`
              : problemCount > 0
                ? `${problemCount} failed`
                : "All done"}
          </span>
        </button>
      )}

      {/* ── Panel ────────────────────────────────────────────────────────── */}
      {panelOpen && queue.length > 0 && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 380,
            maxWidth: "calc(100vw - 16px)",
            background: "#252C3E",
            border: "1px solid #3A4359",
            borderRadius: 12,
            zIndex: 50,
            overflow: "hidden",
            maxHeight: "calc(100vh - 120px)",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 12px 36px rgba(8,12,20,0.38)",
            fontFamily: "'Space Grotesk', sans-serif",
          }}
        >
          {/* Panel header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid #2E3448",
            }}
          >
            <div className="relative">
              <button
                onClick={handleUploadButtonClick}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "#00D4AA",
                  background: "rgba(0,212,170,0.08)",
                  border: "1px solid rgba(0,212,170,0.2)",
                  borderRadius: 6,
                  padding: "3px 10px",
                  cursor: "pointer",
                }}
              >
                + Add
              </button>
              {showUploadMenu && UploadMenu}
            </div>
            <button
              onClick={dismissDone}
              style={{
                fontSize: 11,
                color: "#8A93A8",
                cursor: "pointer",
                background: "none",
                border: "none",
              }}
              className="hover:text-vault-text-primary transition-colors"
            >
              Clear done
            </button>
          </div>

          {/* Scrollable section list */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {/* Processing section */}
            {processingItems.length > 0 && (
              <div>
                <SectionHeader
                  label="Processing"
                  Icon={IconCpu}
                  count={processingItems.length}
                />
                <ul>
                  {processingItems.map((item) => {
                    const queuePos = queuedInBackend.indexOf(item);
                    return (
                      <li
                        key={item.id}
                        style={{
                          padding: "8px 14px",
                          borderTop: "1px solid rgba(46,52,72,0.5)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <ItemIcon
                            status={item.status}
                            backendStatus={item.backendStatus}
                          />

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 12,
                                color:
                                  item.status === "done"
                                    ? "#8A93A8"
                                    : "#E2E8F0",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={item.filename}
                            >
                              {item.filename}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "#8A93A8",
                                marginTop: 1,
                              }}
                            >
                              {item.status === "done"
                                ? "Complete"
                                : item.status === "error"
                                  ? (item.error ?? "Processing failed")
                                  : item.status === "needs_password"
                                    ? "Password required"
                                    : item.backendStatus === "queued" ||
                                        !item.backendStatus
                                      ? queuePos >= 0
                                        ? `Queue position ${queuePos + 1}`
                                        : "Queued"
                                      : (item.stageLabel ?? "Processing")}
                            </div>
                          </div>

                          {/* Right badge */}
                          <span
                            style={{
                              ...stateBadgeStyle(
                                item.status,
                                item.backendStatus,
                              ),
                              fontSize: 10,
                              fontWeight: 500,
                              borderRadius: 4,
                              padding: "2px 6px",
                              flexShrink: 0,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.status === "done"
                              ? "Complete"
                              : item.status === "error"
                                ? "Failed"
                                : item.status === "needs_password"
                                  ? "Password"
                                  : item.backendStatus === "processing"
                                    ? "Processing"
                                    : "Queued"}
                          </span>

                          {item.status === "error" && (
                            <button
                              onClick={() => retryItem(item)}
                              style={{
                                fontSize: 11,
                                color: "#00D4AA",
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                flexShrink: 0,
                                fontWeight: 500,
                              }}
                            >
                              Retry
                            </button>
                          )}
                          {(item.status === "processing" ||
                            item.status === "needs_password") && (
                            <button
                              onClick={() => cancelItem(item)}
                              style={{
                                color: "#8A93A8",
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                flexShrink: 0,
                                lineHeight: 1,
                              }}
                              title="Cancel"
                            >
                              <IconX style={{ width: 12, height: 12 }} />
                            </button>
                          )}
                          {item.status === "done" &&
                            item.documentId &&
                            onDocumentSelect && (
                              <button
                                onClick={() => {
                                  onDocumentSelect(item.documentId!);
                                  setPanelOpen(false);
                                }}
                                style={{
                                  fontSize: 11,
                                  color: "#00D4AA",
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  flexShrink: 0,
                                  fontWeight: 500,
                                }}
                              >
                                Open
                              </button>
                            )}
                        </div>

                        {/* Password unlock UI */}
                        {item.status === "needs_password" && (
                          <div style={{ marginTop: 8, paddingLeft: 38 }}>
                            <p
                              style={{
                                fontSize: 11,
                                color: "#FBBF24",
                                marginBottom: 6,
                              }}
                            >
                              This PDF is password-protected.
                            </p>
                            <div style={{ display: "flex", gap: 6 }}>
                              <input
                                type="password"
                                value={passwords[item.id] ?? ""}
                                onChange={(e) =>
                                  setPasswords((p) => ({
                                    ...p,
                                    [item.id]: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleUnlock(item);
                                }}
                                placeholder="PDF password"
                                disabled={item.unlocking}
                                className="flex-1 rounded border border-vault-border bg-vault-input px-2 py-1 text-xs text-vault-text-primary placeholder-vault-text-muted focus:border-vault-teal focus:outline-none disabled:opacity-50"
                              />
                              <button
                                onClick={() => handleUnlock(item)}
                                disabled={item.unlocking || !passwords[item.id]}
                                className="text-xs px-2.5 py-1 rounded border border-yellow-700/60 bg-yellow-900/30 text-yellow-300 hover:border-yellow-600 disabled:opacity-40 transition-colors"
                              >
                                {item.unlocking ? "…" : "Unlock"}
                              </button>
                            </div>
                            {item.unlockError && (
                              <p
                                style={{
                                  fontSize: 11,
                                  color: "#E53E3E",
                                  marginTop: 4,
                                }}
                              >
                                {item.unlockError}
                              </p>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Divider between sections */}
            {processingItems.length > 0 && transferItems.length > 0 && (
              <div style={{ borderTop: "1px solid #2E3448" }} />
            )}

            {/* Transfer section */}
            {transferItems.length > 0 && (
              <div>
                <SectionHeader
                  label="Transfer"
                  Icon={IconUpload}
                  count={transferItems.length}
                />
                <ul>
                  {transferItems.map((item) => (
                    <li
                      key={item.id}
                      style={{
                        padding: "8px 14px",
                        borderTop: "1px solid rgba(46,52,72,0.5)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <ItemIcon
                          status={item.status}
                          backendStatus={item.backendStatus}
                        />

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              color:
                                item.status === "done" ||
                                item.status === "duplicate"
                                  ? "#8A93A8"
                                  : "#E2E8F0",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={item.filename}
                          >
                            {item.filename}
                          </div>
                          {item.status === "uploading" && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "#8A93A8",
                                marginTop: 1,
                              }}
                            >
                              {item.uploadedBytes != null &&
                              item.totalBytes != null
                                ? `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)}`
                                : `${item.progress}%`}
                            </div>
                          )}
                          {item.status === "queued" && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "#8A93A8",
                                marginTop: 1,
                              }}
                            >
                              Waiting…
                            </div>
                          )}
                          {(item.status === "error" ||
                            item.status === "unsupported") &&
                            item.error && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#E53E3E",
                                  marginTop: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={item.error}
                              >
                                {item.error}
                              </div>
                            )}
                          {item.status === "duplicate" && item.duplicateOf && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "#d4902a",
                                marginTop: 1,
                              }}
                            >
                              Already in vault
                            </div>
                          )}
                        </div>

                        {/* Right badge */}
                        <span
                          style={{
                            ...stateBadgeStyle(item.status, item.backendStatus),
                            fontSize: 10,
                            fontWeight: 500,
                            borderRadius: 4,
                            padding: "2px 6px",
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.status === "uploading"
                            ? `${item.progress}%`
                            : item.status === "queued"
                              ? "Queued"
                              : item.status === "duplicate"
                                ? "Duplicate"
                                : item.status === "unsupported"
                                  ? "Unsupported"
                                  : "Failed"}
                        </span>

                        {(item.status === "duplicate" ||
                          item.status === "unsupported") && (
                          <button
                            onClick={() => dismissItem(item.id)}
                            style={{
                              color: "#8A93A8",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              flexShrink: 0,
                              lineHeight: 1,
                            }}
                            title="Dismiss"
                          >
                            <IconX style={{ width: 12, height: 12 }} />
                          </button>
                        )}

                        {(item.status === "queued" ||
                          item.status === "uploading") && (
                          <button
                            onClick={() => cancelItem(item)}
                            style={{
                              color: "#8A93A8",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              flexShrink: 0,
                              lineHeight: 1,
                            }}
                            title="Cancel"
                          >
                            <IconX style={{ width: 12, height: 12 }} />
                          </button>
                        )}
                      </div>

                      {item.status === "uploading" && (
                        <div
                          style={{
                            marginTop: 6,
                            height: 2,
                            borderRadius: 1,
                            background: "#2A2F42",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              background: "#00D4AA",
                              width: `${item.progress}%`,
                              transition: "width 0.2s ease",
                            }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Panel footer */}
          <div
            style={{
              borderTop: "1px solid #2E3448",
              padding: "8px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 11, color: "#8A93A8" }}>
              {[
                uploadingCount > 0 && `${uploadingCount} uploading`,
                processingCount > 0 && `${processingCount} processing`,
                failedCount > 0 && `${failedCount} failed`,
              ]
                .filter(Boolean)
                .join(" · ") || (queue.length > 0 ? "All done" : "")}
            </span>
            <button
              style={{
                fontSize: 11,
                color: "#8A93A8",
                background: "none",
                border: "none",
                cursor: "default",
                opacity: 0.5,
              }}
            >
              View all
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
