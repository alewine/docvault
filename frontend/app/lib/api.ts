import BACKEND_URL from "@/app/lib/backend";

/**
 * Error thrown by the api helpers when the backend responds with a non-2xx
 * status. The message mirrors the legacy `new Error(\`HTTP \${status}\`)` form
 * so existing `err instanceof Error ? err.message` handling keeps working.
 */
export class ApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, init);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<T>;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, jsonInit("POST", body));
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, jsonInit("PUT", body));
}

export function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, jsonInit("DELETE", body));
}
