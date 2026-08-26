import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { extractText, preflightDocxArchive } from "../ingestSupport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("bounded document extraction", () => {
  it("rejects legacy .doc instead of claiming DOCX parser support", async () => {
    await expect(extractText("/does/not/need/to/exist.doc", "application/msword")).rejects.toThrow(
      "legacy .doc files are not supported"
    );
  });

  it("does not let an ambiguous Word MIME override a supported text extension", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "renamed.txt");
    await fs.writeFile(filePath, "plain text");
    await expect(extractText(filePath, "application/msword")).resolves.toBe("plain text");
  });

  it("rejects a DOCX central directory that claims bomb-scale expansion", () => {
    const names = ["[Content_Types].xml", "word/document.xml"];
    const centralParts = names.map((name, index) => {
      const filename = Buffer.from(name);
      const entry = Buffer.alloc(46 + filename.length);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(1, 20);
      entry.writeUInt32LE(index === 0 ? 60 * 1024 * 1024 : 1, 24);
      entry.writeUInt16LE(filename.length, 28);
      filename.copy(entry, 46);
      return entry;
    });
    const central = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(0, 16);
    expect(() => preflightDocxArchive(Buffer.concat([central, eocd]))).toThrow("safe limits");
  });

  it("rejects DOCX members whose actual expansion exceeds their declared size", () => {
    const members = [
      { name: "[Content_Types].xml", body: Buffer.from("<Types />"), declaredSize: 9 },
      { name: "word/document.xml", body: Buffer.alloc(256 * 1024, 0x41), declaredSize: 1 },
    ];
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let localOffset = 0;
    for (const member of members) {
      const filename = Buffer.from(member.name);
      const compressed = deflateRawSync(member.body);
      const local = Buffer.alloc(30 + filename.length + compressed.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(member.declaredSize, 22);
      local.writeUInt16LE(filename.length, 26);
      filename.copy(local, 30);
      compressed.copy(local, 30 + filename.length);
      locals.push(local);

      const central = Buffer.alloc(46 + filename.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(member.declaredSize, 24);
      central.writeUInt16LE(filename.length, 28);
      central.writeUInt32LE(localOffset, 42);
      filename.copy(central, 46);
      centrals.push(central);
      localOffset += local.length;
    }
    const localBytes = Buffer.concat(locals);
    const centralBytes = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(localBytes.length, 16);

    expect(() => preflightDocxArchive(Buffer.concat([localBytes, centralBytes, eocd]))).toThrow("safe limits");
  });
});
