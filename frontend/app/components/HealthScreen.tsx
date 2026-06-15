'use client';

import { useEffect, useState } from 'react';
import BACKEND_URL from '@/app/lib/backend';

type CheckStatus = 'green' | 'red';

interface HealthResponse {
  status: 'pass' | 'fail';
  checks: {
    nas: CheckStatus;
    ollama: CheckStatus;
    llm: CheckStatus;
    database: CheckStatus;
  };
  embedding_gap?: number;
}

const CHECK_LABELS: Record<string, string> = {
  nas: 'NAS Mount',
  ollama: 'Ollama (embed)',
  llm: 'LLM (llama3.2)',
  database: 'Database',
};

const SOFT_CHECKS = new Set(['llm']);

function StatusDot({ status, soft }: { status: CheckStatus; soft?: boolean }) {
  const ok = status === 'green';
  const warn = !ok && soft;
  return (
    <span className={`flex items-center gap-2 text-sm font-medium ${ok ? 'text-green-400' : warn ? 'text-yellow-400' : 'text-red-400'}`}>
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${ok ? 'bg-green-400' : warn ? 'bg-yellow-400' : 'bg-red-500'}`} />
      {ok ? 'OK' : warn ? 'Not found' : 'Error'}
    </span>
  );
}

export default function HealthScreen({ onHealthy }: { onHealthy: (llmAvailable: boolean) => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      fetch(`${BACKEND_URL}/health`, { signal: controller.signal })
        .then((r) => {
          clearTimeout(timeout);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<HealthResponse>;
        })
        .then((data) => {
          if (cancelled) return;
          setHealth(data);
          setBackendError(null);
          setLoading(false);
          if (data.status === 'pass') {
            onHealthy(data.checks.llm === 'green');
          } else {
            setTimeout(check, 3000);
          }
        })
        .catch(() => {
          clearTimeout(timeout);
          if (cancelled) return;
          setBackendError(`Backend unreachable at ${BACKEND_URL}`);
          setLoading(false);
          setTimeout(check, 3000);
        });
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [onHealthy]);

  return (
    <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">DocVault</h1>
          <p className="mt-1 text-sm text-gray-500">System health</p>
        </div>

        {loading && (
          <p className="text-center text-gray-400 text-sm animate-pulse">
            Checking system status…
          </p>
        )}

        {backendError && (
          <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
            <span className="font-semibold">Backend unreachable</span>
            <br />
            {backendError}
          </div>
        )}

        {health && (
          <>
            <div className="rounded-xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
              {(Object.entries(health.checks) as [string, CheckStatus][]).map(([key, status]) => (
                <div key={key} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-gray-200">{CHECK_LABELS[key] ?? key}</span>
                  <StatusDot status={status} soft={SOFT_CHECKS.has(key)} />
                </div>
              ))}
            </div>

            <div
              className={`rounded-lg px-4 py-3 text-center text-sm font-medium border ${
                health.status === 'pass'
                  ? health.checks.llm === 'green'
                    ? 'bg-green-950 border-green-800 text-green-300'
                    : 'bg-yellow-950 border-yellow-800 text-yellow-300'
                  : 'bg-red-950 border-red-800 text-red-300'
              }`}
            >
              {health.status === 'pass'
                ? health.checks.llm === 'green'
                  ? 'All systems green'
                  : 'Ready — Ask disabled until llama3.2 is pulled'
                : 'One or more systems need attention'}
            </div>

            {health.embedding_gap === -1 && (
              <div className="rounded-lg border border-yellow-800 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                Search index initializing… embeddings unavailable until ready.
              </div>
            )}
            {health.embedding_gap != null && health.embedding_gap > 0 && (
              <div className="rounded-lg border border-yellow-800 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                {health.embedding_gap} document{health.embedding_gap !== 1 ? 's are' : ' is'} missing search embeddings. Go to Audit → Reprocess All to fix.
              </div>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-700" suppressHydrationWarning>
          Backend:{' '}
          <a
            href={BACKEND_URL}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            target="_blank"
            rel="noreferrer"
            suppressHydrationWarning
          >
            {BACKEND_URL}
          </a>
        </p>
      </div>
    </main>
  );
}
