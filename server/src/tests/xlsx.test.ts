import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";

import { convertXlsxToCsv, DataProcessingError } from "../data/xlsx.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "borealis-xlsx-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

async function workbookPath(build: (workbook: ExcelJS.Workbook) => void): Promise<string> {
  const inputPath = await temporaryPath("fixture.xlsx");
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  await workbook.xlsx.writeFile(inputPath);
  return inputPath;
}

function centralDirectoryOffset(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return archive.readUInt32LE(offset + 16);
  }
  throw new Error("missing ZIP central directory");
}

async function expectStatus(operation: Promise<unknown>, statusCode: number): Promise<DataProcessingError> {
  const error = await operation.catch((value) => value);
  expect(error).toBeInstanceOf(DataProcessingError);
  expect(error).toMatchObject({ status: statusCode, code: "DATA_PROCESSING_ERROR" });
  return error as DataProcessingError;
}

describe("bounded XLSX conversion", () => {
  it("streams only the first worksheet to CSV and cleans its temporary artifact idempotently", async () => {
    const inputPath = await workbookPath((workbook) => {
      const first = workbook.addWorksheet("Ledger");
      first.addRow(["item", "amount", "active"]);
      first.addRow(["rent", 1200.5, true]);
      first.addRow(["quoted, value", 'say "hello"', false]);
      const second = workbook.addWorksheet("Private");
      second.addRow(["must-not-appear"]);
    });

    const converted = await convertXlsxToCsv(inputPath);
    const outputDirectory = path.dirname(converted.path);

    expect(await readFile(converted.path, "utf8")).toBe(
      'item,amount,active\r\nrent,1200.5,True\r\n"quoted, value","say ""hello""",False\r\n'
    );
    await converted.cleanup();
    await converted.cleanup();
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized ZIP member during preflight", async () => {
    const inputPath = await workbookPath((workbook) => {
      workbook.addWorksheet("Ledger").addRow(["value"]);
    });
    const archive = await readFile(inputPath);
    const centralOffset = centralDirectoryOffset(archive);
    archive.writeUInt32LE(50 * 1024 * 1024 + 1, centralOffset + 24);
    await writeFile(inputPath, archive);

    await expectStatus(convertXlsxToCsv(inputPath), 413);
  });

  it("rejects encrypted members during preflight", async () => {
    const inputPath = await workbookPath((workbook) => {
      workbook.addWorksheet("Ledger").addRow(["value"]);
    });
    const archive = await readFile(inputPath);
    const centralOffset = centralDirectoryOffset(archive);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    archive.writeUInt16LE(archive.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
    archive.writeUInt16LE(archive.readUInt16LE(localOffset + 6) | 0x0001, localOffset + 6);
    await writeFile(inputPath, archive);

    const error = await expectStatus(convertXlsxToCsv(inputPath), 422);
    expect(error.message).toBe("encrypted xlsx workbooks are not supported");
  });

  it("rejects legacy XLS before attempting ZIP parsing", async () => {
    const inputPath = await temporaryPath("legacy.xls");
    await writeFile(inputPath, "not an xls workbook");

    const error = await expectStatus(convertXlsxToCsv(inputPath), 422);
    expect(error.message).toContain("legacy .xls");
  });

  it("rejects empty worksheets", async () => {
    const inputPath = await workbookPath((workbook) => {
      workbook.addWorksheet("Empty");
    });

    const error = await expectStatus(convertXlsxToCsv(inputPath), 422);
    expect(error.message).toBe("xlsx worksheet is empty");
  });

  it("bounds worksheet row and column coordinates", async () => {
    const excessiveRow = await workbookPath((workbook) => {
      workbook.addWorksheet("Rows").getCell(200_001, 1).value = "outside";
    });
    await expectStatus(convertXlsxToCsv(excessiveRow), 413);

    const excessiveColumn = await workbookPath((workbook) => {
      workbook.addWorksheet("Columns").getCell(1, 10_001).value = "outside";
    });
    await expectStatus(convertXlsxToCsv(excessiveColumn), 413);
  });

  it("bounds rendered cell bytes", async () => {
    const inputPath = await workbookPath((workbook) => {
      workbook.addWorksheet("Large").addRow(["x".repeat(1_000_001)]);
    });

    await expectStatus(convertXlsxToCsv(inputPath), 413);
  });
});
