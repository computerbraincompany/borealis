import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,180}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
/** Sane hard default; operators can raise it for large models. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 * 1024;

export type ContainedDownloadState = "downloading" | "verifying" | "complete" | "failed" | "canceled";

export interface ContainedDownload {
  readonly filename: string;
  readonly url_host: string;
  readonly state: ContainedDownloadState;
  readonly bytes_received: number;
  readonly total_bytes: number | null;
  readonly error: string | null;
}

/** Internal, mutable bookkeeping; snapshots freeze into ContainedDownload. */
interface MutableContainedDownload {
  filename: string;
  url_host: string;
  state: ContainedDownloadState;
  bytes_received: number;
  total_bytes: number | null;
  error: string | null;
}

export class ContainedDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainedDownloadError";
  }
}

function containedDir(): string {
  return config.containedDir;
}

function sanitizeFilename(value: unknown): string {
  if (typeof value !== "string" || !FILENAME_PATTERN.test(value) || value.includes("..")) {
    throw new ContainedDownloadError("filename must be 1-180 characters of [A-Za-z0-9._-] without separators");
  }
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ContainedDownloadError("sha256 must be a 64-character hex digest");
  }
  return value.toLowerCase();
}

function requireUrl(value: unknown): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === "string" ? value : "");
  } catch {
    throw new ContainedDownloadError("url must be an absolute HTTPS or loopback HTTP origin");
  }
  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new ContainedDownloadError("model downloads require HTTPS or a loopback HTTP origin");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ContainedDownloadError("url must be a bare origin + path without credentials, query, or fragment");
  }
  return { url: parsed.toString(), host: parsed.host };
}

function maxDownloadBytes(): number {
  const raw = Number(process.env.CONTAINED_MAX_DOWNLOAD_BYTES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_DOWNLOAD_BYTES;
}

export function createContainedDownloadManager() {
  const downloads = new Map<string, { state: MutableContainedDownload; abort: AbortController | null }>();

  function partPath(filename: string): string {
    return path.join(containedDir(), `${filename}.part`);
  }

  function finalPath(filename: string): string {
    return path.join(containedDir(), filename);
  }

  function snapshot(): ContainedDownload[] {
    return [...downloads.values()].map((entry) => ({ ...entry.state }));
  }

  async function start(input: { url: unknown; filename: unknown; sha256: unknown }): Promise<ContainedDownload> {
    const { url, host } = requireUrl(input.url);
    const filename = sanitizeFilename(input.filename);
    const sha256 = requireSha256(input.sha256);
    const existing = downloads.get(filename);
    if (existing && (existing.state.state === "downloading" || existing.state.state === "verifying")) {
      throw new ContainedDownloadError("a download for this filename is already active");
    }

    await fs.mkdir(containedDir(), { mode: 0o700, recursive: true });
    let received: number;
    try {
      received = (await fs.stat(partPath(filename))).size;
    } catch {
      received = 0;
    }
    if (await fileExists(finalPath(filename))) {
      throw new ContainedDownloadError("this filename already exists as a complete model file");
    }

    const abort = new AbortController();
    const state: MutableContainedDownload = {
      filename,
      url_host: host,
      state: "downloading",
      bytes_received: received,
      total_bytes: null,
      error: null,
    };
    downloads.set(filename, { state, abort });

    void run({ url, filename, sha256, state, abort }).catch(() => undefined);
    return { ...state };
  }

  async function run(input: {
    url: string;
    filename: string;
    sha256: string;
    state: MutableContainedDownload;
    abort: AbortController;
  }): Promise<void> {
    const { url, filename, sha256, state, abort } = input;
    const max = maxDownloadBytes();
    try {
      const headers: Record<string, string> = { Accept: "application/octet-stream" };
      if (state.bytes_received > 0) headers.Range = `bytes=${state.bytes_received}-`;
      const response = await fetch(url, { headers, redirect: "error", signal: abort.signal });
      if (!(response.status === 200 || response.status === 206)) {
        throw new ContainedDownloadError(`download refused with HTTP ${response.status}`);
      }
      if (response.status === 200) state.bytes_received = 0;
      if (state.bytes_received > max) throw new ContainedDownloadError("download exceeds the configured size bound");

      const contentLength = response.headers.get("content-length");
      const range = response.headers.get("content-range");
      if (response.status === 206 && range) {
        const total = Number(range.split("/")[1]);
        state.total_bytes = Number.isSafeInteger(total) ? total : null;
      } else if (contentLength) {
        const total = Number(contentLength) + state.bytes_received;
        state.total_bytes = Number.isSafeInteger(total) ? total : null;
        if (state.total_bytes !== null && state.total_bytes > max) {
          throw new ContainedDownloadError("download exceeds the configured size bound");
        }
      }

      state.state = "downloading";
      let received = state.bytes_received;
      const reader = response.body?.getReader();
      if (!reader) throw new ContainedDownloadError("download response had no body");
      const handle = await fs.open(partPath(filename), received > 0 ? "a" : "w", 0o600);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > max) throw new ContainedDownloadError("download exceeds the configured size bound");
          await handle.write(value);
          state.bytes_received = received;
        }
      } finally {
        await handle.close().catch(() => undefined);
        await reader.cancel().catch(() => undefined);
      }

      state.state = "verifying";
      const digest = await sha256File(partPath(filename));
      if (digest !== sha256) {
        await fs.rm(partPath(filename), { force: true });
        throw new ContainedDownloadError("checksum mismatch: the downloaded bytes did not match sha256");
      }
      await fs.rename(partPath(filename), finalPath(filename));
      state.state = "complete";
      state.error = null;
    } catch (error) {
      if (state.state === "canceled") return;
      if (abort.signal.aborted) {
        state.state = "canceled";
        state.error = "download canceled";
        return;
      }
      state.state = "failed";
      state.error = error instanceof ContainedDownloadError ? error.message : "download failed";
    }
  }

  async function cancel(filenameValue: unknown): Promise<boolean> {
    const filename = sanitizeFilename(filenameValue);
    const entry = downloads.get(filename);
    if (!entry) return false;
    entry.state.state = "canceled";
    entry.state.error = "download canceled";
    entry.abort?.abort();
    await fs.rm(partPath(filename), { force: true });
    return true;
  }

  async function sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const handle = await fs.open(filePath, "r");
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return hash.digest("hex");
  }

  return { start, cancel, snapshot, sha256File, fileExists };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export { fileExists };
