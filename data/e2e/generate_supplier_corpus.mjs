#!/usr/bin/env node
/**
 * Deterministic generator for the ten-document supplier corpus consumed by
 * acceptance journey E (research and comparison) in
 * docs/END_TO_END_ACCEPTANCE.md.
 *
 * Outputs (byte-identical run to run; no timestamps, no randomness, pure
 * ASCII/monospace raster): nine text documents (markdown, hand-built text
 * PDFs, one unsupported RTF) and one image-only PDF whose page is a raw
 * DeviceGray raster drawn from a hand-coded 5x7 pixel font. No npm
 * dependencies. PDFs are hand-constructed: catalog -> pages -> page ->
 * content/font/image objects with an exact xref table and no /ID or
 * /CreationDate, so bytes are a pure function of the content below.
 *
 * Image-only PDF recipe (10_acme_scanned_invoice.pdf):
 *   - one /Image XObject, /DeviceGray /BitsPerComponent 8, 240x140 raw
 *     (uncompressed) samples, rendered by `q 240 0 0 140 136 326 cm /Im0 Do Q`;
 *   - the raster is painted from the GLYPHS 5x7 font at scale 2 — the page
 *     therefore has NO text-showing operators (no BT/Tf/Tj), so text
 *     extraction yields nothing while an OCR fallback can see the words;
 *   - visible words are intentionally field-free (no prices/dates) so typed
 *     fields for this document stay "visibly absent, not invented".
 *
 * Field design: five suppliers carry price(number+currency), effective date,
 * renewal(boolean), tier(enum) and exceptions(text). Document 02 is a price
 * CONFLICT for acme-logistics (13500 USD vs 12000 USD); document 04 is
 * MISSING its exceptions field; document 08 (.rtf, unsupported) hides a
 * Delta price of 4600 that text extraction must never surface; document 10 is
 * the image-only PDF.
 *
 * Usage:
 *   node data/e2e/generate_supplier_corpus.mjs            # regenerate in place
 *   node data/e2e/generate_supplier_corpus.mjs --out DIR  # write a copy
 * The committed manifest.json carries sha256/bytes per document; the fixture
 * self-test regenerates to a temp dir and byte-compares for stability.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "supplier-corpus"
);
const outFlag = process.argv.indexOf("--out");
const outDir = outFlag === -1 ? OUTPUT_DIRECTORY : resolve(process.argv[outFlag + 1] ?? OUTPUT_DIRECTORY);

const SUPPLIERS = [
  { id: "acme-logistics", name: "Acme Logistics" },
  { id: "blueriver-analytics", name: "BlueRiver Analytics" },
  { id: "cedarcloud-hosting", name: "CedarCloud Hosting" },
  { id: "delta-paper-co", name: "Delta Paper Co" },
  { id: "everline-legal", name: "Everline Legal" },
];

function fieldLines(supplier, fields) {
  const lines = [`Supplier: ${supplier}`, `Price: ${fields.price.value} ${fields.price.currency}`, `Effective date: ${fields.effective_date}`, `Renewal: ${fields.renewal ? "true" : "false"}`, `Tier: ${fields.tier}`];
  if (fields.exceptions !== null) lines.push(`Exceptions: ${fields.exceptions}`);
  return lines;
}

function markdownDocument(title, supplier, fields, prose) {
  return [`# ${title}`, "", ...fieldLines(supplier, fields), "", ...prose, ""].join("\n");
}

const DOCUMENTS = [
  {
    file: "01_acme_logistics_agreement.md",
    format: "markdown",
    supplier: "acme-logistics",
    notes: [],
    fields: { price: { value: 12000, currency: "USD" }, effective_date: "2026-01-15", renewal: true, tier: "premium", exceptions: "Volume discounts above 500 shipments per quarter are excluded." },
    title: "Acme Logistics master services agreement",
    prose: ["This agreement governs regional freight and last-mile delivery.", "The premium tier includes dedicated dispatch and quarterly reviews."],
  },
  {
    file: "02_acme_renewal_quote.md",
    format: "markdown",
    supplier: "acme-logistics",
    notes: ["conflict_price_vs_01"],
    fields: { price: { value: 13500, currency: "USD" }, effective_date: "2026-07-01", renewal: true, tier: "premium", exceptions: "One-time onboarding fee waived." },
    title: "Acme Logistics renewal quote",
    prose: ["Renewal quote for the period beginning July 2026.", "This quote supersedes the prior rate sheet once countersigned."],
  },
  {
    file: "03_blueriver_msa.pdf",
    format: "pdf-text",
    supplier: "blueriver-analytics",
    notes: [],
    fields: { price: { value: 8750, currency: "USD" }, effective_date: "2025-11-01", renewal: false, tier: "standard", exceptions: "None." },
    title: "BlueRiver Analytics master services agreement",
    prose: ["Term ends automatically; renewal is not automatic.", "Reporting dashboards are refreshed nightly."],
  },
  {
    file: "04_blueriver_change_order.md",
    format: "markdown",
    supplier: "blueriver-analytics",
    notes: ["missing_exceptions_field"],
    fields: { price: { value: 8750, currency: "USD" }, effective_date: "2025-11-01", renewal: false, tier: "standard", exceptions: null },
    title: "BlueRiver Analytics change order 14",
    prose: ["Adds two additional data feeds at the same contracted rate.", "All other terms follow the master services agreement."],
  },
  {
    file: "05_cedarcloud_hosting.pdf",
    format: "pdf-text",
    supplier: "cedarcloud-hosting",
    notes: [],
    fields: { price: { value: 21000, currency: "EUR" }, effective_date: "2026-03-01", renewal: true, tier: "enterprise", exceptions: "EU data-residency add-on is not included." },
    title: "CedarCloud Hosting enterprise agreement",
    prose: ["Hosting capacity is reserved in the requested region.", "Enterprise support responds within four business hours."],
  },
  {
    file: "06_cedarcloud_summary.md",
    format: "markdown",
    supplier: "cedarcloud-hosting",
    notes: [],
    fields: { price: { value: 21000, currency: "EUR" }, effective_date: "2026-03-01", renewal: true, tier: "enterprise", exceptions: "EU data-residency add-on is not included." },
    title: "CedarCloud Hosting account summary",
    prose: ["Summary of the active enterprise agreement for finance.", "Values match the signed hosting agreement."],
  },
  {
    file: "07_delta_paper_terms.pdf",
    format: "pdf-text",
    supplier: "delta-paper-co",
    notes: [],
    fields: { price: { value: 4100, currency: "USD" }, effective_date: "2025-09-01", renewal: true, tier: "standard", exceptions: "Late payments incur a 2 percent surcharge." },
    title: "Delta Paper Co supply terms",
    prose: ["Kraft and recycled stock delivered monthly.", "Standard tier with automatic annual renewal."],
  },
  {
    file: "08_delta_renewal_memo.rtf",
    format: "rtf-unsupported",
    supplier: "delta-paper-co",
    notes: ["unsupported_format", "hidden_price_4600"],
    fields: { price: null, effective_date: null, renewal: null, tier: null, exceptions: null },
    rtf: true,
  },
  {
    file: "09_everline_term_sheet.md",
    format: "markdown",
    supplier: "everline-legal",
    notes: [],
    fields: { price: { value: 15000, currency: "USD" }, effective_date: "2026-02-01", renewal: false, tier: "premium", exceptions: "Hourly overages are billed separately." },
    title: "Everline Legal annual term sheet",
    prose: ["Retainer covers a fixed advisory allowance.", "Engagement ends on the stated effective anniversary."],
  },
  {
    file: "10_acme_scanned_invoice.pdf",
    format: "pdf-image-only",
    supplier: "acme-logistics",
    notes: ["image_only", "no_text_layer"],
    fields: { price: null, effective_date: null, renewal: null, tier: null, exceptions: null },
    imageOnly: true,
  },
];

/* ---------------- deterministic PDF construction (no dependencies) ------- */

