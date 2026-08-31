# Plan 036: Add bounded local OCR for image-only PDF pages

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: product / ingestion
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

PDF ingestion extracts existing text only. Scanned statements, contracts, and
diligence documents therefore fail with no readable text despite being central
to the intended workspace.

## Target contract

- Existing PDF text extraction runs first. OCR is attempted only for bounded
  pages with no meaningful extracted text; text PDFs are not re-OCRed.
- The shipping macOS desktop uses only the local macOS Vision/PDFKit stack via
  a fixed `/usr/bin/osascript` JXA helper. Browser/server platforms without that
  capability return the existing no-readable-text result with a stable
  `OCR_UNAVAILABLE` detail; no network fallback exists.
- The helper receives one already ownership-validated absolute input path and
  numeric budgets through `execFile`, never a shell. It cannot navigate, read
  other files, or emit binary images.
- Hard limits cover OCR pages, raster pixels, per-page and total duration,
  stdout/stderr bytes, languages, observations, output characters, and overall
  extracted-text/chunk budgets. Timeout kills the exact child process.
- OCR text is marked with page metadata, normalized through the existing text
  path, and sent to embeddings under the same remote-egress consent boundary as
  any other extracted content.

## Scope

- PDF extraction and a testable local OCR adapter/helper asset
- asset-copy/desktop-runtime packaging, config budgets, failures, tests/docs
- no OCR for XLSX/DOCX or arbitrary images in this plan

## Implementation steps

1. Add bounded per-page text-density classification to the PDF extractor while
   retaining the 500-page global PDF ceiling.
2. Implement the JXA Vision helper with fixed imports, page raster bounds,
   accurate recognition, deterministic page order, and bounded JSON output.
3. Wrap it in an abortable Node adapter with platform/capability detection,
   exact executable arguments, output caps, timeout/kill, and safe errors.
4. Merge OCR results only for pages classified empty, then apply the existing
   aggregate extraction and chunk budgets.
5. Package the helper through server data assets and the copied desktop runtime;
   add policy checks preventing accidental network OCR dependencies.
6. Test text PDF bypass, synthetic image-only PDF recognition, mixed pages,
   malformed/huge pages, timeout, abort, excess output, unavailable platform,
   packaging, consent, and no-content logging.

## Verification

- Focused extraction/ingestion tests; a deterministic macOS Vision OCR smoke;
  server build/integration, desktop verify/package smoke, policy, `pnpm verify`.

## Done criteria

- [ ] Image-only PDF fixture becomes searchable/citable locally.
- [ ] Text PDFs retain current output without OCR work.
- [ ] Every resource and child-process limit is enforced at the lowest boundary.
- [ ] Packaged OCR performs no network request and logs no recognized text.

## STOP conditions

- The OS helper cannot be constrained to the exact owned file and budgets.
- Deterministic packaged Vision access requires disabling hardened runtime or
  broadening renderer/filesystem privileges.
- CI cannot distinguish unavailable OCR from an extraction regression.
