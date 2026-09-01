# Plan 036: Add bounded local OCR for image-only PDF pages

## Status

- **State**: DONE (2026-09-01)
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

- [x] Image-only PDF fixture becomes searchable/citable locally.
- [x] Text PDFs retain current output without OCR work.
- [x] Every resource and child-process limit is enforced at the lowest boundary.
- [x] Packaged OCR performs no network request and logs no recognized text.

## Completion record

- PDF extraction remains text-first and uses bounded page dimensions, text
  geometry, interior glyph counts, word counts, and normalized density so a
  sparse footer, watermark, or broken overlay cannot suppress OCR for the
  imaged page beneath. Only pages classified sparse are sent to the fixed local
  `/usr/bin/osascript` PDFKit/Vision helper packaged as a data asset.
- OCR adapter/extraction/failure/policy tests cover bypass, mixed/image-only
  pages, sparse overlays, unavailable platforms, unsafe files,
  malformed/excess output, timeout, abort, and budgets. The packaged utility
  smoke generates a one-page grayscale-image PDF with no font resource or PDF
  text-showing operator, classifies it through the production text-first PDF
  extractor, and invokes the physically unpacked JXA helper through real macOS
  PDFKit/Vision recognition.
- A committed macOS composition regression uses that same raster-only fixture
  and the production OCR helper, then carries the recognized page text through
  the durable ingestion worker, SQLite/Lance promotion, scoped retrieval,
  sanitized evidence, and citation metadata. Non-macOS CI injects the stable
  recognition result at only the OS capability boundary while exercising the
  identical downstream path.
- Before any extracted or OCR text reaches embeddings, each durable ingestion
  job creates an account-authorized embedding session from one immutable
  provider snapshot. A queued local job resumed under an unacknowledged remote
  provider performs no transport call and ends with the stable
  `REMOTE_EGRESS_CONSENT_REQUIRED` failure; every batch in an authorized job
  remains bound to the checked snapshot.

## STOP conditions

- The OS helper cannot be constrained to the exact owned file and budgets.
- Deterministic packaged Vision access requires disabling hardened runtime or
  broadening renderer/filesystem privileges.
- CI cannot distinguish unavailable OCR from an extraction regression.
