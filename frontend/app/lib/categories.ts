import BACKEND_URL from "@/app/lib/backend";

interface CategoryRecord {
  id: string;
  name: string;
  is_default: boolean;
}

interface CategoriesResponse {
  categories?: CategoryRecord[];
}

export const CANONICAL_CATEGORIES: string[] = [
  "Audio",
  "Education",
  "Financial",
  "Home",
  "Insurance",
  "Legal",
  "Medical",
  "Other",
];

export async function fetchCategoryNames(): Promise<string[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/categories`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data: CategoriesResponse = await res.json();

    const serverNames = (data.categories ?? [])
      .map((category) => category.name)
      .filter((name): name is string => Boolean(name));

    // Merge server list with canonical list, deduplicate, sort
    const merged = Array.from(new Set([...CANONICAL_CATEGORIES, ...serverNames]));
    return merged.sort((left, right) => left.localeCompare(right));
  } catch {
    return [...CANONICAL_CATEGORIES];
  }
}

export function withSelectedCategory(
  categories: string[],
  selectedCategory: string,
): string[] {
  if (!selectedCategory || categories.includes(selectedCategory)) {
    return categories;
  }

  return [...categories, selectedCategory].sort((left, right) =>
    left.localeCompare(right),
  );
}
