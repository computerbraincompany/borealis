export const MAX_RENDER_HTML_BYTES = 16 * 1024 * 1024;
export const MAX_BOOTSTRAP_TOKEN_BYTES = 16 * 1024;

export interface BootstrapUser {
  readonly id: string;
  readonly email: string;
}

export interface BootstrapSession {
  readonly token: string;
  readonly user: BootstrapUser;
}

export interface BackendReadyMessage {
  readonly type: "ready";
  readonly port: number;
  readonly bootstrap: BootstrapSession;
}

export interface BackendRenderRequest {
  readonly type: "render-request";
  readonly request_id: string;
  readonly kind: "png" | "pdf";
  readonly html: string;
}

export interface BackendStoppedMessage {
  readonly type: "stopped";
}

export interface BackendFatalMessage {
  readonly type: "fatal";
  readonly error_code?: string;
}

export type BackendMessage =
  | BackendReadyMessage
  | BackendRenderRequest
  | BackendStoppedMessage
  | BackendFatalMessage;

export interface ShutdownMessage {
  readonly type: "shutdown";
}

export interface RenderSuccessMessage {
  readonly type: "render-response";
  readonly request_id: string;
  readonly ok: true;
  readonly data: Uint8Array;
}

export interface RenderFailureMessage {
  readonly type: "render-response";
  readonly request_id: string;
  readonly ok: false;
}

export type MainMessage =
  ShutdownMessage | RenderSuccessMessage | RenderFailureMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function rejectedRenderRequestId(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    value.type !== "render-request" ||
    !isRequestId(value.request_id)
  ) {
    return undefined;
  }
  return parseBackendMessage(value) ? undefined : value.request_id;
}

function parseBootstrap(value: unknown): BootstrapSession | undefined {
  if (
    !isRecord(value) ||
    !isBoundedString(value.token, MAX_BOOTSTRAP_TOKEN_BYTES) ||
    !isRecord(value.user)
  ) {
    return undefined;
  }
  if (
    !isBoundedString(value.user.id, 256) ||
    !isBoundedString(value.user.email, 320)
  )
    return undefined;
  return {
    token: value.token,
    user: { id: value.user.id, email: value.user.email },
  };
}

export function parseBackendMessage(
  value: unknown,
): BackendMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "ready": {
      const bootstrap = parseBootstrap(value.bootstrap);
      if (
        !Number.isInteger(value.port) ||
        Number(value.port) < 1 ||
        Number(value.port) > 65_535 ||
        !bootstrap
      ) {
        return undefined;
      }
      return { type: "ready", port: Number(value.port), bootstrap };
    }
    case "render-request":
      if (
        !isRequestId(value.request_id) ||
        (value.kind !== "png" && value.kind !== "pdf") ||
        !isBoundedString(value.html, MAX_RENDER_HTML_BYTES)
      ) {
        return undefined;
      }
      return {
        type: "render-request",
        request_id: value.request_id,
        kind: value.kind,
        html: value.html,
      };
    case "stopped":
      return { type: "stopped" };
    case "fatal":
      return {
        type: "fatal",
        ...(typeof value.error_code === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(value.error_code)
          ? { error_code: value.error_code }
          : {}),
      };
    default:
      return undefined;
  }
}

export function asTransferableBytes(value: Buffer): Uint8Array {
  return Uint8Array.from(value);
}