const PDF_HEADER = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary");

function escapePdfText(line) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Assemble objects into a minimal PDF with an exact xref and no /ID. */
function buildPdf(objects) {
  const parts = [PDF_HEADER];
  const offsets = [];
  let position = PDF_HEADER.length;
  objects.forEach((body, index) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "ascii");
    offsets.push(position);
    const header = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const footer = Buffer.from("\nendobj\n", "ascii");
    parts.push(header, buffer, footer);
    position += header.length + buffer.length + footer.length;
  });
  const xrefOffset = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  const size = objects.length + 1;
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref + trailer, "ascii"));
  return Buffer.concat(parts);
}

function textPdf(lines) {
  const content = [
    "BT /F1 11 Tf 14 TL 56 760 Td",
    ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
    "ET",
  ].join("\n");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}

/** 5x7 pixel font (rows top to bottom, '#' = ink). */
const GLYPHS = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "####.", "....."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
};

const IMAGE_WIDTH = 240;
const IMAGE_HEIGHT = 140;
const PIXEL_SCALE = 2;
const INK = 16;
const PAPER = 255;

function paintRaster() {
  const pixels = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT).fill(PAPER);
  const set = (x, y) => {
    if (x >= 0 && x < IMAGE_WIDTH && y >= 0 && y < IMAGE_HEIGHT) pixels[y * IMAGE_WIDTH + x] = INK;
  };
  const drawText = (text, left, top) => {
    let pen = left;
    for (const character of text.toUpperCase()) {
      const glyph = GLYPHS[character] ?? GLYPHS[" "];
      for (let row = 0; row < 7; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          if (glyph[row][col] !== "#") continue;
          for (let dy = 0; dy < PIXEL_SCALE; dy += 1) {
            for (let dx = 0; dx < PIXEL_SCALE; dx += 1) {
              set(pen + col * PIXEL_SCALE + dx, top + row * PIXEL_SCALE + dy);
            }
          }
        }
      }
      pen += 6 * PIXEL_SCALE;
    }
  };
  const rule = (y) => {
    for (let x = 12; x < IMAGE_WIDTH - 12; x += 1) set(x, y);
  };
  rule(8);
  drawText("ACME LOGISTICS", 14, 18);
  drawText("SCANNED INVOICE", 14, 42);
  drawText("IMAGE ONLY SCAN", 14, 66);
  drawText("NO TEXT LAYER", 14, 90);
  rule(128);
  return Buffer.from(pixels);
}

