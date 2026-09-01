import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { extractPdfText, extractText, preflightDocxArchive } from "../ingestSupport.js";
import { LocalOcrUnavailableError } from "../localPdfOcr.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("bounded document extraction", () => {
  it("bypasses OCR when a PDF page already has meaningful embedded text", async () => {
    const recognize = vi.fn();
    const text = await extractPdfText("/owned/text.pdf", minimalPdf("Borealis readable text"), recognize);
    expect(text).toContain("Borealis readable text");
    expect(recognize).not.toHaveBeenCalled();
  });

  it("OCRs only a text-empty page and adds deterministic page metadata", async () => {
    const controller = new AbortController();
    const recognize = vi.fn(async (_path: string, pages: readonly number[]) => [
      { page: pages[0]!, text: "Recognized statement total" },
    ]);
    await expect(extractPdfText("/owned/scan.pdf", minimalPdf(""), recognize, controller.signal)).resolves.toBe(
      "[Page 1 — OCR]\nRecognized statement total"
    );
    expect(recognize).toHaveBeenCalledWith("/owned/scan.pdf", [1], controller.signal);
  });

  it("OCRs an imaged page whose embedded text layer is only a sparse footer", async () => {
    const recognize = vi.fn(async (_path: string, pages: readonly number[]) => [
      { page: pages[0]!, text: "Recognized contract body" },
    ]);

    await expect(extractPdfText("/owned/sparse-overlay.pdf", minimalPdf("Page 1 of 10", 24), recognize)).resolves.toBe(
      "[Page 1 — OCR]\nRecognized contract body"
    );
    expect(recognize).toHaveBeenCalledWith("/owned/sparse-overlay.pdf", [1], undefined);
  });

  it("distinguishes unavailable local OCR from an ordinary empty extraction", async () => {
    await expect(
      extractPdfText("/owned/scan.pdf", minimalPdf(""), async () => {
        throw new LocalOcrUnavailableError();
      })
    ).rejects.toBeInstanceOf(LocalOcrUnavailableError);
  });

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

function minimalPdf(text: string, y = 720): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = escaped ? `BT /F1 12 Tf 72 ${y} Td (${escaped}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n%\xFF\xFF\xFF\xFF\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}
