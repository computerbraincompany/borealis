import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  explicitHttpUrls,
  fetchPublicText,
  fetchPublicTextWithTransport,
  isLoopbackAddress,
  isUnsafeIp,
  normalizeHttpUrl,
  requestPinned,
  resolveContainedDownloadDestination,
  resolveLoopbackDestination,
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

describe("contained download destination resolution", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("classifies exact loopback addresses only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.6.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::2")).toBe(false);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
  });

  it("routes public HTTPS through the untouched public-only resolver", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      resolveContainedDownloadDestination(new URL("https://models.example.test/x.gguf"), AbortSignal.timeout(2_000))
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(lookupMock).toHaveBeenCalledWith("models.example.test", { all: true, verbatim: true });
  });

  it.each(["10.1.2.3", "169.254.169.254", "192.168.1.5", "::1", "fc00::1", "fe80::1"])(
    "rejects public HTTPS whose DNS answers private/loopback space %s",
    async (address) => {
      lookupMock.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      await expect(
        resolveContainedDownloadDestination(new URL("https://models.example.test/x.gguf"), AbortSignal.timeout(2_000))
      ).rejects.toThrow("URL is not permitted");
    }
  );

  it("rejects mixed public/private HTTPS answers", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      resolveContainedDownloadDestination(new URL("https://models.example.test/x.gguf"), AbortSignal.timeout(2_000))
    ).rejects.toThrow("URL is not permitted");
  });

  it("accepts exact loopback IP literal HTTP hosts with zero DNS", async () => {
    await expect(
      resolveContainedDownloadDestination(new URL("http://127.0.0.1:4567/x"), AbortSignal.timeout(2_000))
    ).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      resolveContainedDownloadDestination(new URL("http://[::1]:4567/x"), AbortSignal.timeout(2_000))
    ).resolves.toEqual([{ address: "::1", family: 6 }]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("accepts localhost HTTP only when every DNS answer is loopback", async () => {
    lookupMock.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(
      resolveLoopbackDestination(new URL("http://localhost:4567/x"), AbortSignal.timeout(2_000))
    ).resolves.toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  });

  it.each([
    [{ address: "8.8.8.8", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "10.0.0.2", family: 4 },
    ],
  ])("rejects poisoned localhost answers %j", async (...answers) => {
    lookupMock.mockResolvedValue(answers);
    await expect(
      resolveContainedDownloadDestination(new URL("http://localhost:4567/x"), AbortSignal.timeout(2_000))
    ).rejects.toThrow("URL is not permitted");
  });

  it("rejects an empty localhost answer", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(
      resolveLoopbackDestination(new URL("http://localhost:4567/x"), AbortSignal.timeout(2_000))
    ).rejects.toThrow("URL is not permitted");
  });

  it.each([
    "http://localhost.evil.test/x",
    "http://notlocalhost/x",
    "http://127.0.0.1.evil.test/x",
    "http://models.example.test/x",
    "http://10.0.0.1/x",
  ])("rejects lookalike and non-loopback HTTP hosts %s without touching DNS", async (rawUrl) => {
    await expect(resolveContainedDownloadDestination(new URL(rawUrl), AbortSignal.timeout(2_000))).rejects.toThrow(
      "URL is not permitted"
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects other schemes and HTTPS to loopback-spelled names", async () => {
    await expect(
      resolveContainedDownloadDestination(new URL("ftp://models.example.test/x"), AbortSignal.timeout(2_000))
    ).rejects.toBeInstanceOf(Error);
    lookupMock.mockClear();
    await expect(
      resolveContainedDownloadDestination(new URL("https://localhost/x"), AbortSignal.timeout(2_000))
    ).rejects.toThrow("URL is not permitted");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fails a DNS race without leaking into a request path", async () => {
    // A poisoned/late answer after abort never yields addresses.
    const controller = new AbortController();
    lookupMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ address: "127.0.0.1", family: 4 }]), 50))
    );
    const pending = resolveLoopbackDestination(new URL("http://localhost/x"), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
