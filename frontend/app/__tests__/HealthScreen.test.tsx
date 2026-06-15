import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import HealthScreen from "@/app/components/HealthScreen";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const passResponse = {
  status: "pass",
  checks: { nas: "green", ollama: "green", llm: "green", database: "green" },
};

const failResponse = {
  status: "fail",
  checks: { nas: "red", ollama: "green", llm: "green", database: "green" },
};

const passNoLlmResponse = {
  status: "pass",
  checks: { nas: "green", ollama: "green", llm: "red", database: "green" },
};

function makeOkFetch(body: object) {
  return { ok: true, json: async () => body };
}

describe("HealthScreen", () => {
  it("shows loading state before first fetch resolves", () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    render(<HealthScreen onHealthy={vi.fn()} />);
    expect(screen.getByText(/checking system status/i)).toBeInTheDocument();
  });

  it("calls onHealthy(true) when all checks pass and llm is green", async () => {
    const onHealthy = vi.fn();
    mockFetch.mockResolvedValueOnce(makeOkFetch(passResponse));

    render(<HealthScreen onHealthy={onHealthy} />);
    await act(async () => { await Promise.resolve(); });

    expect(onHealthy).toHaveBeenCalledWith(true);
    expect(screen.getByText("All systems green")).toBeInTheDocument();
  });

  it("calls onHealthy(false) when status pass but llm is red", async () => {
    const onHealthy = vi.fn();
    mockFetch.mockResolvedValueOnce(makeOkFetch(passNoLlmResponse));

    render(<HealthScreen onHealthy={onHealthy} />);
    await act(async () => { await Promise.resolve(); });

    expect(onHealthy).toHaveBeenCalledWith(false);
    expect(screen.getByText(/ask disabled/i)).toBeInTheDocument();
  });

  it("shows error panel and retries when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    mockFetch.mockResolvedValueOnce(makeOkFetch(passResponse));

    const onHealthy = vi.fn();
    render(<HealthScreen onHealthy={onHealthy} />);

    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByText(/backend unreachable/i).length).toBeGreaterThan(0);

    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    expect(onHealthy).toHaveBeenCalledWith(true);
  });

  it("shows attention message and retries on status fail", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetch(failResponse));
    mockFetch.mockResolvedValueOnce(makeOkFetch(passResponse));

    const onHealthy = vi.fn();
    render(<HealthScreen onHealthy={onHealthy} />);

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/one or more systems need attention/i)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    expect(onHealthy).toHaveBeenCalledWith(true);
  });

  it("renders status dots for each check key", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetch(passResponse));
    render(<HealthScreen onHealthy={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("NAS Mount")).toBeInTheDocument();
    expect(screen.getByText("Ollama (embed)")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
  });

  it("shows search index initializing banner when embedding_gap is -1", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetch({ ...passResponse, embedding_gap: -1 }));
    render(<HealthScreen onHealthy={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/search index initializing/i)).toBeInTheDocument();
  });

  it("shows missing embeddings banner when embedding_gap > 0", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetch({ ...passResponse, embedding_gap: 3 }));
    render(<HealthScreen onHealthy={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/3 documents are missing search embeddings/i)).toBeInTheDocument();
  });

  it("shows no embedding banner when embedding_gap is 0", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetch({ ...passResponse, embedding_gap: 0 }));
    render(<HealthScreen onHealthy={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/search index initializing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/missing search embeddings/i)).not.toBeInTheDocument();
  });
});
