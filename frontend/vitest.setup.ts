import "@testing-library/jest-dom";
import { vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// Polyfill navigator.clipboard for components that use it
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve("") },
  writable: true,
  configurable: true,
});

// Polyfill IntersectionObserver for components that use it (e.g. LibraryView infinite scroll)
class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
}
Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  configurable: true,
  value: IntersectionObserverMock,
});

// Polyfill window.matchMedia for components that use it (e.g. UploadButton)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