function imageOnlyPdf() {
  const raster = paintRaster();
  const content = "q 240 0 0 140 136 326 cm /Im0 Do Q";
  const imageObject = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${raster.length} >>\nstream\n`,
      "ascii"
    ),
    raster,
    Buffer.from("\nendstream", "ascii"),
  ]);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    imageObject,
  ]);
}

function rtfDocument() {
  return [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Courier;}}",
    "\\pard\\partldelta paper co renewal memo\\par",
    "supplier: delta paper co\\par",
    "price: 4600 usd\\par",
    "effective date: 2027-01-01\\par",
    "renewal: true\\par",
    "tier: standard\\par",
    "exceptions: none\\par}",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------- outputs --- */

function renderDocument(document) {
  const supplier = SUPPLIERS.find((entry) => entry.id === document.supplier);
  if (document.imageOnly) return { bytes: imageOnlyPdf() };
  if (document.rtf) return { bytes: Buffer.from(rtfDocument(), "ascii") };
  const fieldPart = fieldLines(supplier.name, document.fields);
  if (document.format === "markdown") {
    return { bytes: Buffer.from(markdownDocument(document.title, supplier.name, document.fields, document.prose), "utf8") };
  }
  const lines = [document.title.toUpperCase(), "", ...fieldPart.map((line) => line.toUpperCase()), "", ...document.prose.map((line) => line.toUpperCase()), ""];
  return { bytes: textPdf(lines) };
}

await mkdir(outDir, { recursive: true });
const manifest = {
  version: 1,
  generator: "data/e2e/generate_supplier_corpus.mjs",
  command: "node data/e2e/generate_supplier_corpus.mjs",
  suppliers: SUPPLIERS,
  typed_fields: ["price", "effective_date", "renewal", "tier", "exceptions"],
  documents: [],
  facts: {
    conflicts: [
      {
        supplier: "acme-logistics",
        field: "price",
        values: [12000, 13500],
        currency: "USD",
        documents: ["01_acme_logistics_agreement.md", "02_acme_renewal_quote.md"],
        resolution: "open: the renewal quote supersedes only after countersignature",
      },
    ],
    missing_fields: [{ document: "04_blueriver_change_order.md", field: "exceptions" }],
    image_only: ["10_acme_scanned_invoice.pdf"],
    unsupported: [
      {
        document: "08_delta_renewal_memo.rtf",
        note: "unsupported ingestion format: extraction must yield no typed values",
        hidden_values: { price: { value: 4600, currency: "USD" }, effective_date: "2027-01-01", renewal: true, tier: "standard" },
      },
    ],
  },
};

for (const document of DOCUMENTS) {
  const { bytes } = renderDocument(document);
  await writeFile(join(outDir, document.file), bytes);
  manifest.documents.push({
    file: document.file,
    format: document.format,
    supplier: document.supplier,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fields: document.fields,
    notes: document.notes,
  });
}
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const committed = await readFile(join(outDir, "manifest.json")).then((value) => value.length);
process.stdout.write(`supplier corpus: ${manifest.documents.length} documents written to ${outDir} (${committed} bytes manifest)\n`);
