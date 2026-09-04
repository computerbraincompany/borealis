import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  explicitHttpUrls,
  fetchPublicText,
  fetchPublicTextWithTransport,
  isUnsafeIp,
  normalizeHttpUrl,
  requestPinned,
  resolveRedirectTarget,
} from "../networkPolicy.js";

describe("outbound URL policy", () => {
  it("pins a single validated address for both lookup callback forms", async () => {
    // Regression: Node's default autoSelectFamily invokes the pinned lookup
    // with {all:true} and expects the array form; the old single-value answer
    // made every pinned request fail with ERR_INVALID_IP_ADDRESS.
    const server: Server = await new Promise((resolve) => {
      const created = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("pinned-ok");
      });
      created.listen(0, "127.0.0.1", () => resolve(created));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await requestPinned(
        new URL(`http://127.0.0.1:${port}/`),
        [{ address: "127.0.0.1", family: 4 }],
        AbortSignal.timeout(5000)
      );
      const text = await new Promise<string>((resolve, reject) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
        response.on("error", reject);
      });
      expect(response.statusCode).toBe(200);
      expect(text).toBe("pinned-ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies addresses per family without the IPv4-mapped blocklist leaking into IPv4 checks", () => {
    // Regression: Node's BlockList matches IPv4 input as IPv4-mapped IPv6, so a
    // shared list holding "::ffff:0:0/96" marked every public IPv4 unsafe.
    expect(isUnsafeIp("8.8.8.8")).toBe(false);
    expect(isUnsafeIp("185.199.108.133")).toBe(false);
    expect(isUnsafeIp("2606:50c0:8003::154")).toBe(false);
    expect(isUnsafeIp("127.0.0.1")).toBe(true);
    expect(isUnsafeIp("10.1.2.3")).toBe(true);
    expect(isUnsafeIp("169.254.169.254")).toBe(true);
    expect(isUnsafeIp("::1")).toBe(true);
    expect(isUnsafeIp("::ffff:127.0.0.1")).toBe(true);
    expect(isUnsafeIp("::ffff:8.8.8.8")).toBe(true);
    expect(isUnsafeIp("fc00::1")).toBe(true);
    expect(isUnsafeIp("not-an-ip")).toBe(true);
  });

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
