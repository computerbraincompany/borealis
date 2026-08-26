import { open, mkdtemp, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ExcelJS, { type CellValue, type Row } from "exceljs";

const MAX_XLSX_ROWS = 200_000;
const MAX_XLSX_COLUMNS = 10_000;
const MAX_XLSX_CELLS = 2_000_000;
const MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_XLSX_MEMBER_BYTES = 50 * 1024 * 1024;
const MAX_XLSX_ARCHIVE_MEMBERS = 10_000;
const MAX_XLSX_CELL_BYTES = 1_000_000;
const CSV_BUFFER_BYTES = 64 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 65_557;
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040;

type DataProcessingStatus = 413 | 422;

/** Safe, status-bearing failure for the in-process data-service facade. */
export class DataProcessingError extends Error {
  readonly code = "DATA_PROCESSING_ERROR";

  constructor(
    readonly status: DataProcessingStatus,
    message: string
  ) {
    super(message);
    this.name = "DataProcessingError";
  }
}

export interface ConvertedXlsx {
  path: string;
  cleanup(): Promise<void>;
}

interface WorkbookSheetModel {
  id?: number;
}

interface WorkbookReaderInternals {
  model: { sheets?: WorkbookSheetModel[] };
  workbookRels: unknown[];
  sharedStrings: unknown[];
  properties?: unknown;
  styles: unknown;
  stream?: { destroy?: () => void };
}

interface WorkbookMetadata {
  firstWorksheetId: number;
  model: WorkbookReaderInternals["model"];
  workbookRels: unknown[];
  sharedStrings: unknown[];
  properties?: unknown;
  styles: unknown;
}

function processingLimit(message: string): DataProcessingError {
  return new DataProcessingError(413, message);
}

function invalidWorkbook(message = "xlsx workbook could not be parsed"): DataProcessingError {
  return new DataProcessingError(422, message);
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw invalidWorkbook();
  return buffer;
}

function findEndOfCentralDirectory(tail: Buffer, fileSize: number): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    const absoluteOffset = fileSize - tail.length + offset;
    if (absoluteOffset + 22 + commentLength === fileSize) return absoluteOffset;
  }
  throw invalidWorkbook();
}

/**
 * Bound ZIP expansion and reject encryption before ExcelJS sees workbook XML.
 * ZIP64 and multi-disk archives are unnecessary under these limits and fail
 * closed instead of widening the parser surface.
 */
