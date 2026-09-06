import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBrowserOpenIntents,
  closeDesktopCustodyPort,
  configureDesktopCustodyPort,
  consumeDesktopBrowserOpenIntent,
  DesktopSafeStorageKeyCustody,
  DESKTOP_OPEN_INTENT_TTL_MS,
  desktopCustodySecretStore,
  mintDesktopBrowserOpenIntent,
  resetDesktopCustodyStore,
  type DesktopCustodyPort,
} from "../connections/desktopCustody.js";
import {
  ConnectionCustodyUnavailableError,
  connectionAuthorizationReference,
  FileConnectionSecretStore,
} from "../connections/secrets.js";

const ACCOUNT = randomUUID();
const CONNECTION = randomUUID();
const SECRETS = { headers: { authorization: "Bearer desktop-custody-secret" }, env: {} };

/** Electron-main stand-in: answers the narrow custody pair from memory. */
class MockMainPort implements DesktopCustodyPort {
  posted: Record<string, unknown>[] = [];
  key = randomBytes(32);
  mode: "key" | "fail" | "silent" = "key";
  listener: ((message: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    const payload = message as Record<string, unknown>;
    this.posted.push(payload);
    if (payload.type !== "custody-request" || this.mode === "silent") return;
    const requestId = payload.request_id;
    queueMicrotask(() => {
      this.receive(
        this.mode === "key"
          ? { type: "custody-response", request_id: requestId, ok: true, data: this.key }
          : { type: "custody-response", request_id: requestId, ok: false, reason: "custody" }
      );
    });
  }

  on(_event: "message", listener: (message: unknown) => void): this {
    this.listener = listener;
    return this;
  }

  off(_event: "message", listener: (message: unknown) => void): this {
    if (this.listener === listener) this.listener = null;
    return this;
  }

  /** Deliver a main→utility message exactly like the utility parent port does. */
  receive(payload: unknown): void {
    this.listener?.({ data: payload });
  }

  ops(): unknown[] {
    return this.posted.filter((entry) => entry.type === "custody-request").map((entry) => entry.op);
  }
}

const directories: string[] = [];

async function tempRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-desktop-custody-"));
  directories.push(directory);
  return directory;
}

async function scanForNeedle(root: string, needle: string): Promise<string[]> {
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const text = await fs.readFile(full).catch(() => Buffer.alloc(0));
        if (text.includes(Buffer.from(needle, "utf8"))) offenders.push(full);
      }
    }
  };
  await walk(root);
  return offenders;
}

function storeIn(root: string, custody: DesktopSafeStorageKeyCustody): FileConnectionSecretStore {
  return new FileConnectionSecretStore({ directory: path.join(root, "secrets"), custody });
}

let port: MockMainPort;

beforeEach(() => {
  port = new MockMainPort();
  configureDesktopCustodyPort(port);
});

