import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCategoryNames, withSelectedCategory, CANONICAL_CATEGORIES } from "@/app/lib/categories";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("CANONICAL_CATEGORIES", () => {
  it("contains exactly the 8 allowed categories", () => {
    expect(CANONICAL_CATEGORIES).toEqual([
      "Audio",
      "Education",
      "Financial",
      "Home",
      "Insurance",
      "Legal",
      "Medical",
      "Other",
    ]);
  });
});

describe("fetchCategoryNames", () => {
  it("merges server names with canonical list and returns sorted unique list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        categories: [
          { id: "1", name: "Finance", is_default: true },
          { id: "2", name: "Medical", is_default: true },
          { id: "3", name: "Legal", is_default: true },
        ],
      }),
    });

    const names = await fetchCategoryNames();
    // Includes canonical list + server-only "Finance" (not in canonical), deduplicated and sorted
    expect(names).toContain("Finance");
    expect(names).toContain("Medical");
    expect(names).toContain("Education");
    expect(names).toEqual([...new Set([...CANONICAL_CATEGORIES, "Finance", "Medical", "Legal"])].sort());
  });

  it("returns canonical list when server returns empty categories", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ categories: [] }),
    });

    const names = await fetchCategoryNames();
    expect(names).toEqual([...CANONICAL_CATEGORIES].sort());
  });

  it("filters out falsy server names but keeps canonical list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        categories: [
          { id: "1", name: "Finance", is_default: true },
          { id: "2", name: "", is_default: false },
          { id: "3", name: null, is_default: false },
        ],
      }),
    });

    const names = await fetchCategoryNames();
    expect(names).toContain("Finance");
    expect(names).toContain("Education");
    expect(names).not.toContain("");
    expect(names).not.toContain(null);
  });

  it("returns canonical list when categories key is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const names = await fetchCategoryNames();
    expect(names).toEqual([...CANONICAL_CATEGORIES].sort());
  });

  it("falls back to canonical list on non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const names = await fetchCategoryNames();
    expect(names).toEqual([...CANONICAL_CATEGORIES]);
  });

  it("falls back to canonical list on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    const names = await fetchCategoryNames();
    expect(names).toEqual([...CANONICAL_CATEGORIES]);
  });
});

describe("withSelectedCategory", () => {
  it("returns original list when selectedCategory is empty string", () => {
    const list = ["Finance", "Medical"];
    expect(withSelectedCategory(list, "")).toBe(list);
  });

  it("returns original list when selectedCategory is already in list", () => {
    const list = ["Finance", "Medical"];
    expect(withSelectedCategory(list, "Medical")).toBe(list);
  });

  it("appends and sorts when selectedCategory is not in list", () => {
    const result = withSelectedCategory(["Finance", "Medical"], "Legal");
    expect(result).toEqual(["Finance", "Legal", "Medical"]);
  });

  it("handles empty source list", () => {
    expect(withSelectedCategory([], "Other")).toEqual(["Other"]);
  });
});