async function preflightXlsxArchive(inputPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(inputPath, "r");
    const stat = await handle.stat();
    const fileSize = Number(stat.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw invalidWorkbook();

    const tailLength = Math.min(fileSize, MAX_EOCD_BYTES);
    const tail = await readExact(handle, tailLength, fileSize - tailLength);
    const eocdOffset = findEndOfCentralDirectory(tail, fileSize);
    const eocd = await readExact(handle, 22, eocdOffset);
    const disk = eocd.readUInt16LE(4);
    const centralDisk = eocd.readUInt16LE(6);
    const entriesOnDisk = eocd.readUInt16LE(8);
    const entryCount = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);

    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw invalidWorkbook("xlsx ZIP64 and multi-disk archives are not supported");
    }
    if (entryCount > MAX_XLSX_ARCHIVE_MEMBERS) {
      throw processingLimit("xlsx archive has too many members");
    }
    if (centralSize > MAX_XLSX_EXPANDED_BYTES) {
      throw processingLimit("xlsx archive exceeds the processing limit");
    }

    const centralEnd = centralOffset + centralSize;
    if (!Number.isSafeInteger(centralEnd) || centralEnd > eocdOffset || centralEnd > fileSize) {
      throw invalidWorkbook();
    }

    let cursor = centralOffset;
    let expandedBytes = 0;
    for (let memberIndex = 0; memberIndex < entryCount; memberIndex += 1) {
      if (cursor + 46 > centralEnd) throw invalidWorkbook();
      const header = await readExact(handle, 46, cursor);
      if (header.readUInt32LE(0) !== CENTRAL_DIRECTORY_SIGNATURE) throw invalidWorkbook();

      const flags = header.readUInt16LE(8);
      const compressedSize = header.readUInt32LE(20);
      const expandedSize = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const memberDisk = header.readUInt16LE(34);
      const localOffset = header.readUInt32LE(42);
      if (
        compressedSize === 0xffffffff ||
        expandedSize === 0xffffffff ||
        localOffset === 0xffffffff ||
        memberDisk !== 0
      ) {
        throw invalidWorkbook("xlsx ZIP64 and multi-disk archives are not supported");
      }
      if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
        throw invalidWorkbook("encrypted xlsx workbooks are not supported");
      }
      if (expandedSize > MAX_XLSX_MEMBER_BYTES) {
        throw processingLimit("xlsx archive member exceeds the processing limit");
      }
      expandedBytes += expandedSize;
      if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) {
        throw processingLimit("xlsx archive expands beyond the processing limit");
      }

      if (localOffset + 30 > centralOffset) throw invalidWorkbook();
      const localHeader = await readExact(handle, 30, localOffset);
      if (localHeader.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) throw invalidWorkbook();
      if ((localHeader.readUInt16LE(6) & ZIP_ENCRYPTION_FLAGS) !== 0) {
        throw invalidWorkbook("encrypted xlsx workbooks are not supported");
      }

      cursor += 46 + nameLength + extraLength + commentLength;
      if (cursor > centralEnd) throw invalidWorkbook();
    }
  } catch (error) {
    if (error instanceof DataProcessingError) throw error;
    throw invalidWorkbook();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function formulaResult(value: Record<string, unknown>): unknown {
  if ("formula" in value || "sharedFormula" in value) return value.result ?? null;
  return value;
}

function renderCellValue(rawValue: CellValue | unknown): string | null {
  const value =
    rawValue && typeof rawValue === "object" ? formulaResult(rawValue as Record<string, unknown>) : rawValue;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return "";
    return value.toISOString().replace(/\.000Z$/, "");
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.richText)) {
      return object.richText
        .map((part) =>
          part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
            ? ((part as Record<string, unknown>).text as string)
            : ""
        )
        .join("");
    }
    if (typeof object.text === "string" && typeof object.hyperlink === "string") return object.text;
    if (typeof object.error === "string") return object.error;
    if (value !== rawValue) return renderCellValue(value);
  }
  throw invalidWorkbook();
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderedRow(row: Row): string[] {
  const values = new Map<number, string | null>();
  let lastColumn = 0;
  row.eachCell((cell, columnNumber) => {
    if (cell.value !== null && columnNumber > MAX_XLSX_COLUMNS) {
      throw processingLimit("xlsx worksheet has too many columns");
    }
    const value = renderCellValue(cell.value);
    if (value !== null) {
      if (Buffer.byteLength(value, "utf8") > MAX_XLSX_CELL_BYTES) {
        throw processingLimit("xlsx cell exceeds the processing limit");
      }
      values.set(columnNumber, value);
      lastColumn = Math.max(lastColumn, columnNumber);
    }
  });
  return Array.from({ length: lastColumn }, (_, index) => values.get(index + 1) ?? "");
}

function readerInternals(workbook: ExcelJS.stream.xlsx.WorkbookReader): WorkbookReaderInternals {
  return workbook as unknown as WorkbookReaderInternals;
}

function destroyReader(workbook: ExcelJS.stream.xlsx.WorkbookReader): void {
  readerInternals(workbook).stream?.destroy?.();
}

async function readWorkbookMetadata(inputPath: string): Promise<WorkbookMetadata> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, {
    worksheets: "ignore",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "cache",
    entries: "ignore",
  });
  const internals = readerInternals(workbook);
  const placeholderModel: WorkbookReaderInternals["model"] = { sheets: [] };
  const placeholderRelationships: unknown[] = [];
  internals.model = placeholderModel;
  internals.workbookRels = placeholderRelationships;
  // Truthy placeholders make ExcelJS drain early worksheet ZIP entries instead
  // of copying them to its own unbounded temporary files during this pass.
  internals.sharedStrings = [];

  try {
    for await (const ignoredWorksheet of workbook) void ignoredWorksheet;
  } finally {
    destroyReader(workbook);
  }

  if (internals.model === placeholderModel || internals.workbookRels === placeholderRelationships) {
    throw invalidWorkbook();
  }
  const firstWorksheetId = internals.model.sheets?.[0]?.id;
  if (typeof firstWorksheetId !== "number" || !Number.isInteger(firstWorksheetId)) {
    throw invalidWorkbook("xlsx workbook has no worksheets");
  }
  return {
    firstWorksheetId,
    model: internals.model,
    workbookRels: internals.workbookRels,
    sharedStrings: internals.sharedStrings,
    properties: internals.properties,
    styles: internals.styles,
  };
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten < 1) throw invalidWorkbook();
    offset += bytesWritten;
  }
}

