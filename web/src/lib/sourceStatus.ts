/** One canonical label/tone for the source ingestion status enum
 *  (`ready | index | error`), so the Sources page, chat source picker, and
 *  library member list never render the same state four different ways. */
export type SourceStatusTone = "success" | "pending" | "destructive";

export function sourceStatusPresentation(status: string): { label: string; tone: SourceStatusTone } {
  if (status === "ready") return { label: "Ready", tone: "success" };
  if (status === "index") return { label: "Processing", tone: "pending" };
  if (status === "error") return { label: "Needs attention", tone: "destructive" };
  // Unknown future enum values stay visible with their raw value, fail-visible.
  return { label: status, tone: "destructive" };
}
