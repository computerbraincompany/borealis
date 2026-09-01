import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalOcrError,
  LocalOcrUnavailableError,
  localOcrHelperOutputByteLimit,
  recognizeLocalPdfPages,
  resolveExternalOcrHelperPath,
} from "../localPdfOcr.js";

const temporaryDirectories: string[] = [];

async function fixtureFiles(): Promise<{ input: string; executable: string; helper: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ocr-"));
  temporaryDirectories.push(directory);
  const input = path.join(directory, "input.pdf");
  const executable = path.join(directory, "osascript");
  const helper = path.join(directory, "pdf-ocr.jxa");
  await Promise.all([
    fs.writeFile(input, "%PDF-1.4\n"),
    fs.writeFile(executable, "#!/bin/sh\n"),
    fs.writeFile(helper, "function run() {}\n"),
  ]);
  await fs.chmod(executable, 0o700);
  return { input, executable, helper };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("bounded local PDF OCR adapter", () => {
  it("rejects invalid or unbounded helper raster geometry before AppKit", async () => {
    const source = await fs.readFile(new URL("../data/assets/pdf-ocr.jxa", import.meta.url), "utf8");
    const context: {
      ObjC: { import: () => undefined };
      rasterSizeForBounds?: (width: number, height: number, maxPixels: number) => { width: number; height: number };
    } = { ObjC: { import: () => undefined } };
    runInNewContext(source, context);
    const rasterSizeForBounds = context.rasterSizeForBounds;
    expect(rasterSizeForBounds).toBeTypeOf("function");
    if (!rasterSizeForBounds) throw new Error("OCR helper raster contract is unavailable");

    const valid = rasterSizeForBounds(612, 792, 16_000_000);
    expect(valid.width).toBeGreaterThan(0);
    expect(valid.height).toBeGreaterThan(0);
    expect(Number.isSafeInteger(valid.width)).toBe(true);
    expect(Number.isSafeInteger(valid.height)).toBe(true);
    expect(valid.width * valid.height).toBeLessThanOrEqual(16_000_000);

    for (const [width, height] of [
      [Number.NaN, 792],
      [Number.POSITIVE_INFINITY, 792],
      [0, 792],
      [-1, 792],
      [612, Number.NEGATIVE_INFINITY],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MAX_VALUE, Number.MIN_VALUE],
    ]) {
      expect(() => rasterSizeForBounds(width!, height!, 16_000_000)).toThrow();
    }
  });

  it("maps only the fixed packaged ASAR helper to its physical unpacked path", () => {
    expect(
      resolveExternalOcrHelperPath(
        "/Applications/Borealis.app/Contents/Resources/app.asar/runtime/server/dist/data/assets/pdf-ocr.jxa"
      )
    ).toBe(
      "/Applications/Borealis.app/Contents/Resources/app.asar.unpacked/runtime/server/dist/data/assets/pdf-ocr.jxa"
    );
    expect(resolveExternalOcrHelperPath("/tmp/runtime/server/dist/data/assets/pdf-ocr.jxa")).toBe(
      "/tmp/runtime/server/dist/data/assets/pdf-ocr.jxa"
    );
  });

  it("uses the fixed executable contract once per sorted page and validates output", async () => {
    const fixture = await fixtureFiles();
    const calls: readonly string[][] = [];
    const exec = vi.fn((_file, args: readonly string[], _options, callback) => {
      (calls as string[][]).push([...args]);
      const page = Number(args[5]);
      callback(null, JSON.stringify({ page, text: ` page ${page} \r\n text `, observations: 2 }), "");
    });

    await expect(
      recognizeLocalPdfPages(fixture.input, [3, 1], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
        now: () => 0,
      })
    ).resolves.toEqual([
      { page: 1, text: "page 1\ntext" },
      { page: 3, text: "page 3\ntext" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(0, 5)).toEqual([
      "-l",
      "JavaScript",
      await fs.realpath(fixture.helper),
      "--",
      await fs.realpath(fixture.input),
    ]);
    expect(calls.map((args) => args[5])).toEqual(["1", "3"]);
  });

  it("accepts the maximum configured character payload within a derived byte ceiling", async () => {
    const fixture = await fixtureFiles();
    const maxPageChars = 100_000;
    const text = "\u0001".repeat(maxPageChars);
    const payload = JSON.stringify({ page: 1, text, observations: 1 });
    const exec = vi.fn((_file, _args, options, callback) => {
      expect(options.maxBuffer).toBe(localOcrHelperOutputByteLimit(maxPageChars));
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(options.maxBuffer);
      callback(null, payload, "");
    });

    await expect(
      recognizeLocalPdfPages(fixture.input, [1], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
        maxPageChars,
      })
    ).resolves.toEqual([{ page: 1, text }]);
  });

  it("enforces one aggregate deadline with the injected monotonic clock", async () => {
    const fixture = await fixtureFiles();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
    const exec = vi.fn((_file, args: readonly string[], _options, callback) => {
      const page = Number(args[5]);
      callback(null, JSON.stringify({ page, text: `page ${page}`, observations: 1 }), "");
    });

    await expect(
      recognizeLocalPdfPages(fixture.input, [1, 2], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
        now,
      })
    ).rejects.toBeInstanceOf(LocalOcrError);
    expect(exec).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("fails closed on unavailable platforms, symlinked inputs, and malformed helper payloads", async () => {
    await expect(
      recognizeLocalPdfPages("/tmp/input.pdf", [1], undefined, { platform: "linux" })
    ).rejects.toBeInstanceOf(LocalOcrUnavailableError);

    const fixture = await fixtureFiles();
    const symlink = path.join(path.dirname(fixture.input), "linked.pdf");
    await fs.symlink(fixture.input, symlink);
    await expect(
      recognizeLocalPdfPages(symlink, [1], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
      })
    ).rejects.toBeInstanceOf(LocalOcrUnavailableError);

    const exec = vi.fn((_file, _args, _options, callback) => callback(null, '{"page":2,"text":"wrong"}', ""));
    await expect(
      recognizeLocalPdfPages(fixture.input, [1], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
      })
    ).rejects.toBeInstanceOf(LocalOcrError);
  });

  it("honors cancellation before launching and rejects duplicate or excessive page scopes", async () => {
    const fixture = await fixtureFiles();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const exec = vi.fn();
    await expect(
      recognizeLocalPdfPages(fixture.input, [1], controller.signal, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
      })
    ).rejects.toBe(reason);
    expect(exec).not.toHaveBeenCalled();

    await expect(
      recognizeLocalPdfPages(fixture.input, [1, 1], undefined, {
        platform: "darwin",
        executable: fixture.executable,
        helperPath: fixture.helper,
        execFile: exec,
      })
    ).rejects.toBeInstanceOf(LocalOcrError);
  });
});
