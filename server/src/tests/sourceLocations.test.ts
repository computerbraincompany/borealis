import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  chunkText,
  datasetPreviewSegments,
  datasetPreviewText,
  extractDocument,
  extractPdfDocument,
} from "../ingestSupport.js";
import type { PdfOcrPage } from "../localPdfOcr.js";
import {
  MAX_CHUNK_LOCATORS_PER_CHUNK,
  chunkTextWithLocators,
  locatorsForRange,
  mapSegmentsToNormalized,
  parseChunkLocators,
  type ExtractedSegment,
  type PdfPageLocator,
  type TabularRowsLocator,
  type TextSpanLocator,
} from "../sourceLocations.js";

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const corpusDirectory = path.join(REPO_ROOT, "data/e2e/supplier-corpus");

function pdfStream(dictionary: string, contents: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, "ascii"),
    contents,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

function assemblePdf(objects: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary")];
  const offsets = [0];
  let length = chunks[0]!.length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const suffix = Buffer.from("\nendobj\n", "ascii");
    chunks.push(prefix, objects[index]!, suffix);
    length += prefix.length + objects[index]!.length + suffix.length;
  }
  const xrefOffset = length;
  chunks.push(
    Buffer.from(
      [
        `xref\n0 ${objects.length + 1}\n`,
        "0000000000 65535 f \n",
        ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ].join(""),
      "ascii"
    )
  );
  return Buffer.concat(chunks);
}

/**
 * Two-page fixture: page 1 carries two text lines, page 2 is an intentionally
 * empty content stream so the OCR pass claims it with a deterministic stamp.
 */
function buildMixedTextAndBlankPdf(): Buffer {
  const pageOne = Buffer.from(
    "BT /F1 12 Tf 72 720 Td (ALPHA PAGE ONE SENTINEL line) Tj 0 -24 Td (second page-one row) Tj ET",
    "ascii"
  );
  const pageTwo = Buffer.from("q Q", "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "ascii"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
      "ascii"
    ),
    pdfStream(`<< /Length ${pageOne.length} >>`, pageOne),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>", "ascii"),
    pdfStream(`<< /Length ${pageTwo.length} >>`, pageTwo),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "ascii"),
  ];
  return assemblePdf(objects);
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

describe("chunker compatibility", () => {
  it("produces byte-identical chunk contents for text, Markdown, PDF, and tabular extractions", async () => {
    const inputs: Array<{ text: string; segments: readonly ExtractedSegment[]; separator: string }> = [];
    for (const entry of await fs.readdir(corpusDirectory)) {
      if (!/\.(md|pdf)$/.test(entry)) continue;
      const filePath = path.join(corpusDirectory, entry);
      if (entry.endsWith(".pdf")) {
        if (entry === "10_acme_scanned_invoice.pdf") continue; // raster-only: no text to chunk
        inputs.push(await extractPdfDocument(filePath, await fs.readFile(filePath), async () => []));
      } else {
        inputs.push(await extractDocument(filePath, "text/markdown"));
      }
    }
    inputs.push(
      datasetPreviewSegments(
        {
          columns: ["month", "amount"],
          rows: [
            ["jan", "10"],
            ["feb", "20"],
          ],
          total_row_count: 2,
          truncated: true,
        },
        "ledger"
      )
    );
    inputs.push({
      text: "  leading\n\n\t\ttabs\r\n\n  unicode  no-break  end  ",
      segments: [{ text: "  leading\n\n\t\ttabs\r\n\n  unicode  no-break  end  ", anchor: { kind: "text_span" } }],
      separator: "",
    });
    for (const extraction of inputs) {
      const plain = chunkText(extraction.text, 800, 110);
      const located = chunkTextWithLocators(
        extraction.text,
        extraction.segments.length ? extraction.segments : null,
        extraction.separator,
        800,
        110
      );
      expect(located.map((chunk) => chunk.content)).toEqual(plain);
    }
  });

  it("keeps the tabular preview text byte-identical through the segment helper", () => {
    const preview = {
      columns: ["a", "b"],
      rows: [["1", "2"], [null, "x"], ["y"]],
      total_row_count: 7,
      truncated: true,
    };
    expect(datasetPreviewSegments(preview, "ledger").text).toBe(datasetPreviewText(preview));
    expect(datasetPreviewSegments({}).text).toBe(datasetPreviewText({}));
  });

  it("maps segment ranges onto exactly the normalized text the chunker slices", () => {
    const text = "  first   page\n\n second\n\n \t ";
    const segments: ExtractedSegment[] = [
      { text: "  first   page", anchor: { kind: "pdf_page", page: 1, ocr: false } },
      { text: " second\n\n \t ", anchor: { kind: "pdf_page", page: 2, ocr: false } },
    ];
    const mapping = mapSegmentsToNormalized(text, segments, "\n\n");
    expect(mapping).not.toBeNull();
    expect(mapping!.clean).toBe(normalize(text));
    expect(mapping!.ranges).toHaveLength(2);
    const [first, second] = mapping!.ranges;
    expect(mapping!.clean.slice(first!.start, first!.end)).toBe("first page");
    expect(mapping!.clean.slice(second!.start, second!.end)).toBe("second");
  });

  it("refuses to map when segments cannot reconstruct the text", () => {
    expect(mapSegmentsToNormalized("abc", [{ text: "ab", anchor: { kind: "text_span" } }], "")).toBeNull();
    expect(
      chunkTextWithLocators("abc", [{ text: "ab", anchor: { kind: "text_span" } }], "").every(
        (chunk) => !chunk.locators.length
      )
    ).toBe(true);
  });
});

