"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import BACKEND_URL from "@/app/lib/backend";

interface EmailSettings {
  email_address: string | null;
  configured: boolean;
  allowed_senders: string[];
  poll_interval_seconds: number;
  last_polled_at: string | null;
  last_error: string | null;
}

interface EmailStatus {
  configured: boolean;
  email_address: string | null;
  last_polled_at: string | null;
  last_error: string | null;
  total_processed: number;
  total_rejected: number;
  recent_messages: {
    sender: string;
    subject: string;
    status: "processed" | "rejected" | "trashed";
    processed_at: string;
  }[];
}

const C = {
  textPrimary: "#E2E8F0",
  textMuted: "#8A93A8",
  surface: "#1C2030",
  elevated: "#242838",
  input: "#2A2F42",
  border: "#2E3448",
  teal: "#00D4AA",
  danger: "#E53E3E",
  green: "#48BB78",
};

const cardStyle: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: 24,
  marginBottom: 16,
};

function fmtRelative(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: "rgba(246,173,85,0.15)",
        color: "#F6AD55",
        borderRadius: 4,
        padding: "1px 5px",
        fontFamily: "monospace",
        fontSize: 12,
      }}
    >
      {children}
    </code>
  );
}

interface ConfigRowProps {
  label: string;
  isLast?: boolean;
  children: React.ReactNode;
}

function ConfigRow({ label, isLast, children }: ConfigRowProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        borderBottom: isLast ? "none" : `1px solid ${C.border}`,
        padding: "9px 0",
      }}
    >
      <span style={{ fontSize: 13, color: C.textMuted }}>{label}</span>
      <span style={{ fontSize: 13 }}>{children}</span>
    </div>
  );
}

function labelColor(s: string) {
  if (s === "processed")
    return {
      color: "#4ade80",
      bg: "rgba(34,197,94,0.1)",
      border: "rgba(34,197,94,0.25)",
    };
  if (s === "rejected")
    return {
      color: "#f87171",
      bg: "rgba(239,68,68,0.1)",
      border: "rgba(239,68,68,0.25)",
    };
  if (s === "trashed")
    return {
      color: "#fbbf24",
      bg: "rgba(251,191,36,0.1)",
      border: "rgba(251,191,36,0.25)",
    };
  return {
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.1)",
    border: "rgba(251,191,36,0.25)",
  };
}

