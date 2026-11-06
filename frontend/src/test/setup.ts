import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom lacks these; framer-motion and the layout code touch them.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", { value: (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) });
}
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: typeof RO }).ResizeObserver ?? RO;
(globalThis as unknown as { IntersectionObserver: typeof RO }).IntersectionObserver = (globalThis as unknown as { IntersectionObserver?: typeof RO }).IntersectionObserver ?? RO;
Element.prototype.scrollTo = Element.prototype.scrollTo ?? function () {};
