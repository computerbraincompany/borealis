import type { ChatRunTerminalStatus } from "@/lib/api";

export type CancelRunStatus = "cancelling" | ChatRunTerminalStatus;

export interface CancelRunOptions {
  chatId: string;
  runId: string | null;
  controller?: AbortController | null;
  cancel: (chatId: string, runId: string) => Promise<unknown>;
  isCurrent: () => boolean;
  onCancelled?: (status: "cancelling" | "cancelled") => void;
}

/** Ask the server to cancel durable work before disconnecting its SSE consumer. */
export async function cancelRunThenAbort({
  chatId,
  runId,
  controller,
  cancel,
  isCurrent,
  onCancelled,
}: CancelRunOptions): Promise<"awaiting-run-id" | CancelRunStatus> {
  // The POST may be accepted before its first `run-started` frame reaches us.
  // Disconnecting at that point would orphan server work because there is no
  // durable run id to cancel yet. Keep the stream connected until the id arrives.
  if (!runId) return "awaiting-run-id";
  const response = await cancel(chatId, runId);
  const status = readCancelStatus(response);
  if (status === "completed" || status === "failed") return status;
  onCancelled?.(status);
  if (controller && isCurrent()) controller.abort();
  return status;
}

function readCancelStatus(value: unknown): CancelRunStatus {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const status = (value as Record<string, unknown>).status;
    if (status === "cancelling" || status === "cancelled" || status === "completed" || status === "failed") {
      return status;
    }
  }
  // Compatibility for an older successful cancellation acknowledgement.
  return "cancelling";
}
