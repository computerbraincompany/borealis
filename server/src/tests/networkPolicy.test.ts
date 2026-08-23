import { describe, expect, it, vi } from "vitest";
import {
  explicitHttpUrls,
  fetchPublicText,
  fetchPublicTextWithTransport,
  normalizeHttpUrl,
  resolveRedirectTarget,
} from "../networkPolicy.js";

describe("outbound URL policy", () => {
  it("extracts only explicit HTTP(S) URLs and normalizes fragments", () => {
    expect([...explicitHttpUrls("Read https://example.com/a#section, then answer")]).toEqual(["https://example.com/a"]);
    expect([...explicitHttpUrls("ignore ftp://example.com and javascript:alert(1)")]).toEqual([]);
  });

  it("rejects URLs that were not explicit in the current user message before fetching", async () => {
    await expect(fetchPublicText("https://example.com/private", new Set())).rejects.toThrow(
      "URL must appear explicitly in the current user message"
    );
  });

  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[64:ff9b:1::7f00:1]/",
    "http://[2002:7f00:1::]/",
  ])("rejects private, loopback, and link-local destination %s", async (url) => {
    await expect(fetchPublicText(url, new Set([normalizeHttpUrl(url)]))).rejects.toThrow("URL is not permitted");
  });

  it.each(["file:///etc/passwd", "https://user:pass@example.com/", "https://example.com:8443/"])(
    "rejects unsafe URL form %s",
    (url) => expect(() => normalizeHttpUrl(url)).toThrow("URL is not permitted")
  );

  it("reapplies the nonstandard-port policy to every redirect", () => {
    expect(() =>
      resolveRedirectTarget(new URL("https://example.com/start"), "http://public.example:8080/next")
    ).toThrow("URL is not permitted");
  });

  it("rejects an HTTPS to HTTP redirect even on the standard port", () => {
    expect(() => resolveRedirectTarget(new URL("https://example.com/start"), "http://public.example/next")).toThrow(
      "HTTPS redirects may not downgrade to HTTP"
    );
  });

  it("destroys redirect and rejected response bodies instead of draining them", async () => {
    const firstDestroy = vi.fn();
    const secondDestroy = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "https://example.com/final" },
        destroy: firstDestroy,
      })
      .mockResolvedValueOnce({ statusCode: 503, headers: {}, destroy: secondDestroy });
    const transport = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request,
    };

    await expect(
      fetchPublicTextWithTransport("https://example.com/start", new Set(["https://example.com/start"]), transport)
    ).resolves.toMatchObject({ status: 503, text: "" });
    expect(firstDestroy).toHaveBeenCalledOnce();
    expect(secondDestroy).toHaveBeenCalledOnce();
  });

  it("uses one total deadline and the same AbortSignal across delayed redirects", async () => {
    const signals: AbortSignal[] = [];
    let requests = 0;
    const transport = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request(_url: URL, _addresses: unknown, signal: AbortSignal) {
        signals.push(signal);
        requests += 1;
        return new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                statusCode: 302,
                headers: { location: `https://example.com/hop-${requests}` },
                destroy() {},
              }),
            20
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true }
          );
        });
      },
    };

    await expect(
      fetchPublicTextWithTransport("https://example.com/start", new Set(["https://example.com/start"]), transport, {
        timeoutMs: 30,
      })
    ).rejects.toBeDefined();
    expect(requests).toBe(2);
    expect(signals[0]).toBe(signals[1]);
  });
});
