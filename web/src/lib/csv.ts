import type { QueryResultCell } from "@/lib/api";

const UTF8_BOM = "\uFEFF";
const FORMULA_PREFIX = /^\s*[=+\-@]/u;

function serializeField(value: QueryResultCell): string {
  let text: string;
  if (value === null) {
    text = "null";
  } else if (typeof value === "string") {
    text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  } else {
    text = String(value);
  }

  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Serialize the exact stored preview using deterministic spreadsheet-safe CSV. */
export function serializeCsv(columns: readonly string[], rows: readonly (readonly QueryResultCell[])[]): string {
  const records: readonly (readonly QueryResultCell[])[] = [columns, ...rows];
  return `${UTF8_BOM}${records.map((record) => record.map(serializeField).join(",")).join("\r\n")}\r\n`;
}

export function safeCsvFilename(filename: string): string {
  const stem = filename
    .replace(/\.csv$/iu, "")
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 80);
  return `${stem || "borealis-query"}.csv`;
}

/** Trigger one local download without querying the server or retaining a Blob URL. */
export function downloadCsv(
  columns: readonly string[],
  rows: readonly (readonly QueryResultCell[])[],
  filename: string,
): void {
  const blob = new Blob([serializeCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = safeCsvFilename(filename);
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
