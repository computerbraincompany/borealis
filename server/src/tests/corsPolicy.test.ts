import { describe, expect, it } from "vitest";
import { isCorsOriginAllowed } from "../corsPolicy.js";

describe("credentialed CORS policy", () => {
  const allowlist = ["http://127.0.0.1:5173", "https://borealis.example"];

  it("allows configured browser origins and non-browser requests", () => {
    expect(isCorsOriginAllowed(undefined, allowlist)).toBe(true);
    expect(isCorsOriginAllowed("http://127.0.0.1:5173", allowlist)).toBe(true);
  });

  it("does not reflect an arbitrary credentialed origin", () => {
    expect(isCorsOriginAllowed("https://attacker.example", allowlist)).toBe(false);
  });
});
