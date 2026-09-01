export const MAX_TOOL_CALL_ID_CHARS = 256;

export function isValidToolCallId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_TOOL_CALL_ID_CHARS;
}
