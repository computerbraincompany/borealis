/**
 * Opaque data-service failure crossing the worker RPC boundary. Ingest retry
 * and public error classification depend on the stable code and status.
 */
export class DataServiceError extends Error {
  readonly code = "DATA_SERVICE_ERROR";

  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super("The data service could not complete the operation");
    this.name = "DataServiceError";
  }
}

/** A deliberately safe, worker-internal error that may cross the RPC boundary. */
export class DatasetOperationError extends Error {
  constructor(
    readonly status: number,
    readonly safeDetail: string
  ) {
    super(safeDetail);
    this.name = "DatasetOperationError";
  }
}

export interface SerializedDatasetError {
  status: number;
}

export function serializeDatasetError(error: unknown): SerializedDatasetError {
  return { status: error instanceof DatasetOperationError ? error.status : 500 };
}
