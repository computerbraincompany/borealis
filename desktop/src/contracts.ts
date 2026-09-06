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

export interface BackendNativeSmokeMessage {
  readonly type: "native-smoke";
  readonly ok: true;
}

export interface BackendFatalMessage {
  readonly type: "fatal";
  readonly error_code?: string;
}

export type BackendMessage =
  | BackendReadyMessage
  | BackendRenderRequest
  | BackendStoppedMessage
  | BackendNativeSmokeMessage
  | BackendFatalMessage;

export interface ShutdownMessage {
  readonly type: "shutdown";
}

/**
 * Narrow M14 addition to the main→backend protocol: the native folder
 * chooser's opaque grant handoff. The backend grant registry
 * (`server/src/knowledge/grants.ts`) validates the same four-key shape on
 * arrival; the renderer never sees `root_path` (it receives only the opaque
 * `grant_id`, a label, and bounded preview metadata).
 */
export interface FolderGrantMessage {
  readonly type: "folder-grant";
  readonly grant_id: string;
  readonly root_path: string;
  readonly display_label: string;
}

export const MAX_FOLDER_GRANT_ID_BYTES = 64;
export const MAX_FOLDER_ROOT_PATH_BYTES = 4_096;
export const MAX_FOLDER_LABEL_CHARS = 120;
export const MAX_FOLDER_PREVIEW_ENTRIES = 500;

export type FolderPickerResult =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly grant_id: string;
      readonly label: string;
      readonly preview: {
        readonly entry_count: number;
        readonly truncated: boolean;
      };
    };

export const FOLDER_PICKER_CANCELLED: FolderPickerResult = Object.freeze({
  cancelled: true,
});

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
  | ShutdownMessage
  | RenderSuccessMessage
  | RenderFailureMessage
  | FolderGrantMessage;

/**
 * Build the one-time folder-grant handoff. Every field is contract-checked
 * here (fail-closed): a grant that cannot be expressed within the bounded
 * shapes throws, and main then cancels instead of half-forwarding. The
 * `root_path` must already be the canonical realpath resolved by main.
 */
export function buildFolderGrantMessage(input: {
  readonly grantId: string;
  readonly rootPath: string;
  readonly label: string;
}): FolderGrantMessage {
  const { grantId, rootPath, label } = input;
  if (
    typeof grantId === "string" &&
    /^[0-9a-f]{64}$/.test(grantId) &&
    Buffer.byteLength(grantId, "utf8") <= MAX_FOLDER_GRANT_ID_BYTES &&
    typeof rootPath === "string" &&
    rootPath.length > 1 &&
    rootPath.startsWith("/") &&
    Buffer.byteLength(rootPath, "utf8") <= MAX_FOLDER_ROOT_PATH_BYTES &&
    !rootPath.includes("\0") &&
    !/[\r\n]/.test(rootPath) &&
    typeof label === "string" &&
    label.length >= 1 &&
    Array.from(label).length <= MAX_FOLDER_LABEL_CHARS &&
    !label.includes("\0") &&
    !/[\r\n]/.test(label)
  ) {
    return Object.freeze({
      type: "folder-grant",
      grant_id: grantId,
      root_path: rootPath,
      display_label: label,
    });
  }
  throw new Error("folder grant handoff is invalid");
}

/**
 * Narrow a `dialog.showOpenDialog` selection plus a bounded top-level entry
 * count into the only shape the renderer may receive. The resolved path is
 * deliberately not part of the result; only the opaque grant, label, and
 * capped metadata cross the bridge.
 */
export function narrowFolderPickerResult(input: {
  readonly grantId: unknown;
  readonly label: unknown;
  readonly entries: unknown;
  readonly truncated: unknown;
}): FolderPickerResult {
  if (
    typeof input.grantId !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.grantId)
  )
    return FOLDER_PICKER_CANCELLED;
  if (
    typeof input.label !== "string" ||
    input.label.length < 1 ||
    Array.from(input.label).length > MAX_FOLDER_LABEL_CHARS ||
    input.label.includes("\0") ||
    /[\r\n]/.test(input.label)
  ) {
    return FOLDER_PICKER_CANCELLED;
  }
  const count =
    typeof input.entries === "number" && Number.isSafeInteger(input.entries)
      ? Math.max(0, Math.min(MAX_FOLDER_PREVIEW_ENTRIES, input.entries))
      : 0;
  return Object.freeze({
    cancelled: false as const,
    grant_id: input.grantId,
    label: input.label,
    preview: Object.freeze({
      entry_count: count,
      truncated: input.truncated === true,
    }),
  });
}

/**
 * Strict parser for the main→backend protocol (the mirror of the renderer
 * bridge): only the four reviewed message kinds are recognized, each to its
 * exact shape; anything else narrows to `undefined`. The backend re-validates
 * independently in `server/src/knowledge/grants.ts`; this parser keeps main
 * itself from ever emitting a malformed message.
 */
export function parseMainMessage(value: unknown): MainMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "shutdown":
      return Object.keys(value).length === 1 ? { type: "shutdown" } : undefined;
    case "render-response": {
      if (!isRequestId(value.request_id)) return undefined;
      if (value.ok === true) {
        const keys = Object.keys(value).sort().join(",");
        if (keys !== "data,ok,request_id,type") return undefined;
        if (!(value.data instanceof Uint8Array) || Buffer.isBuffer(value.data))
          return undefined;
        return {
          type: "render-response",
          request_id: value.request_id,
          ok: true,
          data: value.data,
        };
      }
      if (value.ok === false) {
        const keys = Object.keys(value).sort().join(",");
        if (keys !== "ok,request_id,type") return undefined;
        return {
          type: "render-response",
          request_id: value.request_id,
          ok: false,
        };
      }
      return undefined;
    }
    case "folder-grant": {
      const keys = Object.keys(value).sort().join(",");
      if (keys !== "display_label,grant_id,root_path,type") return undefined;
      const grantId = value.grant_id;
      const rootPath = value.root_path;
      const displayLabel = value.display_label;
      if (typeof grantId !== "string" || !/^[0-9a-f]{64}$/.test(grantId))
        return undefined;
      if (
        typeof rootPath !== "string" ||
        !rootPath.startsWith("/") ||
        rootPath.length < 2 ||
        Buffer.byteLength(rootPath, "utf8") > MAX_FOLDER_ROOT_PATH_BYTES ||
        rootPath.includes("\0") ||
        /[\r\n]/.test(rootPath)
      ) {
        return undefined;
      }
      if (
        typeof displayLabel !== "string" ||
        displayLabel.length < 1 ||
        Array.from(displayLabel).length > MAX_FOLDER_LABEL_CHARS ||
        displayLabel.includes("\0") ||
        /[\r\n]/.test(displayLabel)
      ) {
        return undefined;
      }
      return {
        type: "folder-grant",
        grant_id: grantId,
        root_path: rootPath,
        display_label: displayLabel,
      };
    }
    default:
      return undefined;
  }
}

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
    case "native-smoke":
      return value.ok === true ? { type: "native-smoke", ok: true } : undefined;
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
