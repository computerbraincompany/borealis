import { describe, expect, it } from "vitest";
import { parseServiceOrigin } from "../config.js";

describe("service origin configuration", () => {
  it.each(["http://localhost:4000", "http://127.0.0.1:8000", "http://[::1]:8000"])(
    "allows loopback HTTP origin %s",
    (origin) => expect(parseServiceOrigin(origin, "https://fallback.invalid", "SERVICE_URL")).toBe(origin)
  );

  it("requires HTTPS for remote credential-bearing services", () => {
    expect(() => parseServiceOrigin("http://service.example:8000", "https://fallback.invalid", "SERVICE_URL")).toThrow(
      "must use HTTPS"
    );
    expect(parseServiceOrigin("https://service.example:8443", "https://fallback.invalid", "SERVICE_URL")).toBe(
      "https://service.example:8443"
    );
  });

  it.each(["https://user:secret@service.example", "https://service.example/path", "ftp://service.example"])(
    "rejects unsafe service origin %s",
    (origin) => {
      expect(() => parseServiceOrigin(origin, "https://fallback.invalid", "SERVICE_URL")).toThrow();
    }
  );
});