describe("PDF page locators", () => {
  it("reports the real 1-based page and the within-page offset for corpus text PDFs", async () => {
    for (const entry of ["03_blueriver_msa.pdf", "05_cedarcloud_hosting.pdf", "07_delta_paper_terms.pdf"]) {
      const filePath = path.join(corpusDirectory, entry);
      const extraction = await extractPdfDocument(filePath, await fs.readFile(filePath), async () => []);
      const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 800, 110);
      expect(chunks.length).toBeGreaterThan(0);
      const locator = chunks[0]!.locators[0];
      expect(locator).toMatchObject({ kind: "pdf_page", page: 1, ocr: false, char_start: 0 });
      const page = extraction.segments[0]!;
      expect((locator as PdfPageLocator).char_len).toBe(normalize(page.text).length);
    }
  });

  it("pins within-page offsets for a phrase deep in a later page of a multi-page PDF", async () => {
    const extraction = await extractPdfDocument(
      "mixed.pdf",
      buildMixedTextAndBlankPdf(),
      async (): Promise<readonly PdfOcrPage[]> => [{ page: 2, text: "OCR STAMP SENTINEL token" }]
    );
    expect(extraction.segments.map((segment) => segment.anchor)).toEqual([
      { kind: "pdf_page", page: 1, ocr: false },
      { kind: "pdf_page", page: 2, ocr: true },
    ]);
    const pageOneText = extraction.segments[0]!.text;
    expect(pageOneText).toContain("ALPHA PAGE ONE SENTINEL line");
    expect(extraction.segments[1]!.text.startsWith("[Page 2 — OCR]\n")).toBe(true);

    const mapping = mapSegmentsToNormalized(extraction.text, extraction.segments, extraction.separator)!;
    const clean = mapping.clean;
    expect(mapping.ranges).toHaveLength(2);
    const [pageOneRange, pageTwoRange] = mapping.ranges;
    // The normalized page-two text keeps the `[Page 2 — OCR]` prefix, and the
    // phrase offset within that normalized page text is the clean offset
    // minus the page's own normalized start.
    const normalizedPageTwo = normalize(extraction.segments[1]!.text);
    const phraseInPage = normalizedPageTwo.indexOf("OCR STAMP SENTINEL");
    expect(phraseInPage).toBeGreaterThan(0);
    expect(clean.indexOf("OCR STAMP SENTINEL") - pageTwoRange!.start).toBe(phraseInPage);

    const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 800, 110);
    const stampedEntry = chunks
      .map((chunk, index) => ({ chunk, start: index * (800 - 110) }))
      .find((entry) => entry.chunk.content.includes("OCR STAMP SENTINEL"))!;
    const stamped = stampedEntry.chunk.locators.filter(
      (locator): locator is PdfPageLocator => locator.kind === "pdf_page" && locator.page === 2
    );
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.ocr).toBe(true);
    expect(stamped[0]!.char_start).toBe(Math.max(0, stampedEntry.start - pageTwoRange!.start));
    expect(stamped[0]!.char_len).toBe(
      Math.min(pageTwoRange!.end, stampedEntry.start + stampedEntry.chunk.content.length) -
        Math.max(pageTwoRange!.start, stampedEntry.start)
    );

    // A page-one phrase resolves to page 1 with its page-relative offset.
    const normalizedPageOne = normalize(pageOneText);
    expect(clean.indexOf("SENTINEL line") - pageOneRange!.start).toBe(normalizedPageOne.indexOf("SENTINEL line"));
  });

  it("labels the OCR of the committed raster-only invoice fixture with its real page", async () => {
    const filePath = path.join(corpusDirectory, "10_acme_scanned_invoice.pdf");
    const extraction = await extractPdfDocument(filePath, await fs.readFile(filePath), async (file, pages) => {
      expect(pages).toEqual([1]);
      return [{ page: 1, text: `SCANNED INVOICE OCR MARKER ${path.basename(file)}` }];
    });
    expect(extraction.segments).toHaveLength(1);
    expect(extraction.segments[0]!.anchor).toEqual({ kind: "pdf_page", page: 1, ocr: true });
    const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 800, 110);
    const locator = chunks[0]!.locators[0] as PdfPageLocator;
    expect(locator).toMatchObject({ kind: "pdf_page", page: 1, ocr: true, char_start: 0 });
    expect(chunks[0]!.content).toContain("SCANNED INVOICE OCR MARKER");
  });
});

