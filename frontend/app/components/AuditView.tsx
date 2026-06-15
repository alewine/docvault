"use client";

import { useState, useCallback, useEffect, type ReactNode } from "react";
import Image from "next/image";
import { IconCopy } from "@tabler/icons-react";
import BACKEND_URL from "@/app/lib/backend";
import { apiGet, apiPost, apiPut, apiDelete } from "@/app/lib/api";
import { formatBytes } from "@/app/lib/formatBytes";
import type { FailedJob } from "@/app/lib/types";

interface OrphanedRecord {
  document_id: string;
  filename: string;
  original_path: string;
  uploaded_at: string;
}

interface OrphanedFile {
  path: string;
  filename: string;
  size_bytes: number | null;
  subdir: string;
}

interface DuplicateMember {
  id: string;
  filename: string;
  category: string;
  uploaded_at: string;
  file_size: number | null;
  similarity: number;
}

interface DuplicateCluster {
  anchor: DuplicateMember;
  members: DuplicateMember[];
  max_similarity: number;
  cluster_size: number;
}

interface AuditReport {
  orphaned_records: OrphanedRecord[];
  orphaned_files: OrphanedFile[];
  duplicates: DuplicateCluster[];
  summary: {
    orphaned_records: number;
    orphaned_files: number;
    duplicate_clusters: number;
    duplicate_documents: number;
  };
}

