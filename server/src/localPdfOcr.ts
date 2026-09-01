import { execFile, type ExecFileException } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";

const OSASCRIPT = "/usr/bin/osascript";
const HELPER = new URL("./data/assets/pdf-ocr.jxa", import.meta.url);
const OCR_LANGUAGE = "en-US";
const HELPER_JSON_OVERHEAD_BYTES = 256;
const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIGURED_PAGE_CHARS = 100_000;

export interface PdfOcrPage {
  readonly page: number;
  readonly text: string;
}

export class LocalOcrUnavailableError extends Error {
  constructor() {
    super("local PDF OCR is unavailable");
    this.name = "LocalOcrUnavailableError";
  }
}

export class LocalOcrError extends Error {
  constructor() {
    super("local PDF OCR failed");
    this.name = "LocalOcrError";
  }
}

type ExecFileImplementation = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly killSignal: NodeJS.Signals;
    readonly signal?: AbortSignal;
    readonly windowsHide: boolean;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
) => unknown;

export interface LocalPdfOcrDependencies {
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly helperPath?: string;
  readonly execFile?: ExecFileImplementation;
  readonly now?: () => number;
  readonly maxPageChars?: number;
}

interface HelperPayload {
  readonly page?: unknown;
  readonly text?: unknown;
  readonly observations?: unknown;
}

/**
 * Recognize only the requested PDF pages with the fixed local Vision/PDFKit
 * helper. One child is used per page so both per-page and aggregate deadlines
 * are enforceable outside synchronous framework calls.
 */
export async function recognizeLocalPdfPages(
  filePath: string,
  pagesInput: readonly number[],
  signal?: AbortSignal,
  dependencies: LocalPdfOcrDependencies = {}
): Promise<readonly PdfOcrPage[]> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") throw new LocalOcrUnavailableError();

  const executable = dependencies.executable ?? OSASCRIPT;
  const helperPath = dependencies.helperPath ?? resolveExternalOcrHelperPath(fileURLToPath(HELPER));
  const run = dependencies.execFile ?? (execFile as unknown as ExecFileImplementation);
  const now = dependencies.now ?? (() => performance.now());
  const maxPageChars = dependencies.maxPageChars ?? config.ocrMaxPageChars;
  const helperOutputBytes = localOcrHelperOutputByteLimit(maxPageChars);
  throwIfAborted(signal);
  const file = await proveRegularRealFile(filePath);
  await proveExecutable(executable);
  const helper = await proveRegularRealFile(helperPath);

  const pages = normalizePages(pagesInput);
  if (!pages.length) return Object.freeze([]);
  const startedAt = now();
  const results: PdfOcrPage[] = [];
  for (const page of pages) {
    throwIfAborted(signal);
    const remaining = config.ocrTotalTimeoutMs - Math.max(0, now() - startedAt);
    if (remaining < 1) throw new LocalOcrError();
    const timeout = Math.max(1, Math.min(config.ocrPageTimeoutMs, remaining));
    const payload = await runHelper(
      run,
      executable,
      helper,
      file,
      page,
      timeout,
      maxPageChars,
      helperOutputBytes,
      signal
    );
    results.push(decodeHelperPayload(payload, page, maxPageChars));
  }
  return Object.freeze(results);
}

/** Translate only Electron's fixed ASAR runtime path for an external OS process. */
export function resolveExternalOcrHelperPath(input: string): string {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new LocalOcrUnavailableError();
  }
  const resolved = path.resolve(input);
  const marker = `${path.sep}app.asar${path.sep}`;
  const markerIndex = resolved.indexOf(marker);
  if (markerIndex < 0) return resolved;
  if (resolved.indexOf(marker, markerIndex + marker.length) >= 0) throw new LocalOcrUnavailableError();
  return `${resolved.slice(0, markerIndex)}${path.sep}app.asar.unpacked${path.sep}${resolved.slice(markerIndex + marker.length)}`;
}

/** Bound worst-case JSON escaping at six UTF-8 bytes per UTF-16 code unit. */
export function localOcrHelperOutputByteLimit(maxPageChars: number): number {
  if (!Number.isSafeInteger(maxPageChars) || maxPageChars < 1 || maxPageChars > MAX_CONFIGURED_PAGE_CHARS) {
    throw new LocalOcrError();
  }
  return Math.min(MAX_HELPER_OUTPUT_BYTES, maxPageChars * 6 + HELPER_JSON_OVERHEAD_BYTES);
}

function normalizePages(input: readonly number[]): number[] {
  if (!Array.isArray(input) || input.length > config.ocrMaxPages) throw new LocalOcrError();
  const seen = new Set<number>();
  const pages: number[] = [];
  for (const value of input) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 500 || seen.has(value)) throw new LocalOcrError();
    seen.add(value);
    pages.push(value);
  }
  return pages.sort((left, right) => left - right);
}

async function proveRegularRealFile(input: string): Promise<string> {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new LocalOcrUnavailableError();
  }
  const resolved = path.resolve(input);
  try {
    const [stat, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalOcrUnavailableError();
    return real;
  } catch (error) {
    if (error instanceof LocalOcrUnavailableError) throw error;
    throw new LocalOcrUnavailableError();
  }
}

async function proveExecutable(filename: string): Promise<void> {
  try {
    await fs.access(filename, fsConstants.X_OK);
  } catch {
    throw new LocalOcrUnavailableError();
  }
}

function runHelper(
  run: ExecFileImplementation,
  executable: string,
  helperPath: string,
  filePath: string,
  page: number,
  timeout: number,
  maxPageChars: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    run(
      executable,
      [
        "-l",
        "JavaScript",
        helperPath,
        "--",
        filePath,
        String(page),
        String(config.ocrMaxRasterPixels),
        String(config.ocrMaxObservations),
        String(maxPageChars),
        OCR_LANGUAGE,
      ],
      {
        encoding: "utf8",
        timeout,
        maxBuffer: maxOutputBytes,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
          reject(signal?.aborted ? signal.reason : new LocalOcrError());
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function decodeHelperPayload(raw: string, expectedPage: number, maxPageChars: number): PdfOcrPage {
  let parsed: HelperPayload;
  try {
    parsed = JSON.parse(raw) as HelperPayload;
  } catch {
    throw new LocalOcrError();
  }
  if (
    parsed.page !== expectedPage ||
    typeof parsed.text !== "string" ||
    parsed.text.length > maxPageChars ||
    typeof parsed.observations !== "number" ||
    !Number.isSafeInteger(parsed.observations) ||
    parsed.observations < 0 ||
    parsed.observations > config.ocrMaxObservations ||
    parsed.text.includes("\0")
  ) {
    throw new LocalOcrError();
  }
  return Object.freeze({ page: expectedPage, text: normalizeRecognizedText(parsed.text) });
}

function normalizeRecognizedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}