describe("text and Markdown locators", () => {
  it("attaches the heading and the document offset for Markdown spans", async () => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(process.env.TMPDIR ?? "/tmp"), "borealis-md-"));
    try {
      const filePath = path.join(directory, "notes.md");
      const text = "# Alpha\n\nalpha body sentence.\n\n# Beta\n\nbeta body sentence with the marker phrase.\n";
      await fs.writeFile(filePath, text);
      const extraction = await extractDocument(filePath, "text/markdown");
      expect(extraction.segments.map((segment) => (segment.anchor as { heading?: string }).heading)).toEqual([
        "Alpha",
        "Beta",
      ]);
      const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 800, 110);
      expect(chunks).toHaveLength(1);
      const locators = chunks[0]!.locators as TextSpanLocator[];
      expect(locators.map((locator) => locator.heading)).toEqual(["Alpha", "Beta"]);
      const clean = normalize(text);
      const beta = locators.find((locator) => locator.heading === "Beta")!;
      // The span begins at its own heading line; the heading text is the
      // label, and the recorded span is the segment's normalized content.
      expect(clean.slice(beta.char_start, beta.char_start + beta.char_len)).toBe(
        normalize(extraction.segments[1]!.text)
      );
      expect(clean.slice(beta.char_start, beta.char_start + "# Beta".length)).toBe("# Beta");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("records heading-less text spans for plain text and DOCX-style single segments", async () => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(process.env.TMPDIR ?? "/tmp"), "borealis-txt-"));
    try {
      const filePath = path.join(directory, "plain.txt");
      const text = "line one\nline two\n";
      await fs.writeFile(filePath, text);
      const extraction = await extractDocument(filePath, "text/plain");
      expect(extraction.segments).toHaveLength(1);
      expect(extraction.segments[0]!.anchor).toEqual({ kind: "text_span" });
      const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 6, 0);
      const first = chunks[0]!.locators[0] as TextSpanLocator;
      expect(first.char_start).toBe(0);
      expect(first.heading).toBeUndefined();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("tabular row-range locators", () => {
  it("names the sheet and merges the known row range covered by a chunk", () => {
    const preview = {
      columns: ["month", "amount"],
      rows: [
        ["jan", "10"],
        ["feb", "20"],
        ["mar", "30"],
      ],
      total_row_count: 3,
    };
    const extraction = datasetPreviewSegments(preview, "ledger");
    const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 900, 110);
    const locators = chunks[0]!.locators as TabularRowsLocator[];
    expect(locators).toEqual([
      { kind: "tabular_rows", sheet: "ledger" },
      { kind: "tabular_rows", sheet: "ledger", row_start: 1, row_end: 3 },
    ]);
  });

  it("bounds a chunk to exactly the rows its slice covers", () => {
    const preview = {
      columns: ["v"],
      rows: [["row-one"], ["row-two"], ["row-three"]],
      total_row_count: 3,
    };
    const extraction = datasetPreviewSegments(preview, "rowsheet");
    // The normalized text is `Columns: v Rows: 3 row-one row-two row-three`.
    // A zero-overlap window starting at 27 begins exactly at data row 2.
    const chunks = chunkTextWithLocators(extraction.text, extraction.segments, extraction.separator, 27, 0);
    const window = chunks.find((chunk) => chunk.content === "row-two row-three");
    expect(window).toBeDefined();
    const rows = window!.locators.filter(
      (locator): locator is TabularRowsLocator => locator.kind === "tabular_rows" && locator.row_start !== undefined
    );
    expect(rows).toEqual([{ kind: "tabular_rows", sheet: "rowsheet", row_start: 2, row_end: 3 }]);
  });

  it("never asserts a row range for the sheet-level header anchor", () => {
    const preview = { columns: ["v"], rows: [["a"], ["b"]], total_row_count: 2 };
    const extraction = datasetPreviewSegments(preview, "sheet");
    const locators = locatorsForRange(
      mapSegmentsToNormalized(extraction.text, extraction.segments, extraction.separator)!.ranges,
      0,
      "Columns: v\nRows: 2".length
    );
    expect(locators).toEqual([{ kind: "tabular_rows", sheet: "sheet" }]);
  });
});

