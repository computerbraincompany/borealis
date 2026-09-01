import fs, { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import {
  claimConnectorVersion,
  cleanupConnectorVersion,
  ConnectorFetchError,
  connectorVersionPath,
  downloadConnectorVersion,
  resolveConnectorCacheFile,
  type ConnectorFetchTransport,
} from "../data/connectorFetch.js";
import { UrlPolicyError } from "../networkPolicy.js";

const ACCOUNT_ID = "account_connector_test";
const VERSION = "11111111-2222-4333-8444-555555555555";
const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 as const }];

let originalUploadDir: string;
let testRoot: string;

function response(
  body: Buffer | string,
  statusCode = 200,
  headers: Record<string, string> = { "content-type": "text/csv" }
): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  Object.assign(stream, { statusCode, headers });
  return stream;
}

function transportFor(
  handler: (
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>
  ) => IncomingMessage | Promise<IncomingMessage>
): ConnectorFetchTransport {
  return {
    async resolve() {
      return PUBLIC_ADDRESS;
    },
    async request(url, _addresses, signal, headers) {
      return handler(url, signal, headers);
    },
  };
}

beforeEach(async () => {
  originalUploadDir = config.uploadDir;
  testRoot = await mkdtemp(path.join(tmpdir(), "borealis-connector-"));
  config.uploadDir = testRoot;
});

afterEach(async () => {
  vi.restoreAllMocks();
  config.uploadDir = originalUploadDir;
  await rm(testRoot, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`filesystem operation failed with ${code}`), { code });
}

function cacheManifest(location: string): string {
  return path.join(path.dirname(location), `${path.basename(location, path.extname(location))}.meta`);
}