function SectionCard({
  title,
  descriptor,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  descriptor?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const hasIssues = count !== undefined && count > 0;
  const showBadge = count !== undefined;
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: `1px solid ${hasIssues ? "rgba(246,173,85,0.3)" : "#2E3448"}`,
      }}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-vault-surface hover:bg-vault-elevated transition-colors"
      >
        <span className="flex items-center gap-3">
          {showBadge && (
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 600,
                flexShrink: 0,
                ...(hasIssues
                  ? {
                      background: "rgba(246,173,85,0.1)",
                      color: "#F6AD55",
                      border: "1px solid rgba(246,173,85,0.3)",
                    }
                  : {
                      background: "#242838",
                      color: "#8A93A8",
                    }),
              }}
            >
              {count}
            </span>
          )}
          <span
            className="text-left"
            style={{ fontSize: 14, fontWeight: 500, color: "#E2E8F0" }}
          >
            {title}
            {descriptor && (
              <span style={{ fontSize: 13, fontWeight: 400, color: "#8A93A8" }}>
                {" "}
                — {descriptor}
              </span>
            )}
          </span>
        </span>
        <span style={{ color: "#8A93A8", fontSize: 11 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div
          style={{
            borderTop: `1px solid ${hasIssues ? "rgba(246,173,85,0.12)" : "#2E3448"}`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const TH_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#8A93A8",
  fontWeight: 500,
};

function FailedJobsSection({
  jobs,
  loading,
  actionError,
  copiedErrorId,
  open,
  onToggle,
  onRetry,
  onDismiss,
  onCopyError,
}: {
  jobs: FailedJob[];
  loading: boolean;
  actionError: string | null;
  copiedErrorId: string | null;
  open: boolean;
  onToggle: () => void;
  onRetry: (docId: string) => void;
  onDismiss: (docId: string) => void;
  onCopyError: (job: FailedJob) => void;
}) {
  return (
    <SectionCard
      title="Failed uploads"
      count={jobs.length}
      open={open}
      onToggle={onToggle}
    >
      {actionError && (
        <p className="px-4 py-2 text-sm text-red-400">{actionError}</p>
      )}
      {loading ? (
        <p className="px-4 py-4 text-sm text-vault-text-muted">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="px-4 py-4 text-sm text-vault-text-muted">
          No failed uploads.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead style={{ background: "#242838" }}>
            <tr>
              <th className="px-3 py-2 text-left" style={TH_STYLE}>
                Filename
              </th>
              <th className="px-3 py-2 text-left" style={TH_STYLE}>
                Uploaded
              </th>
              <th className="px-3 py-2 text-left" style={TH_STYLE}>
                Error
              </th>
              <th className="px-3 py-2 w-28" style={TH_STYLE}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-vault-border">
            {jobs.map((j) => (
              <tr key={j.document_id} className="hover:bg-vault-elevated">
                <td
                  className="px-3 py-2 font-medium max-w-[14rem] truncate text-vault-text-primary"
                  title={j.filename}
                >
                  {j.filename}
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap text-vault-text-muted">
                  {j.uploaded_at
                    ? new Date(j.uploaded_at).toLocaleDateString()
                    : "—"}
                </td>
                <td className="px-3 py-2 text-xs max-w-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-red-400 truncate"
                      title={j.error_message || "Unknown error"}
                    >
                      {j.error_message || "Unknown error"}
                    </span>
                    <button
                      type="button"
                      onClick={() => onCopyError(j)}
                      className="flex-shrink-0 transition-colors"
                      style={{
                        color:
                          copiedErrorId === j.document_id
                            ? "#E2E8F0"
                            : "#8A93A8",
                      }}
                      title={
                        copiedErrorId === j.document_id
                          ? "Copied"
                          : "Copy full error"
                      }
                      aria-label={
                        copiedErrorId === j.document_id
                          ? "Error copied"
                          : "Copy full error"
                      }
                    >
                      <IconCopy size={16} />
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => onRetry(j.document_id)}
                    className="text-xs mr-3 transition-colors text-vault-teal hover:text-vault-teal-hover"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => onDismiss(j.document_id)}
                    className="text-xs text-vault-text-muted hover:text-red-400 transition-colors"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

type OrphanItem =
  | {
      kind: "record";
      document_id: string;
      filename: string;
      original_path: string;
      uploaded_at: string;
    }
  | {
      kind: "file";
      path: string;
      filename: string;
      size_bytes: number | null;
      subdir: string;
    };

function OrphanedItemsSection({
  records,
  files,
  selectedOrphans,
  cleaning,
  onToggleItem,
  onSelectAll,
  onConfirmDelete,
  autoCleanupEnabled,
  open,
  onToggle,
}: {
  records: OrphanedRecord[];
  files: OrphanedFile[];
  selectedOrphans: Set<string>;
  cleaning: boolean;
  onToggleItem: (key: string) => void;
  onSelectAll: (keys: Set<string>) => void;
  onConfirmDelete: () => void;
  autoCleanupEnabled: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const totalCount = records.length + files.length;
  const items: OrphanItem[] = [
    ...records.map((r): OrphanItem => ({ kind: "record", ...r })),
    ...files.map((f): OrphanItem => ({ kind: "file", ...f })),
  ];
  const allKeys = new Set(
    items.map((item) =>
      item.kind === "record" ? item.document_id : item.path,
    ),
  );
  const selectedCount = selectedOrphans.size;

  return (
    <SectionCard
      title="Orphaned items"
      count={totalCount}
      open={open}
      onToggle={onToggle}
    >
      {autoCleanupEnabled && (
        <p
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs"
          style={{
            color: "#8A93A8",
            borderBottom: "1px solid #2E3448",
            background: "rgba(0,212,170,0.04)",
          }}
        >
          <i
            className="ti ti-sparkles"
            style={{ fontSize: 13, color: "#00D4AA" }}
          />
          Auto-cleanup is on — orphaned processed files are removed daily.
          Originals are never auto-deleted.
        </p>
      )}
      {totalCount === 0 ? (
        <p className="px-4 py-4 text-sm text-vault-text-muted">
          No orphaned items found.
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead style={{ background: "#242838" }}>
              <tr>
                <th className="px-3 py-2 text-left w-8" style={TH_STYLE}>
                  <input
                    type="checkbox"
                    checked={totalCount > 0 && selectedCount === totalCount}
                    onChange={(e) =>
                      onSelectAll(e.target.checked ? allKeys : new Set())
                    }
                    style={{ accentColor: "#00D4AA" }}
                  />
                </th>
                <th className="px-3 py-2 text-left" style={TH_STYLE}>
                  Type
                </th>
                <th className="px-3 py-2 text-left" style={TH_STYLE}>
                  Filename
                </th>
                <th className="px-3 py-2 text-left" style={TH_STYLE}>
                  Detail
                </th>
                <th className="px-3 py-2 text-right" style={TH_STYLE}>
                  Secondary
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vault-border">
              {items.map((item) => {
                const key =
                  item.kind === "record" ? item.document_id : item.path;
                return (
                  <tr key={key} className="hover:bg-vault-elevated">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedOrphans.has(key)}
                        onChange={() => onToggleItem(key)}
                        style={{ accentColor: "#00D4AA" }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span
                        style={{
                          background: "#2A2F42",
                          color: "#8A93A8",
                          fontSize: 11,
                          borderRadius: 5,
                          padding: "3px 8px",
                        }}
                      >
                        {item.kind === "record" ? "DB record" : "NAS file"}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium text-vault-text-primary">
                      {item.filename}
                    </td>
                    <td className="px-3 py-2">
                      {item.kind === "record" ? (
                        <span className="font-mono text-xs truncate block max-w-xs text-vault-text-muted">
                          {item.original_path}
                        </span>
                      ) : (
                        <span
                          style={{
                            background: "#2A2F42",
                            color: "#8A93A8",
                            fontSize: 11,
                            borderRadius: 5,
                            padding: "3px 8px",
                          }}
                        >
                          {item.subdir}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-vault-text-muted">
                      {item.kind === "record"
                        ? item.uploaded_at
                          ? new Date(item.uploaded_at).toLocaleDateString()
                          : "—"
                        : formatBytes(item.size_bytes)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="flex items-center justify-between"
            style={{
              background: "rgba(0,212,170,0.05)",
              borderTop: "1px solid rgba(0,212,170,0.25)",
              padding: "12px 20px",
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: selectedCount > 0 ? "#00D4AA" : "#8A93A8",
              }}
            >
              {selectedCount > 0
                ? `${selectedCount} item${selectedCount !== 1 ? "s" : ""} selected`
                : "No items selected"}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => onSelectAll(allKeys)}
                className="text-xs text-vault-text-muted hover:text-vault-text-primary transition-colors"
                style={{
                  border: "1px solid #3A4055",
                  padding: "5px 12px",
                  borderRadius: 6,
                  background: "transparent",
                }}
              >
                Select all
              </button>
              <button
                onClick={onConfirmDelete}
                disabled={selectedCount === 0 || cleaning}
                className="flex items-center gap-1.5 text-xs font-medium disabled:opacity-40 transition-opacity"
                style={{
                  background: "rgba(239,68,68,0.18)",
                  border: "1px solid rgba(248,113,113,0.45)",
                  color: "#FCA5A5",
                  padding: "5px 12px",
                  borderRadius: 6,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
                }}
              >
                <i className="ti ti-trash" style={{ fontSize: 14 }} />
                {cleaning ? "Deleting…" : "Delete selected"}
              </button>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

function DuplicateClustersSection({
  duplicates,
  dismissedClusterIds,
  clusterSelections,
  open,
  onToggle,
  onDismissCluster,
  onToggleClusterDoc,
  onPreview,
  onDeleteConfirm,
}: {
  duplicates: DuplicateCluster[];
  dismissedClusterIds: Set<string>;
  clusterSelections: Record<string, Set<string>>;
  open: boolean;
  onToggle: () => void;
  onDismissCluster: (clusterId: string) => void;
  onToggleClusterDoc: (clusterId: string, docId: string) => void;
  onPreview: (docId: string) => void;
  onDeleteConfirm: (clusterId: string) => void;
}) {
  const visibleClusters = duplicates.filter(
    (c) => !dismissedClusterIds.has(c.anchor.id),
  );
  const liveClusterCount = visibleClusters.length;
  const liveDocCount = visibleClusters.reduce(
    (sum, c) => sum + c.cluster_size,
    0,
  );
  return (
    <SectionCard
      title="Duplicate candidates"
      count={liveClusterCount}
      descriptor={
        liveClusterCount > 0
          ? `${liveClusterCount} cluster${liveClusterCount !== 1 ? "s" : ""} · ${liveDocCount} document${liveDocCount !== 1 ? "s" : ""}`
          : undefined
      }
      open={open}
      onToggle={onToggle}
    >
      {visibleClusters.length === 0 ? (
        <p className="px-4 py-4 text-sm text-vault-text-muted">
          No duplicate candidates found.
        </p>
      ) : (
        <div>
          {visibleClusters.map((cluster, clusterIndex) => {
            const clusterId = cluster.anchor.id;
            const selected = clusterSelections[clusterId] ?? new Set<string>();
            const selectedCount = selected.size;
            const simPct =
              cluster.max_similarity < 1.0
                ? `${(cluster.max_similarity * 100).toFixed(2)}% match`
                : "Exact match";
            return (
              <div key={clusterId}>
                {clusterIndex > 0 && (
                  <div
                    style={{
                      height: 3,
                      background: "#232840",
                      borderTop: "1px solid #2E3448",
                      borderBottom: "1px solid #2E3448",
                    }}
                  />
                )}
                <div
                  style={{
                    padding: 16,
                    borderRadius: 4,
                    background:
                      clusterIndex % 2 === 1
                        ? "rgba(255,255,255,0.025)"
                        : "transparent",
                  }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 5,
                          fontSize: 12,
                          fontWeight: 600,
                          background: "#2A2F42",
                          color: "#E2E8F0",
                        }}
                      >
                        {cluster.cluster_size} documents
                      </span>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 5,
                          fontSize: 12,
                          fontWeight: 500,
                          background: "rgba(246,173,85,0.12)",
                          color: "#F6AD55",
                          border: "1px solid rgba(246,173,85,0.3)",
                        }}
                      >
                        {simPct}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => onDeleteConfirm(clusterId)}
                        disabled={selectedCount === 0}
                        className="flex items-center gap-1 transition-opacity transition-colors hover:bg-red-900/30"
                        style={{
                          background: "rgba(229,62,62,0.12)",
                          border: "1px solid rgba(229,62,62,0.8)",
                          color: "#FC4444",
                          borderRadius: 4,
                          fontSize: 10,
                          padding: "2px 6px",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          opacity: selectedCount === 0 ? 0.35 : 1,
                          cursor: selectedCount === 0 ? "default" : "pointer",
                        }}
                      >
                        <i className="ti ti-trash" style={{ fontSize: 11 }} />
                        {selectedCount > 0
                          ? `Delete selected (${selectedCount})`
                          : "Delete selected"}
                      </button>
                      <button
                        onClick={() => onDismissCluster(clusterId)}
                        className="text-xs transition-colors text-vault-text-muted hover:text-vault-text-primary flex-shrink-0"
                        style={{
                          border: "1px solid #3A4055",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "transparent",
                          fontSize: 10,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <i
                          className="ti ti-circle-x"
                          style={{ fontSize: 11 }}
                        />
                        Not duplicates
                      </button>
                    </div>
                  </div>
                  <ClusterDocRow
                    member={cluster.anchor}
                    isAnchor
                    checked={selected.has(cluster.anchor.id)}
                    onToggle={() =>
                      onToggleClusterDoc(clusterId, cluster.anchor.id)
                    }
                    onPreview={onPreview}
                  />
                  {cluster.members.map((member) => (
                    <ClusterDocRow
                      key={member.id}
                      member={member}
                      isAnchor={false}
                      checked={selected.has(member.id)}
                      onToggle={() => onToggleClusterDoc(clusterId, member.id)}
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

export default function AuditView() {
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [failedLoading, setFailedLoading] = useState(true);
  const [jobActionError, setJobActionError] = useState<string | null>(null);
  const [copiedErrorId, setCopiedErrorId] = useState<string | null>(null);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    failed: true,
    orphans: true,
    scheduledCleanup: true,
    duplicates: true,
    dangerZone: false,
  });

  const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(
    new Set(),
  );
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{
    filename: string;
    original_ext: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);

  const [autoCleanupEnabled, setAutoCleanupEnabled] = useState(false);
  const [autoCleanupSaving, setAutoCleanupSaving] = useState(false);

  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [reprocessModalOpen, setReprocessModalOpen] = useState(false);
  const [reprocessResult, setReprocessResult] = useState<string | null>(null);

  // Per-cluster checkbox state: clusterId (anchor.id) -> Set of selected doc IDs
  const [clusterSelections, setClusterSelections] = useState<
    Record<string, Set<string>>
  >({});
  const [dismissedClusterIds, setDismissedClusterIds] = useState<Set<string>>(
    new Set(),
  );
  const [clusterConfirmData, setClusterConfirmData] = useState<{
    clusterId: string;
    docIds: string[];
  } | null>(null);

  const toggleSection = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const fetchFailedJobs = useCallback(async () => {
    setFailedLoading(true);
    try {
      const data = await apiGet<{ failed_jobs?: FailedJob[] }>(`/jobs/failed`);
      setFailedJobs(data.failed_jobs ?? []);
    } catch {
      /* non-critical */
    } finally {
      setFailedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFailedJobs();
  }, [fetchFailedJobs]);

  useEffect(() => {
    runAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiGet<{ enabled?: boolean }>(`/settings/auto-cleanup`)
      .then((data) => setAutoCleanupEnabled(Boolean(data.enabled)))
      .catch(() => {});
  }, []);

  const toggleAutoCleanup = useCallback(async () => {
    const next = !autoCleanupEnabled;
    setAutoCleanupEnabled(next);
    setAutoCleanupSaving(true);
    try {
      await apiPut(`/settings/auto-cleanup`, { enabled: next });
    } catch (e) {
      console.error("Auto-cleanup toggle error:", e);
      setAutoCleanupEnabled(!next); // revert on failure
    } finally {
      setAutoCleanupSaving(false);
    }
  }, [autoCleanupEnabled]);

  const runFactoryReset = async () => {
    setResetting(true);
    setResetResult(null);
    try {
      await apiPost(`/admin/factory-reset`);
      setResetResult({ ok: true, msg: "Factory reset complete. Reloading…" });
      window.setTimeout(() => window.location.reload(), 1500);
    } catch (e: unknown) {
      setResetResult({
        ok: false,
        msg: `Reset failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setResetting(false);
      setResetModalOpen(false);
      setResetInput("");
    }
  };

  const runReprocessAll = async () => {
    setReprocessModalOpen(false);
    try {
      const data = await apiPost<{ requeued: number }>(`/jobs/reprocess-all`);
      setReprocessResult(
        `Requeued ${data.requeued} document${data.requeued !== 1 ? "s" : ""} — watch progress in the nav bar`,
      );
    } catch (e: unknown) {
      setReprocessResult(
        `Reprocess failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const handleRetry = async (docId: string) => {
    const removed = failedJobs.find((j) => j.document_id === docId);
    setFailedJobs((prev) => prev.filter((j) => j.document_id !== docId));
    try {
      await apiPost(`/document/${docId}/reprocess`);
      setJobActionError(null);
    } catch (e: unknown) {
      if (removed) setFailedJobs((prev) => [removed, ...prev]);
      setJobActionError(e instanceof Error ? e.message : "Retry failed");
    }
  };

  const handleDismiss = async (docId: string) => {
    const removed = failedJobs.find((j) => j.document_id === docId);
    setFailedJobs((prev) => prev.filter((j) => j.document_id !== docId));
    try {
      await apiDelete(`/document/${docId}`);
      setJobActionError(null);
    } catch (e: unknown) {
      if (removed) setFailedJobs((prev) => [removed, ...prev]);
      setJobActionError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleCopyError = useCallback(async (job: FailedJob) => {
    const errorText = job.error_message || "Unknown error";
    try {
      await navigator.clipboard.writeText(errorText);
      setCopiedErrorId(job.document_id);
      window.setTimeout(() => {
        setCopiedErrorId((prev) => (prev === job.document_id ? null : prev));
      }, 1500);
    } catch {
      setCopiedErrorId(null);
    }
  }, []);

  const runAudit = useCallback(async () => {
    setAuditing(true);
    setAuditError(null);
    setCleanResult(null);
    setSelectedOrphans(new Set());
    setClusterSelections({});
    try {
      const data = await apiPost<AuditReport>(`/audit/audit`);
      setAudit(data);
      setLastRun(new Date().toLocaleString());
      // Draw attention when there are orphans; collapse when there are none.
      const orphanCount =
        data.orphaned_records.length + data.orphaned_files.length;
      setOpenSections((prev) => ({ ...prev, orphans: orphanCount > 0 }));
    } catch (e: unknown) {
      setAuditError(e instanceof Error ? e.message : "Audit failed");
    } finally {
      setAuditing(false);
    }
  }, []);

  const totalSelected = selectedOrphans.size;

  const runCleanup = async () => {
    setCleaning(true);
    setConfirmOpen(false);
    const recordIds = new Set(
      audit?.orphaned_records.map((r) => r.document_id) ?? [],
    );
    const actions: {
      action: string;
      target_id?: string;
      target_path?: string;
    }[] = Array.from(selectedOrphans).map((key) =>
      recordIds.has(key)
        ? { action: "delete_orphan_record", target_id: key }
        : { action: "delete_orphan_file", target_path: key },
    );
    try {
      const data = await apiPost<{ completed: number }>(`/audit/cleanup`, {
        actions,
      });
      setCleanResult(
        `${data.completed} of ${actions.length} actions completed.`,
      );
      setSelectedOrphans(new Set());
      await runAudit();
    } catch (e: unknown) {
      setCleanResult(
        `Cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setCleaning(false);
    }
  };

  const toggleOrphan = (key: string) =>
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleClusterDoc = (clusterId: string, docId: string) => {
    setClusterSelections((prev) => {
      const set = new Set(prev[clusterId] ?? []);
      if (set.has(docId)) set.delete(docId);
      else set.add(docId);
      return { ...prev, [clusterId]: set };
    });
  };

  const dismissCluster = async (clusterId: string) => {
    const cluster = audit?.duplicates.find((c) => c.anchor.id === clusterId);
    if (cluster) {
      const doc_ids = [cluster.anchor.id, ...cluster.members.map((m) => m.id)];
      try {
        await apiPost(`/audit/dismiss-cluster`, { doc_ids });
      } catch (e) {
        console.error("Failed to persist dismiss-cluster:", e);
      }
    }
    setDismissedClusterIds((prev) => {
      const next = new Set(prev);
      next.add(clusterId);
      return next;
    });
  };

  const openClusterDeleteConfirm = (clusterId: string) => {
    const docIds = Array.from(clusterSelections[clusterId] ?? []);
    if (docIds.length === 0) return;
    setClusterConfirmData({ clusterId, docIds });
  };

  const runClusterDelete = async () => {
    if (!clusterConfirmData) return;
    const { clusterId, docIds } = clusterConfirmData;
    setClusterConfirmData(null);
    const actions = docIds.map((id) => ({
      action: "delete_duplicate",
      target_id: id,
    }));
    try {
      await apiPost(`/audit/cleanup`, { actions });
    } catch (e) {
      console.error("Failed to delete cluster docs", e);
      return;
    }
    const deletedSet = new Set(docIds);
    setAudit((prev) => {
      if (!prev) return prev;
      const updatedDups = prev.duplicates
        .map((c): DuplicateCluster | null => {
          if (c.anchor.id !== clusterId) return c;
          if (deletedSet.has(c.anchor.id)) return null;
          const newMembers = c.members.filter((m) => !deletedSet.has(m.id));
          if (newMembers.length === 0) return null;
          return {
            ...c,
            members: newMembers,
            cluster_size: 1 + newMembers.length,
            max_similarity: newMembers[0].similarity,
          };
        })
        .filter((c): c is DuplicateCluster => c !== null);
      return {
        ...prev,
        duplicates: updatedDups,
        summary: {
          ...prev.summary,
          duplicate_clusters: updatedDups.length,
          duplicate_documents: updatedDups.reduce(
            (acc, c) => acc + c.cluster_size - 1,
            0,
          ),
        },
      };
    });
    setClusterSelections((prev) => {
      const next = { ...prev };
      delete next[clusterId];
      return next;
    });
  };

  const openPreview = async (docId: string | null) => {
    if (!docId) {
      setPreviewDocId(null);
      setPreviewDoc(null);
      setPreviewLoading(false);
      return;
    }

    setPreviewDocId(docId);
    setPreviewLoading(true);
    setPreviewDoc(null);
    try {
      const data = await apiGet<{ filename: string; original_ext: string }>(
        `/document/${docId}`,
      );
      setPreviewDoc({
        filename: data.filename,
        original_ext: data.original_ext,
      });
    } catch (e) {
      console.error("Failed to fetch document for preview", e);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = useCallback(() => {
    setPreviewDocId(null);
    setPreviewDoc(null);
  }, []);

  useEffect(() => {
    if (!previewDocId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePreview();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewDocId, closePreview]);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <style>{`
        @keyframes audit-spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes audit-progress-slide {
          0% {
            transform: translateX(-140%);
          }

          100% {
            transform: translateX(360%);
          }
        }
      `}</style>

      {/* Header */}
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-vault-text-primary">Audit</h1>
        {auditing && (
          <p className="text-xs text-vault-text-muted mt-0.5 flex items-center gap-1.5">
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                animation: "audit-spin 0.8s linear infinite",
              }}
            >
              <circle
                cx="8"
                cy="8"
                r="5.5"
                fill="none"
                stroke="rgba(246,173,85,0.22)"
                strokeWidth="2"
              />
              <path
                d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
                fill="none"
                stroke="rgba(246,173,85,0.95)"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
            <span>Scanning…</span>
          </p>
        )}
        {lastRun && (
          <p className="text-xs text-vault-text-muted mt-0.5 flex items-center gap-2">
            <span>Last audit: {lastRun}</span>
            <button
              type="button"
              onClick={runAudit}
              disabled={auditing}
              className="text-xs text-vault-teal transition-colors hover:text-vault-teal-hover disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                border: "1px solid #3A4055",
                padding: "2px 8px",
                borderRadius: 9999,
                background: "transparent",
              }}
            >
              Re-run
            </button>
          </p>
        )}
        {auditing && (
          <div
            aria-hidden="true"
            className="relative w-full overflow-hidden rounded-full"
            style={{ height: 4, background: "rgba(246,173,85,0.12)" }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: "34%",
                background:
                  "linear-gradient(90deg, rgba(246,173,85,0), rgba(246,173,85,0.92), rgba(246,173,85,0))",
                boxShadow: "0 0 16px rgba(246,173,85,0.32)",
                animation: "audit-progress-slide 1.4s ease-in-out infinite",
              }}
            />
          </div>
        )}
      </div>

      {/* Alerts */}
      {auditError && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {auditError}
        </div>
      )}
      {cleanResult && (
        <div className="rounded-lg border border-green-800 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          {cleanResult}
        </div>
      )}

      {/* Failed uploads */}
      <FailedJobsSection
        jobs={failedJobs}
        loading={failedLoading}
        actionError={jobActionError}
        copiedErrorId={copiedErrorId}
        open={openSections.failed}
        onToggle={() => toggleSection("failed")}
        onRetry={handleRetry}
        onDismiss={handleDismiss}
        onCopyError={handleCopyError}
      />

      {/* Orphaned items */}
      {audit && (
        <OrphanedItemsSection
          records={audit.orphaned_records}
          files={audit.orphaned_files}
          selectedOrphans={selectedOrphans}
          cleaning={cleaning}
          onToggleItem={toggleOrphan}
          onSelectAll={setSelectedOrphans}
          onConfirmDelete={() => setConfirmOpen(true)}
          autoCleanupEnabled={autoCleanupEnabled}
          open={openSections.orphans}
          onToggle={() => toggleSection("orphans")}
        />
      )}

      {/* Duplicate clusters */}
      {audit && (
        <DuplicateClustersSection
          duplicates={audit.duplicates}
          dismissedClusterIds={dismissedClusterIds}
          clusterSelections={clusterSelections}
          open={openSections.duplicates}
          onToggle={() => toggleSection("duplicates")}
          onDismissCluster={dismissCluster}
          onToggleClusterDoc={toggleClusterDoc}
          onPreview={openPreview}
          onDeleteConfirm={openClusterDeleteConfirm}
        />
      )}

      {/* Scheduled cleanup */}
      <SectionCard
        title="Scheduled Cleanup"
        open={openSections.scheduledCleanup}
        onToggle={() => toggleSection("scheduledCleanup")}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: 20,
          }}
        >
          <div>
            <div style={{ color: "#E2E8F0", fontSize: 14, fontWeight: 500 }}>
              Auto-cleanup orphaned files
            </div>
            <p
              style={{
                color: "#8A93A8",
                fontSize: 12,
                marginTop: 4,
                maxWidth: 460,
                lineHeight: 1.5,
              }}
            >
              Once a day, delete leftover processed text and thumbnail files
              that no longer belong to any document. Original uploads are never
              touched.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoCleanupEnabled}
            aria-label="Toggle auto-cleanup of orphaned files"
            onClick={toggleAutoCleanup}
            disabled={autoCleanupSaving}
            style={{
              position: "relative",
              width: 44,
              height: 24,
              borderRadius: 999,
              flexShrink: 0,
              border: "none",
              cursor: autoCleanupSaving ? "default" : "pointer",
              background: autoCleanupEnabled ? "#00D4AA" : "#2A2F42",
              transition: "background 0.15s",
              opacity: autoCleanupSaving ? 0.6 : 1,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: autoCleanupEnabled ? 23 : 3,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.15s",
              }}
            />
          </button>
        </div>
      </SectionCard>

      {/* Danger Zone */}
      <section
        style={{
          border: "1px solid rgba(229,62,62,0.35)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <button
          onClick={() => toggleSection("dangerZone")}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            background: openSections.dangerZone
              ? "rgba(229,62,62,0.08)"
              : "rgba(229,62,62,0.04)",
            border: "none",
            cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <i
              className="ti ti-alert-triangle"
              style={{ fontSize: 14, color: "#E53E3E" }}
            />
            <span style={{ fontSize: 14, fontWeight: 500, color: "#FC8181" }}>
              Danger Zone
            </span>
          </span>
          <span style={{ color: "#8A93A8", fontSize: 11 }}>
            {openSections.dangerZone ? "▲" : "▼"}
          </span>
        </button>

        {openSections.dangerZone && (
          <div
            style={{
              borderTop: "1px solid rgba(229,62,62,0.25)",
              background: "rgba(229,62,62,0.04)",
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <p style={{ fontSize: 13, color: "#8A93A8" }}>
              These actions are irreversible. All documents, metadata, tags, and
              NAS files will be permanently deleted.
            </p>

            {resetResult && (
              <div
                style={{
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  background: resetResult.ok
                    ? "rgba(0,212,170,0.08)"
                    : "rgba(229,62,62,0.08)",
                  border: `1px solid ${resetResult.ok ? "rgba(0,212,170,0.3)" : "rgba(229,62,62,0.3)"}`,
                  color: resetResult.ok ? "#00D4AA" : "#FC8181",
                }}
              >
                {resetResult.msg}
              </div>
            )}
            {reprocessResult && (
              <div
                style={{
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  background: reprocessResult.startsWith("Requeued")
                    ? "rgba(0,212,170,0.08)"
                    : "rgba(229,62,62,0.08)",
                  border: `1px solid ${reprocessResult.startsWith("Requeued") ? "rgba(0,212,170,0.3)" : "rgba(229,62,62,0.3)"}`,
                  color: reprocessResult.startsWith("Requeued")
                    ? "#00D4AA"
                    : "#FC8181",
                }}
              >
                {reprocessResult}
              </div>
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <p style={{ fontSize: 13, fontWeight: 500, color: "#E2E8F0" }}>
                  Reprocess All Documents
                </p>
                <p style={{ fontSize: 12, color: "#8A93A8", marginTop: 2 }}>
                  Re-run OCR, embedding, and indexing on every document.
                </p>
              </div>
              <button
                onClick={() => {
                  setReprocessModalOpen(true);
                  setReprocessResult(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  background: "rgba(229,62,62,0.12)",
                  border: "1px solid rgba(229,62,62,0.4)",
                  color: "#FC8181",
                  padding: "7px 16px",
                  borderRadius: 7,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <i className="ti ti-refresh" style={{ fontSize: 15 }} />
                Reprocess All
              </button>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <p style={{ fontSize: 13, fontWeight: 500, color: "#E2E8F0" }}>
                  Factory Reset
                </p>
                <p style={{ fontSize: 12, color: "#8A93A8", marginTop: 2 }}>
                  Wipes all database records, search vectors, and NAS files.
                </p>
              </div>
              <button
                onClick={() => {
                  setResetModalOpen(true);
                  setResetInput("");
                  setResetResult(null);
                }}
                disabled={resetting}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  background: "rgba(229,62,62,0.12)",
                  border: "1px solid rgba(229,62,62,0.4)",
                  color: "#FC8181",
                  padding: "7px 16px",
                  borderRadius: 7,
                  cursor: resetting ? "not-allowed" : "pointer",
                  opacity: resetting ? 0.4 : 1,
                  flexShrink: 0,
                }}
              >
                <i className="ti ti-refresh-alert" style={{ fontSize: 15 }} />
                Factory Reset
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Reprocess all modal */}
      {reprocessModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.6)",
          }}
        >
          <div
            style={{
              background: "#1C2030",
              border: "1px solid rgba(229,62,62,0.4)",
              borderRadius: 12,
              padding: 24,
              maxWidth: 384,
              width: "100%",
              margin: "0 16px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i
                className="ti ti-refresh"
                style={{ fontSize: 20, color: "#E53E3E" }}
              />
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#FC8181",
                  margin: 0,
                }}
              >
                Reprocess All Documents
              </h2>
            </div>
            <p style={{ fontSize: 13, color: "#8A93A8", lineHeight: 1.6 }}>
              This will requeue every document for OCR, embedding, and indexing.
              Existing extracted text will be overwritten. This may take a long
              time depending on your library size. Continue?
            </p>
            <div
              style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => setReprocessModalOpen(false)}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "#8A93A8",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={runReprocessAll}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  background: "rgba(229,62,62,0.15)",
                  border: "1px solid rgba(229,62,62,0.5)",
                  color: "#FC8181",
                  cursor: "pointer",
                }}
              >
                Reprocess All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory reset modal */}
      {resetModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
          }}
        >
          <div
            style={{
              background: "#1C2030",
              border: "1px solid rgba(229,62,62,0.4)",
              borderRadius: 12,
              padding: 24,
              maxWidth: 384,
              width: "100%",
              margin: "0 16px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i
                className="ti ti-alert-triangle"
                style={{ fontSize: 20, color: "#E53E3E" }}
              />
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#FC8181",
                  margin: 0,
                }}
              >
                Factory Reset
              </h2>
            </div>
            <p style={{ fontSize: 13, color: "#8A93A8", lineHeight: 1.6 }}>
              This will permanently delete{" "}
              <span style={{ fontWeight: 600, color: "#E2E8F0" }}>
                all documents, tags, jobs, search vectors, and NAS files
              </span>
              . There is no undo.
            </p>
            <p style={{ fontSize: 13, color: "#8A93A8" }}>
              Type{" "}
              <span
                style={{
                  fontFamily: "monospace",
                  fontWeight: 600,
                  color: "#FC8181",
                }}
              >
                RESET
              </span>{" "}
              to confirm.
            </p>
            <input
              type="text"
              value={resetInput}
              onChange={(e) => setResetInput(e.target.value)}
              placeholder="Type RESET"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && resetInput === "RESET")
                  runFactoryReset();
              }}
              style={{
                width: "100%",
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 13,
                background: "#242838",
                border: `1px solid ${resetInput === "RESET" ? "rgba(229,62,62,0.6)" : "#3A4055"}`,
                color: "#E2E8F0",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => {
                  setResetModalOpen(false);
                  setResetInput("");
                }}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "#8A93A8",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={runFactoryReset}
                disabled={resetInput !== "RESET" || resetting}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  background: "rgba(229,62,62,0.15)",
                  border: "1px solid rgba(229,62,62,0.5)",
                  color: "#FC8181",
                  cursor:
                    resetInput !== "RESET" || resetting
                      ? "not-allowed"
                      : "pointer",
                  opacity: resetInput !== "RESET" || resetting ? 0.3 : 1,
                }}
              >
                {resetting ? "Resetting…" : "Confirm reset"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewDocId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="rounded-xl overflow-hidden flex flex-col"
            style={{
              background: "#1C2030",
              border: "1px solid #2E3448",
              width: "min(90vw, 860px)",
              maxHeight: "90vh",
            }}
          >
            <div
              className="flex items-center justify-between flex-shrink-0"
              style={{
                borderBottom: "1px solid #2E3448",
                background: "#242838",
                padding: "12px 20px",
              }}
            >
              <span className="text-sm font-medium text-vault-text-primary truncate">
                {previewLoading
                  ? "Loading…"
                  : (previewDoc?.filename ?? previewDocId)}
              </span>
              <button
                onClick={closePreview}
                className="flex-shrink-0 transition-colors text-vault-text-muted hover:text-vault-text-primary"
                style={{ marginLeft: 16 }}
                aria-label="Close preview"
              >
                <i className="ti ti-x" style={{ fontSize: 18 }} />
              </button>
            </div>
            <div className="flex-1 overflow-auto" style={{ minHeight: 0 }}>
              {previewLoading ? (
                <div
                  className="flex items-center justify-center"
                  style={{ height: 256 }}
                >
                  <span className="text-sm text-vault-text-muted">
                    Loading preview…
                  </span>
                </div>
              ) : previewDoc ? (
                (() => {
                  const ext = previewDoc.original_ext?.toLowerCase();
                  const isImage = [
                    ".jpg",
                    ".jpeg",
                    ".png",
                    ".heic",
                    ".heif",
                  ].includes(ext ?? "");
                  if (isImage) {
                    return (
                      <Image
                        src={`${BACKEND_URL}/original/${previewDocId}`}
                        alt={previewDoc.filename}
                        width={1200}
                        height={1600}
                        unoptimized
                        className="w-full"
                        style={{ height: "auto" }}
                      />
                    );
                  }
                  return (
                    <iframe
                      src={`${BACKEND_URL}/original/${previewDocId}`}
                      title={previewDoc.filename}
                      style={{
                        width: "100%",
                        height: "75vh",
                        border: "none",
                        display: "block",
                      }}
                    />
                  );
                })()
              ) : (
                <div
                  className="flex items-center justify-center"
                  style={{ height: 256 }}
                >
                  <span className="text-sm text-vault-text-muted">
                    Preview unavailable.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal — orphan records/files */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            className="rounded-xl p-6 max-w-sm w-full mx-4 space-y-4"
            style={{ background: "#1C2030", border: "1px solid #2E3448" }}
          >
            <h2 className="text-base font-semibold text-vault-text-primary">
              Confirm deletion
            </h2>
            <p className="text-sm text-vault-text-muted">
              You are about to permanently delete{" "}
              <span className="text-vault-text-primary font-medium">
                {totalSelected} item{totalSelected !== 1 ? "s" : ""}
              </span>
              . This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-1.5 rounded text-sm text-vault-text-muted hover:text-vault-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={runCleanup}
                className="px-4 py-1.5 rounded text-sm font-medium transition-colors"
                style={{
                  background: "rgba(229,62,62,0.15)",
                  border: "1px solid rgba(229,62,62,0.4)",
                  color: "#FC8181",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal — cluster delete */}
      {clusterConfirmData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            className="rounded-xl p-6 max-w-sm w-full mx-4 space-y-4"
            style={{ background: "#1C2030", border: "1px solid #2E3448" }}
          >
            <h2 className="text-base font-semibold text-vault-text-primary">
              Confirm deletion
            </h2>
            <p className="text-sm text-vault-text-muted">
              You are about to permanently delete{" "}
              <span className="text-vault-text-primary font-medium">
                {clusterConfirmData.docIds.length} document
                {clusterConfirmData.docIds.length !== 1 ? "s" : ""}
              </span>
              . This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setClusterConfirmData(null)}
                className="px-4 py-1.5 rounded text-sm text-vault-text-muted hover:text-vault-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={runClusterDelete}
                className="px-4 py-1.5 rounded text-sm font-medium transition-colors"
                style={{
                  background: "rgba(229,62,62,0.15)",
                  border: "1px solid rgba(229,62,62,0.4)",
                  color: "#FC8181",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClusterDocRow({
  member,
  isAnchor,
  checked,
  onToggle,
  onPreview,
}: {
  member: DuplicateMember;
  isAnchor: boolean;
  checked: boolean;
  onToggle: () => void;
  onPreview: (docId: string) => void;
}) {
  const ext = member.filename.split(".").pop()?.toLowerCase() ?? "";
  const fileIcon = ext === "pdf" ? "ti-file-type-pdf" : "ti-file-text";

  return (
    <div
      onClick={() => onPreview(member.id)}
      className="rounded-md px-3 py-2 mt-1"
      style={{
        display: "grid",
        gridTemplateColumns: "16px 16px 1fr 72px 60px 52px 54px",
        alignItems: "center",
        gap: 10,
        background: isAnchor ? "rgba(0,212,170,0.04)" : "transparent",
        border: `1px solid ${isAnchor ? "rgba(0,212,170,0.15)" : "#2E3448"}`,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        style={{ accentColor: "#00D4AA", flexShrink: 0 }}
      />
      <i
        className={`ti ${fileIcon}`}
        style={{ fontSize: 15, color: "#8A93A8" }}
      />
      <span
        className="text-sm font-medium text-vault-text-primary truncate"
        title={member.filename}
      >
        {member.filename}
      </span>
      <div className="min-w-0">
        {member.category && (
          <span
            className="truncate inline-block max-w-full"
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              background: "#2A2F42",
              color: "#8A93A8",
            }}
          >
            {member.category}
          </span>
        )}
      </div>
      <span className="text-right" style={{ fontSize: 11, color: "#8A93A8" }}>
        {member.uploaded_at
          ? new Date(member.uploaded_at).toLocaleDateString()
          : "—"}
      </span>
      <span className="text-right" style={{ fontSize: 11, color: "#8A93A8" }}>
        {formatBytes(member.file_size)}
      </span>
      <div className="text-right">
        {isAnchor ? (
          <span style={{ fontSize: 11, color: "#4A5268" }}>—</span>
        ) : (
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              background: "rgba(246,173,85,0.08)",
              color: "#F6AD55",
              border: "1px solid rgba(246,173,85,0.2)",
            }}
          >
            {(member.similarity * 100).toFixed(2)}%
          </span>
        )}
      </div>
    </div>
  );
}