class CsvSink {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private outputBytes = 0;

  constructor(private readonly handle: FileHandle) {}

  async writeRow(values: readonly string[]): Promise<void> {
    const fields: string[] = [];
    let rowBytes = 2;
    for (const value of values) {
      const rendered = csvField(value);
      rowBytes += Buffer.byteLength(rendered, "utf8") + (fields.length ? 1 : 0);
      if (this.outputBytes + rowBytes > MAX_XLSX_EXPANDED_BYTES) {
        throw processingLimit("xlsx worksheet expands beyond the processing limit");
      }
      fields.push(rendered);
    }
    const buffer = Buffer.from(`${fields.join(",")}\r\n`, "utf8");
    this.outputBytes += buffer.length;
    if (this.outputBytes > MAX_XLSX_EXPANDED_BYTES) {
      throw processingLimit("xlsx worksheet expands beyond the processing limit");
    }
    if (buffer.length >= CSV_BUFFER_BYTES) {
      await this.flush();
      await writeAll(this.handle, buffer);
      return;
    }
    this.chunks.push(buffer);
    this.bufferedBytes += buffer.length;
    if (this.bufferedBytes >= CSV_BUFFER_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.bufferedBytes) return;
    const buffer = Buffer.concat(this.chunks, this.bufferedBytes);
    this.chunks = [];
    this.bufferedBytes = 0;
    await writeAll(this.handle, buffer);
  }
}

async function convertFirstWorksheet(inputPath: string, output: FileHandle): Promise<void> {
  const metadata = await readWorkbookMetadata(inputPath);
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, {
    worksheets: "emit",
    sharedStrings: "ignore",
    hyperlinks: "ignore",
    styles: "ignore",
    entries: "ignore",
  });
  const internals = readerInternals(workbook);
  internals.model = metadata.model;
  internals.workbookRels = metadata.workbookRels;
  internals.sharedStrings = metadata.sharedStrings;
  internals.properties = metadata.properties;
  internals.styles = metadata.styles;
  const sink = new CsvSink(output);
  let sawFirstWorksheet = false;
  let logicalRows = 0;
  let cellCount = 0;
  try {
    for await (const worksheet of workbook) {
      const worksheetId = (worksheet as unknown as { id?: number }).id;
      if (sawFirstWorksheet || worksheetId !== metadata.firstWorksheetId) continue;
      sawFirstWorksheet = true;
      for await (const row of worksheet) {
        if (!Number.isInteger(row.number) || row.number <= logicalRows || row.number > MAX_XLSX_ROWS) {
          throw processingLimit("xlsx worksheet exceeds the processing limit");
        }
        while (logicalRows + 1 < row.number) {
          logicalRows += 1;
          await sink.writeRow([]);
        }
        const values = renderedRow(row);
        logicalRows = row.number;
        cellCount += values.length;
        if (cellCount > MAX_XLSX_CELLS) {
          throw processingLimit("xlsx worksheet exceeds the processing limit");
        }
        await sink.writeRow(values);
      }
    }
    if (!sawFirstWorksheet) throw invalidWorkbook();
    if (logicalRows === 0) throw invalidWorkbook("xlsx worksheet is empty");
    await sink.flush();
  } finally {
    destroyReader(workbook);
  }
}

/** Convert the first XLSX worksheet to a bounded temporary CSV. */
export async function convertXlsxToCsv(inputPath: string): Promise<ConvertedXlsx> {
  if (path.extname(inputPath).toLowerCase() === ".xls") {
    throw invalidWorkbook("legacy .xls spreadsheets are not supported; use .xlsx");
  }
  await preflightXlsxArchive(inputPath);

  const directory = await mkdtemp(path.join(tmpdir(), "borealis-xlsx-"));
  const outputPath = path.join(directory, "worksheet.csv");
  let output: FileHandle | undefined;
  try {
    output = await open(outputPath, "wx");
    await convertFirstWorksheet(inputPath, output);
    await output.close();
    output = undefined;
    let cleaned = false;
    return {
      path: outputPath,
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await output?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof DataProcessingError) throw error;
    throw invalidWorkbook();
  }
}