describe("honest absence and caps", () => {
  it("keeps legacy chunks and garbage meta in the honest location-unavailable state", () => {
    expect(parseChunkLocators({})).toEqual([]);
    expect(parseChunkLocators({ loc: [] })).toEqual([]);
    expect(parseChunkLocators({ loc: "not-an-array" })).toEqual([]);
    expect(parseChunkLocators({ loc: [null, 3, { kind: "moon" }, { kind: "pdf_page", page: 0 }] })).toEqual([]);
    expect(
      parseChunkLocators({
        loc: [
          { kind: "pdf_page", page: 2, ocr: true, char_start: 4, char_len: 9, heading: "ignored" },
          { kind: "text_span", char_start: "x" },
          { kind: "tabular_rows" },
          { kind: "tabular_rows", sheet: "s", row_start: 2, row_end: 5 },
        ],
      })
    ).toEqual([
      { kind: "pdf_page", page: 2, ocr: true, char_start: 4, char_len: 9 },
      { kind: "tabular_rows", sheet: "s", row_start: 2, row_end: 5 },
    ]);
    expect(chunkTextWithLocators("some text", null, "", 800, 110).every((chunk) => chunk.locators.length === 0)).toBe(
      true
    );
  });

  it("caps a chunk's locator list at the documented bound, always keeping the first", () => {
    const text = Array.from({ length: 40 }, (_, index) => `# H${index}\nbody${index}\n`).join("\n");
    const extraction = { text, segments: [] as ExtractedSegment[], separator: "" };
    // Segment split via the markdown-aware chunking path.
    const segments: ExtractedSegment[] = [];
    for (const line of text.split(/(?=# )/)) {
      const heading = line.match(/^# (H\d+)/)![1];
      segments.push({ text: line, anchor: { kind: "text_span", heading } });
    }
    const chunks = chunkTextWithLocators(extraction.text, segments, "", extraction.text.length, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.locators.length).toBe(MAX_CHUNK_LOCATORS_PER_CHUNK);
    expect(chunks[0]!.locators[0]).toMatchObject({ heading: "H0" });
  });
});