export default function SettingsView() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newSender, setNewSender] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [settingsRes, statusRes] = await Promise.all([
        fetch(`${BACKEND_URL}/settings/email`),
        fetch(`${BACKEND_URL}/email/status`),
      ]);
      if (settingsRes.ok) setSettings(await settingsRes.json());
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (e) {
      console.error("SettingsView load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addSender = useCallback(async () => {
    const addr = newSender.trim().toLowerCase();
    if (!addr) return;
    if (!addr.includes("@")) {
      setAddError("Enter a valid email address");
      return;
    }
    setSaving(true);
    setAddError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/settings/email`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add_senders: [addr] }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings((s) =>
          s ? { ...s, allowed_senders: data.allowed_senders } : s,
        );
        setNewSender("");
      }
    } catch {
      setAddError("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [newSender]);

  const removeSender = useCallback(async (sender: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/settings/email`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_senders: [sender] }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings((s) =>
          s ? { ...s, allowed_senders: data.allowed_senders } : s,
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span style={{ color: C.textMuted, fontSize: 14 }}>
          Loading settings…
        </span>
      </div>
    );
  }

  const isConfigured = settings?.configured ?? false;
  const pollIntervalMins = settings
    ? Math.round(settings.poll_interval_seconds / 60)
    : 5;
  const hasLastError = !!status?.last_error;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 22,
              fontWeight: 500,
              color: C.textPrimary,
            }}
          >
            Settings
          </h1>
          <p style={{ color: C.textMuted, fontSize: 14, marginTop: 4 }}>
            Configure email ingest and manage allowed senders.
          </p>
        </div>

        {/* Email Ingest card */}
        <section style={cardStyle}>
          {/* Header row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: isConfigured ? C.green : C.danger,
                flexShrink: 0,
                display: "inline-block",
              }}
            />
            <h2
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: C.textPrimary,
                margin: 0,
              }}
            >
              Email Ingest
            </h2>
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                fontWeight: 500,
                borderRadius: 5,
                padding: "3px 10px",
                background: isConfigured
                  ? "rgba(72,187,120,0.1)"
                  : "rgba(229,62,62,0.1)",
                border: `1px solid ${isConfigured ? "rgba(72,187,120,0.3)" : "rgba(229,62,62,0.3)"}`,
                color: isConfigured ? C.green : C.danger,
              }}
            >
              <i
                className={`ti ti-${isConfigured ? "check" : "alert-circle"}`}
                style={{ fontSize: 12 }}
              />
              {isConfigured ? "connected" : "not configured"}
            </span>
          </div>

          {/* Config fields */}
          <div>
            <ConfigRow label="Inbox address">
              {settings?.email_address ? (
                <span style={{ color: C.textPrimary }}>
                  {settings.email_address}
                </span>
              ) : (
                <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                  not set
                </span>
              )}
            </ConfigRow>
            <ConfigRow label="Password">
              {isConfigured ? (
                <span style={{ color: C.textPrimary }}>configured</span>
              ) : (
                <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                  not set
                </span>
              )}
            </ConfigRow>
            <ConfigRow label="Poll interval">
              <span style={{ color: C.teal }}>
                every {pollIntervalMins} min
              </span>
            </ConfigRow>
            <ConfigRow label="Last polled" isLast={!hasLastError}>
              {status?.last_polled_at ? (
                <span style={{ color: C.textPrimary }}>
                  {fmtRelative(status.last_polled_at)}
                </span>
              ) : (
                <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                  never
                </span>
              )}
            </ConfigRow>
            {hasLastError && (
              <ConfigRow label="Last error" isLast>
                <span
                  style={{
                    color: C.danger,
                    fontSize: 12,
                    wordBreak: "break-all",
                  }}
                >
                  {status!.last_error}
                </span>
              </ConfigRow>
            )}
          </div>

          {/* Setup notice */}
          {!isConfigured && (
            <div
              style={{
                marginTop: 16,
                background: "rgba(246,173,85,0.08)",
                border: "1px solid rgba(246,173,85,0.25)",
                borderRadius: 8,
                padding: "14px 16px",
                color: "#F6AD55",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              Set <InlineCode>EMAIL_ADDRESS</InlineCode> and{" "}
              <InlineCode>EMAIL_PASSWORD</InlineCode> in{" "}
              <InlineCode>backend/.env</InlineCode> and restart the backend.{" "}
              Defaults to GMX (<InlineCode>imap.gmx.com</InlineCode>); override{" "}
              <InlineCode>IMAP_HOST</InlineCode> and{" "}
              <InlineCode>IMAP_PORT</InlineCode> for other providers.
            </div>
          )}

          <p
            style={{
              marginTop: 14,
              fontSize: 12,
              color: C.textMuted,
              lineHeight: 1.6,
            }}
          >
            These values are set in{" "}
            <code
              style={{
                background: "rgba(246,173,85,0.15)",
                color: "#F6AD55",
                borderRadius: 4,
                padding: "1px 5px",
                fontFamily: "monospace",
                fontSize: 11,
              }}
            >
              backend/.env
            </code>{" "}
            and require a backend restart to take effect.
          </p>
        </section>

        {/* Allowed Senders card */}
        <section style={cardStyle}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 500,
              color: C.textPrimary,
              margin: 0,
              marginBottom: 6,
            }}
          >
            Allowed Senders
          </h2>
          <p
            style={{
              fontSize: 13,
              color: C.textMuted,
              lineHeight: 1.6,
              marginBottom: 16,
            }}
          >
            Only attachments from these addresses will be ingested. Messages
            from other senders are marked rejected and ignored.
          </p>

          {/* Sender list */}
          {settings?.allowed_senders.length === 0 ? (
            <p
              style={{
                fontSize: 13,
                color: C.textMuted,
                fontStyle: "italic",
                marginBottom: 16,
              }}
            >
              No senders configured — add at least one to enable email ingest.
            </p>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 16,
              }}
            >
              {settings?.allowed_senders.map((s) => (
                <div
                  key={s}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: C.elevated,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                  }}
                >
                  <i
                    className="ti ti-mail"
                    style={{ fontSize: 15, color: C.textMuted, flexShrink: 0 }}
                  />
                  <span
                    style={{
                      fontSize: 13,
                      color: C.textPrimary,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "rgba(72,187,120,0.1)",
                      color: C.green,
                      flexShrink: 0,
                    }}
                  >
                    allowed
                  </span>
                  <button
                    onClick={() => removeSender(s)}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: C.textMuted,
                      padding: "3px 5px",
                      borderRadius: 5,
                      lineHeight: 1,
                      display: "flex",
                      alignItems: "center",
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background =
                        "rgba(229,62,62,0.1)";
                      (e.currentTarget as HTMLElement).style.color = C.danger;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background =
                        "transparent";
                      (e.currentTarget as HTMLElement).style.color =
                        C.textMuted;
                    }}
                    title="Remove sender"
                  >
                    <i className="ti ti-x" style={{ fontSize: 15 }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add sender */}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              type="email"
              placeholder="name@example.com"
              value={newSender}
              onChange={(e) => {
                setNewSender(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && addSender()}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              style={{
                flex: 1,
                background: C.input,
                border: `1px solid ${addError ? C.danger : inputFocused ? "rgba(0,212,170,0.4)" : C.border}`,
                borderRadius: 8,
                padding: "10px 14px",
                fontSize: 14,
                color: C.textPrimary,
                outline: "none",
              }}
            />
            <button
              onClick={addSender}
              disabled={saving || !newSender.trim()}
              style={{
                background: saving || !newSender.trim() ? C.elevated : C.teal,
                color: saving || !newSender.trim() ? C.textMuted : "#0a2e27",
                border: "none",
                borderRadius: 8,
                padding: "10px 20px",
                fontSize: 14,
                fontWeight: 600,
                cursor: saving || !newSender.trim() ? "not-allowed" : "pointer",
                flexShrink: 0,
              }}
            >
              {saving ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && (
            <p style={{ fontSize: 11, color: C.danger, marginTop: 5 }}>
              {addError}
            </p>
          )}
        </section>

        {/* Recent Activity card */}
        <section style={cardStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <h2
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: C.textPrimary,
                margin: 0,
              }}
            >
              Recent Activity
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginLeft: "auto",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  fontSize: 12,
                  color: C.textMuted,
                }}
              >
                <span>
                  <span style={{ color: "#4ade80", fontWeight: 600 }}>
                    {status?.total_processed ?? 0}
                  </span>{" "}
                  ingested
                </span>
                <span>
                  <span style={{ color: "#f87171", fontWeight: 600 }}>
                    {status?.total_rejected ?? 0}
                  </span>{" "}
                  rejected
                </span>
              </div>
              <button
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await load();
                  } finally {
                    setRefreshing(false);
                  }
                }}
                disabled={refreshing}
                style={{
                  background: C.elevated,
                  color: C.textPrimary,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  fontSize: 13,
                  padding: "6px 12px",
                  cursor: refreshing ? "not-allowed" : "pointer",
                  lineHeight: 1.2,
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {!status?.recent_messages || status.recent_messages.length === 0 ? (
            <p
              style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}
            >
              No email activity yet.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Status", "From", "Subject", "Time"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "4px 8px 8px 0",
                          color: C.textMuted,
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.recent_messages.map((m, i) => {
                    const lc = labelColor(m.status);
                    return (
                      <tr
                        key={i}
                        style={{ borderBottom: `1px solid rgba(46,52,72,0.5)` }}
                      >
                        <td
                          style={{
                            padding: "7px 8px 7px 0",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: "2px 6px",
                              borderRadius: 3,
                              background: lc.bg,
                              border: `1px solid ${lc.border}`,
                              color: lc.color,
                            }}
                          >
                            {m.status}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "7px 12px 7px 0",
                            color: C.textMuted,
                            fontFamily: "monospace",
                            fontSize: 11,
                            maxWidth: 160,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.sender}
                        </td>
                        <td
                          style={{
                            padding: "7px 12px 7px 0",
                            color: "#C8CDD8",
                            maxWidth: 220,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.subject}
                        </td>
                        <td
                          style={{
                            padding: "7px 0",
                            color: C.textMuted,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtRelative(m.processed_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
