import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("BACKEND_URL", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves to 127.0.0.1:8777 when window is undefined (SSR)", async () => {
    vi.stubGlobal("window", undefined);
    const mod = await import("@/app/lib/backend");
    expect(mod.default).toBe("http://127.0.0.1:8777");
  });

  it("resolves using window.location.hostname in the browser", async () => {
    vi.stubGlobal("window", { location: { hostname: "100.64.0.5" } });
    const mod = await import("@/app/lib/backend");
    expect(mod.default).toBe("http://100.64.0.5:8777");
  });
});