describe("in-process connector cache", () => {
  it("publishes one immutable version with pinned headers and re-inspects the winner", async () => {
    const inspect = vi.fn(async (file: string) => {
      expect(await readFile(file, "utf8")).toBe("value\n42\n");
    });
    const request = vi.fn((url: URL, _signal: AbortSignal, headers: Record<string, string>) => {
      expect(url.toString()).toBe("https://example.test/feed.csv");
      expect(headers).toEqual({
        "Accept-Encoding": "identity",
        "User-Agent": "Borealis-Connector/1",
      });
      return response("value\n42\n");
    });

    const location = await downloadConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/feed.csv",
      inspect,
      transport: transportFor(request),
    });

    expect(path.basename(location)).toBe("11111111222243338444555555555555.csv");
    expect(await readFile(location, "utf8")).toBe("value\n42\n");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();

    await expect(
      downloadConnectorVersion({
        accountId: ACCOUNT_ID,
        name: "feed",
        version: VERSION,
        expectedFormat: "csv",
        url: "https://example.test/feed.csv",
        inspect,
        transport: transportFor(() => {
          throw new Error("an existing version must not be fetched again");
        }),
      })
    ).resolves.toBe(location);
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("binds a caller version to its original URL and format", async () => {
    await claimConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/one.csv",
    });

    const error = await claimConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/two.csv",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(ConnectorFetchError);
    expect(error).toMatchObject({ status: 409 });
  });

  it("rejects HTML, format mismatches, empty bodies, and oversized declarations", async () => {
    const base = {
      accountId: ACCOUNT_ID,
      name: "feed",
      expectedFormat: "csv" as const,
      url: "https://example.test/feed",
      inspect: async () => {},
    };
    const cases: Array<{
      version: string;
      body: string;
      headers: Record<string, string>;
      status: number;
    }> = [
      {
        version: "00000000-0000-4abc-8abc-000000000001",
        body: "<html>login</html>",
        headers: { "content-type": "text/html" },
        status: 422,
      },
      {
        version: "00000000-0000-4abc-8abc-000000000002",
        body: '[{"value":1}]',
        headers: { "content-type": "application/json" },
        status: 422,
      },
      {
        version: "00000000-0000-4abc-8abc-000000000003",
        body: "",
        headers: { "content-type": "text/csv" },
        status: 422,
      },
      {
        version: "00000000-0000-4abc-8abc-000000000004",
        body: "value\n1\n",
        headers: {
          "content-type": "text/csv",
          "content-length": String(50 * 1024 * 1024 + 1),
        },
        status: 413,
      },
    ];

    for (const item of cases) {
      const error = await downloadConnectorVersion({
        ...base,
        version: item.version,
        transport: transportFor(() => response(item.body, 200, item.headers)),
      }).catch((value) => value);
      expect(error).toMatchObject({ status: item.status });
    }
  });

  it("revalidates every redirect and rejects private destinations", async () => {
    const requested: string[] = [];
    const redirectTransport = transportFor((url) => {
      requested.push(url.toString());
      return requested.length === 1
        ? response("", 302, { location: "https://other.test:8443/final.csv" })
        : response("value\n1\n");
    });

    await downloadConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "redirected",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test:8443/start.csv",
      inspect: async () => {},
      transport: redirectTransport,
    });
    expect(requested).toEqual(["https://example.test:8443/start.csv", "https://other.test:8443/final.csv"]);

    const privateTransport: ConnectorFetchTransport = {
      async resolve() {
        throw new UrlPolicyError();
      },
      async request() {
        throw new Error("unreachable");
      },
    };
    const error = await downloadConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "private_feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "http://127.0.0.1/feed.csv",
      inspect: async () => {},
      transport: privateTransport,
    }).catch((value) => value);
    expect(error).toMatchObject({ status: 400 });
  });

  it("deletes only an exact proven version and remains idempotent", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    await writeFile(location, "value\n1\n", "utf8");
    await claimConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/feed.csv",
    });

    await expect(resolveConnectorCacheFile({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(location);

    const outside = path.join(testRoot, "outside.csv");
    await writeFile(outside, "value\nsecret\n", "utf8");
    await expect(
      cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location: outside })
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(outside, "utf8")).toContain("secret");

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(false);
  });

  it("propagates non-ENOENT inspection failures without deleting the cache version", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    await writeFile(location, "value\n1\n", "utf8");
    const originalLstat = fs.lstat.bind(fs);
    const inspection = vi.spyOn(fs, "lstat").mockImplementation(async (file) => {
      if (path.resolve(String(file)) === location) throw errno("EACCES");
      return originalLstat(file);
    });

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).rejects.toMatchObject({
      code: "EACCES",
    });
    inspection.mockRestore();
    await expect(readFile(location, "utf8")).resolves.toBe("value\n1\n");
  });

  it("removes exact staged download and manifest remnants before resolving cleanup", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    const manifest = cacheManifest(location);
    const stagedVersion = path.join(
      path.dirname(location),
      `.${path.basename(location)}.staged-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    );
    const stagedManifest = path.join(
      path.dirname(location),
      `.${path.basename(manifest)}.staged-11111111-aaaa-4bbb-8ccc-222222222222`
    );
    await writeFile(stagedVersion, "value\nprivate\n", { mode: 0o600 });
    await fs.link(stagedVersion, location);
    await writeFile(stagedManifest, "digest", { mode: 0o600 });
    await fs.link(stagedManifest, manifest);

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
    for (const file of [stagedVersion, location, stagedManifest, manifest]) {
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retains cleanup failure when an exact staged remnant cannot be unlinked", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    const staged = path.join(
      path.dirname(location),
      `.${path.basename(location)}.staged-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`
    );
    await writeFile(staged, "value\nprivate\n", { mode: 0o600 });
    const originalUnlink = fs.unlink.bind(fs);
    const removal = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (path.resolve(String(file)) === staged) throw errno("EACCES");
      return originalUnlink(file);
    });

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).rejects.toMatchObject({
      code: "EACCES",
    });
    removal.mockRestore();
    await expect(readFile(staged, "utf8")).resolves.toContain("private");
    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
  });

  it("does not report a claimed manifest while its private staged link cannot be removed", async () => {
    const originalUnlink = fs.unlink.bind(fs);
    let blockedStaged = "";
    const removal = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      const filename = String(file);
      if (filename.includes(".meta.staged-")) {
        blockedStaged = path.resolve(filename);
        throw errno("EACCES");
      }
      return originalUnlink(file);
    });

    await expect(
      claimConnectorVersion({
        accountId: ACCOUNT_ID,
        name: "feed",
        version: VERSION,
        expectedFormat: "csv",
        url: "https://example.test/feed.csv",
      })
    ).rejects.toMatchObject({ code: "EACCES" });
    removal.mockRestore();
    expect(blockedStaged).not.toBe("");
    await expect(fs.lstat(blockedStaged)).resolves.toMatchObject({ isFile: expect.any(Function) });

    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
    await expect(fs.lstat(blockedStaged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an unlink ENOENT race as successful exact cleanup", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    await writeFile(location, "value\n1\n", "utf8");
    await claimConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/feed.csv",
    });
    const originalUnlink = fs.unlink.bind(fs);
    let raced = false;
    const removal = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (!raced && path.resolve(String(file)) === location) {
        raced = true;
        await originalUnlink(file);
        throw errno("ENOENT");
      }
      return originalUnlink(file);
    });

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
    removal.mockRestore();
    await expect(readFile(location)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(cacheManifest(location))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an exact symlinked version without following or deleting its target", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    const outside = path.join(testRoot, "outside-target.csv");
    await writeFile(outside, "value\nsafe\n", "utf8");
    await symlink(outside, location);

    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).rejects.toMatchObject({
      status: 400,
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("value\nsafe\n");
  });

  it("ignores ENOTEMPTY but propagates other cache-directory removal failures", async () => {
    const location = await connectorVersionPath({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
    });
    await writeFile(location, "value\n1\n", "utf8");
    await claimConnectorVersion({
      accountId: ACCOUNT_ID,
      name: "feed",
      version: VERSION,
      expectedFormat: "csv",
      url: "https://example.test/feed.csv",
    });
    const sentinel = path.join(path.dirname(location), "another-version");
    await writeFile(sentinel, "keep", "utf8");
    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).resolves.toBe(true);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");

    await unlink(sentinel);
    await writeFile(location, "value\n2\n", "utf8");
    const originalRmdir = fs.rmdir.bind(fs);
    const directoryRemoval = vi.spyOn(fs, "rmdir").mockImplementation(async (directory) => {
      if (path.resolve(String(directory)) === path.dirname(location)) throw errno("EACCES");
      return originalRmdir(directory);
    });
    await expect(cleanupConnectorVersion({ accountId: ACCOUNT_ID, name: "feed", location })).rejects.toMatchObject({
      code: "EACCES",
    });
    directoryRemoval.mockRestore();
  });

  it("rejects symlinked cache namespace components", async () => {
    const root = config.uploadDir;
    const realCache = path.join(root, "real-cache");
    await writeFile(path.join(root, "sentinel"), "safe", "utf8");
    await rm(realCache, { recursive: true, force: true });
    await symlink(root, path.join(root, "url_cache"));

    await expect(
      connectorVersionPath({
        accountId: ACCOUNT_ID,
        name: "feed",
        version: VERSION,
        expectedFormat: "csv",
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