afterEach(async () => {
  closeDesktopCustodyPort();
  clearDesktopBrowserOpenIntents();
  resetDesktopCustodyStore();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("desktop custody key adapter", () => {
  it("round-trips credential records through the main-owned key without plaintext", async () => {
    const root = await tempRoot();
    const store = storeIn(root, new DesktopSafeStorageKeyCustody());

    await store.put(ACCOUNT, CONNECTION, SECRETS);
    expect(port.ops()).toContain("ensure");
    const recordPath = path.join(root, "secrets", ACCOUNT, `${CONNECTION}.json`);
    expect(await scanForNeedle(root, "desktop-custody-secret")).toEqual([]);
    expect(await scanForNeedle(root, port.key.toString("binary"))).toEqual([]);

    port.posted = [];
    const read = await store.read(ACCOUNT, CONNECTION);
    expect(read.state).toBe("available");
    if (read.state === "available") expect(read.secrets.headers.authorization).toBe("Bearer desktop-custody-secret");
    // Reads never create keys.
    expect(port.ops()).toEqual(["read"]);
    expect(await fs.readFile(recordPath, "utf8")).not.toContain("desktop-custody-secret");
  });

  it("reports the actionable disconnected state when main cannot answer, and the unavailable reference", async () => {
    const root = await tempRoot();
    const store = storeIn(root, new DesktopSafeStorageKeyCustody());
    await store.put(ACCOUNT, CONNECTION, SECRETS);

    port.mode = "fail";
    const read = await store.read(ACCOUNT, CONNECTION);
    expect(read.state).toBe("unavailable");
    if (read.state === "unavailable") expect(read.reason).toBe("custody");
    expect(connectionAuthorizationReference(read)).toBe("unavailable:custody");
  });

  it("fails closed without a utility port and never writes plaintext", async () => {
    const root = await tempRoot();
    closeDesktopCustodyPort();
    const store = storeIn(root, new DesktopSafeStorageKeyCustody());
    await expect(store.put(ACCOUNT, CONNECTION, SECRETS)).rejects.toBeInstanceOf(ConnectionCustodyUnavailableError);
    expect(await scanForNeedle(root, "desktop-custody-secret")).toEqual([]);
    expect(await new DesktopSafeStorageKeyCustody().readKey()).toBeUndefined();
    expect(await new DesktopSafeStorageKeyCustody().ensureKey()).toBeUndefined();
  });

  it("rejects outstanding custody requests when the port closes mid-flight", async () => {
    port.mode = "silent";
    const pending = new DesktopSafeStorageKeyCustody().readKey();
    await Promise.resolve();
    closeDesktopCustodyPort();
    await expect(pending).resolves.toBeUndefined();
  });

  it("ignores malformed main responses and times out to the unavailable state", async () => {
    vi.useFakeTimers();
    port.mode = "silent";
    const custody = new DesktopSafeStorageKeyCustody();
    let settled = false;
    const pending = custody.readKey().then((key) => {
      settled = true;
      return key;
    });
    await vi.advanceTimersByTimeAsync(0);
    const requestId = port.posted[0]?.request_id;
    // Wrong ids, wrong shapes, oversized keys, and unknown types all ignored.
    port.receive({ type: "custody-response", request_id: "someone-else", ok: true, data: port.key });
    port.receive({ type: "custody-response", request_id: requestId, ok: true, data: randomBytes(16) });
    port.receive({ type: "custody-response", request_id: requestId, ok: true, data: randomBytes(64) });
    port.receive({ type: "custody-response", request_id: requestId, ok: "yes" });
    port.receive({ type: "not-a-custody-response" });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("serves only one store composition and re-composes after a reset", () => {
    expect(desktopCustodySecretStore()).toBe(desktopCustodySecretStore());
    const first = desktopCustodySecretStore();
    resetDesktopCustodyStore();
    expect(desktopCustodySecretStore()).not.toBe(first);
  });
});

describe("desktop browser open intents", () => {
  const URLS = {
    https: "https://idp.example.test/authorize?x=1",
    loopback: "http://127.0.0.1:4545/callback",
    publicHttp: "http://idp.example.test/authorize",
    credentials: "https://user:pass@idp.example.test/authorize",
    file: "file:///tmp/evil",
  };

  it("mints one-time tokens bound to the exact validated URL", () => {
    const minted = mintDesktopBrowserOpenIntent(`${ACCOUNT}:${CONNECTION}`, URLS.https);
    expect(minted).toBeDefined();
    expect(consumeDesktopBrowserOpenIntent(minted!.token, URLS.https)).toBe(true);
    // The token is consumed by the first success; replays fail closed.
    expect(consumeDesktopBrowserOpenIntent(minted!.token, URLS.https)).toBe(false);
  });

  it("refuses URL mismatches, unknown tokens, malformed tokens, and bad targets", () => {
    const minted = mintDesktopBrowserOpenIntent(`${ACCOUNT}:${CONNECTION}`, URLS.https)!;
    expect(consumeDesktopBrowserOpenIntent(minted.token, URLS.loopback)).toBe(false);

    const second = mintDesktopBrowserOpenIntent("k", URLS.https)!;
    expect(consumeDesktopBrowserOpenIntent(second.token, URLS.https)).toBe(true);

    expect(consumeDesktopBrowserOpenIntent("unknown-token-value", URLS.https)).toBe(false);
    expect(consumeDesktopBrowserOpenIntent("short", URLS.https)).toBe(false);
    expect(consumeDesktopBrowserOpenIntent(minted.token, 42)).toBe(false);
    expect(consumeDesktopBrowserOpenIntent(minted.token, URLS.file)).toBe(false);
  });

  it("mints only for https and explicit loopback development targets", () => {
    expect(mintDesktopBrowserOpenIntent("k", URLS.publicHttp)).toBeUndefined();
    expect(mintDesktopBrowserOpenIntent("k", URLS.credentials)).toBeUndefined();
    expect(mintDesktopBrowserOpenIntent("k", URLS.file)).toBeUndefined();
    expect(mintDesktopBrowserOpenIntent("k", "not a url")).toBeUndefined();
    expect(mintDesktopBrowserOpenIntent("k", URLS.loopback)).toBeDefined();
  });

  it("expires intents on the sign-in window", () => {
    vi.useFakeTimers();
    const minted = mintDesktopBrowserOpenIntent("k", URLS.https)!;
    vi.advanceTimersByTime(DESKTOP_OPEN_INTENT_TTL_MS + 1);
    expect(consumeDesktopBrowserOpenIntent(minted.token, URLS.https)).toBe(false);
  });

  it("answers main's open-verify requests exactly once over the port", () => {
    const minted = mintDesktopBrowserOpenIntent("k", URLS.https)!;
    port.mode = "silent";
    port.receive({ type: "open-verify-request", request_id: "r-1", token: minted.token, url: URLS.https });
    expect(port.posted.at(-1)).toEqual({ type: "open-verify-response", request_id: "r-1", ok: true });

    port.receive({ type: "open-verify-request", request_id: "r-2", token: minted.token, url: URLS.https });
    expect(port.posted.at(-1)).toEqual({ type: "open-verify-response", request_id: "r-2", ok: false });

    // Missing/invalid request ids get no answer at all.
    const before = port.posted.length;
    port.receive({ type: "open-verify-request", request_id: "", token: minted.token, url: URLS.https });
    expect(port.posted.length).toBe(before);
  });

  it("issues no intent without the desktop port", () => {
    closeDesktopCustodyPort();
    expect(mintDesktopBrowserOpenIntent("k", URLS.https)).toBeUndefined();
  });
});
