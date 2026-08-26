export type IngestionFailureCode =
  | "NO_READABLE_TEXT"
  | "UNSUPPORTED_FORMAT"
  | "DATASET_PARSE_FAILED"
  | "DATA_SERVICE_UNAVAILABLE"
  | "EMBEDDING_UNAVAILABLE"
  | "EMBEDDING_INVALID_RESPONSE"
  | "SOURCE_UNAVAILABLE"
  | "INGEST_FAILED";

export interface PublicIngestionFailure {
  code: IngestionFailureCode;
  summary: string;
  detail: string;
  stage: "reading" | "parsing" | "embedding" | "storage";
}

const FAILURES: Record<IngestionFailureCode, Omit<PublicIngestionFailure, "code">> = {
  NO_READABLE_TEXT: {
    summary: "No readable content was found.",
    detail: "The file did not contain extractable text or table rows.",
    stage: "reading",
  },
  UNSUPPORTED_FORMAT: {
    summary: "This file format is not supported.",
    detail: "Convert the file to one of the supported upload formats, then upload it again.",
    stage: "reading",
  },
  DATASET_PARSE_FAILED: {
    summary: "The tabular file could not be parsed.",
    detail: "Check that the file is a valid CSV, TSV, spreadsheet, Parquet, JSON, or JSONL dataset.",
    stage: "parsing",
  },
  DATA_SERVICE_UNAVAILABLE: {
    summary: "The data service was unavailable.",
    detail: "Borealis could not complete local data processing. Retry; if the problem continues, restart Borealis.",
    stage: "parsing",
  },
  EMBEDDING_UNAVAILABLE: {
    summary: "The embedding service was unavailable.",
    detail:
      "Borealis read the file but could not reach the configured embedding model. Start the model service, then retry.",
    stage: "embedding",
  },
  EMBEDDING_INVALID_RESPONSE: {
    summary: "The embedding model returned an invalid response.",
    detail: "Check that the configured embedding model and vector dimension match this Borealis instance, then retry.",
    stage: "embedding",
  },
  SOURCE_UNAVAILABLE: {
    summary: "The uploaded file is unavailable.",
    detail: "Borealis can no longer access the stored file for this source. Upload the file again.",
    stage: "storage",
  },
  INGEST_FAILED: {
    summary: "Source processing failed.",
    detail: "Borealis could not finish preparing this source. Retry; if the problem continues, restart Borealis.",
    stage: "storage",
  },
};

export class IngestionStageError extends Error {
  constructor(readonly failureCode: IngestionFailureCode) {
    super(failureCode);
    this.name = "IngestionStageError";
  }
}

export function publicIngestionFailure(code: unknown): PublicIngestionFailure {
  const normalized = typeof code === "string" && code in FAILURES ? (code as IngestionFailureCode) : "INGEST_FAILED";
  return { code: normalized, ...FAILURES[normalized] };
}
