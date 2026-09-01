// Register jest-dom matchers on this workspace's own vitest instance. The
// "@/vitest" entry resolves "vitest" from the hoisted pnpm store, which may be
// a different major than the one running these tests.
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { expect } from "vitest";
import { failOnReactActWarning } from "@/test/console";

expect.extend(jestDomMatchers);

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  failOnReactActWarning(args);
  originalConsoleError(...args);
};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

const localStorage = new MemoryStorage();
Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
const sessionStorage = new MemoryStorage();
Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStorage });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionStorage });

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});
