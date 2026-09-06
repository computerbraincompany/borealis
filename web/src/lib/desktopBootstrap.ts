import { type AuthUser, setDesktopSession } from "@/lib/api";

export interface DesktopBootstrapSession {
  token: string;
  user: AuthUser;
}

/**
 * Bounded, path-free result of the native folder picker (M14). The preload
 * exposes only an opaque one-time grant id, a label, and bounded preview
 * metadata; the chosen directory's path never crosses this boundary.
 */
export interface DesktopFolderPick {
  readonly cancelled: boolean;
  readonly grantId?: string;
  readonly label?: string;
  readonly entryCount?: number;
  readonly truncated?: boolean;
}

export interface BorealisDesktopBridge {
  consumeBootstrap(): Promise<DesktopBootstrapSession | null>;
  /**
   * Opens the MCP connection sign-in link in the system browser. Present-only
   * on stage-5 builds. The token must be the one-time intent the backend
   * minted for this exact URL on `authorize`; main verifies it with the
   * backend and only then runs `shell.openExternal`. It is not a general
   * URL-opening surface.
   */
  openSignInLink?(token: unknown, url: unknown): Promise<{ opened: boolean }>;
  /** Native directory picker returning an opaque selection grant (M14). */
  chooseFolder?(): Promise<unknown>;
}

declare global {
  interface Window {
    borealisDesktop?: BorealisDesktopBridge;
  }
}

const MAX_BOOTSTRAP_TOKEN_LENGTH = 16_384;
const MAX_USER_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

const bootstrapOperations = new WeakMap<BorealisDesktopBridge, Promise<void>>();

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isDesktopBootstrapSession(value: unknown): value is DesktopBootstrapSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isBoundedText(candidate.token, MAX_BOOTSTRAP_TOKEN_LENGTH)) return false;
  if (!candidate.user || typeof candidate.user !== "object" || Array.isArray(candidate.user)) return false;
  const user = candidate.user as Record<string, unknown>;
  return isBoundedText(user.id, MAX_USER_ID_LENGTH) && isBoundedText(user.email, MAX_EMAIL_LENGTH);
}

export function hasDesktopBridge(): boolean {
  return typeof window.borealisDesktop?.consumeBootstrap === "function";
}

/**
 * Consume the desktop-only session exactly once for a given preload bridge.
 *
 * The operation resolves without exposing the bootstrap payload to React. This
 * keeps the token out of component state and persistent Chromium storage. The
 * Electron main process mints another bootstrap token on the next launch.
 */
/** True when the stage-5 sign-in-link bridge operation is present. */
export function hasDesktopSignInLinkBridge(): boolean {
  return typeof window.borealisDesktop?.openSignInLink === "function";
}

function isDesktopOpenableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "https:") return parsed.hostname.length > 0;
  if (parsed.protocol !== "http:") return false;
  // Mirror the main-process allowlist: plain HTTP only for the explicit
  // loopback/.local development targets the connection boundary admits.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1") return true;
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Ask main to open the validated sign-in URL in the system browser using the
 * backend-issued one-time intent token. The link is only ever opened on an
 * explicit user click; this performs no navigation of its own.
 */
export async function openDesktopSignInLink(token: string, url: string): Promise<boolean> {
  const bridge = window.borealisDesktop;
  if (!bridge || typeof bridge.openSignInLink !== "function") return false;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return false;
  if (!isDesktopOpenableUrl(url)) return false;
  const result = await bridge.openSignInLink(token, url).catch(() => undefined);
  return result?.opened === true;
}

/** True when the M14 native folder-picker bridge operation is present. */
export function hasFolderPickerBridge(): boolean {
  return typeof window.borealisDesktop?.chooseFolder === "function";
}

const GRANT_ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FOLDER_PREVIEW_ENTRIES = 10_000;

/**
 * Run the native folder picker exactly through the narrow preload surface.
 * The bridge payload is treated as untrusted input: only an exactly
 * well-formed, bounded result is accepted, anything else (including a
 * hostile shape) resolves as cancelled. The returned grant id is the only
 * handle to the selection; the path never reaches renderer code.
 */
export async function chooseDesktopFolder(): Promise<DesktopFolderPick> {
  const bridge = window.borealisDesktop;
  if (!bridge || typeof bridge.chooseFolder !== "function") return { cancelled: true };
  const result = await Promise.resolve()
    .then(() => bridge.chooseFolder!())
    .catch((): undefined => undefined);
  if (!result || typeof result !== "object" || Array.isArray(result)) return { cancelled: true };
  const candidate = result as Record<string, unknown>;
  if (candidate.cancelled === true) return { cancelled: true };
  if (
    candidate.cancelled !== false ||
    typeof candidate.grant_id !== "string" ||
    !GRANT_ID_PATTERN.test(candidate.grant_id) ||
    !isBoundedText(candidate.label, 120) ||
    !candidate.preview ||
    typeof candidate.preview !== "object" ||
    Array.isArray(candidate.preview)
  ) {
    return { cancelled: true };
  }
  const preview = candidate.preview as Record<string, unknown>;
  if (!Number.isSafeInteger(preview.entry_count) || Number(preview.entry_count) < 0) return { cancelled: true };
  if (Number(preview.entry_count) > MAX_FOLDER_PREVIEW_ENTRIES) return { cancelled: true };
  if (typeof preview.truncated !== "boolean") return { cancelled: true };
  return Object.freeze({
    cancelled: false,
    grantId: candidate.grant_id,
    label: candidate.label,
    entryCount: Number(preview.entry_count),
    truncated: preview.truncated,
  });
}

export function initializeDesktopSession(): Promise<void> {
  const bridge = window.borealisDesktop;
  if (!bridge || typeof bridge.consumeBootstrap !== "function") return Promise.resolve();

  const existing = bootstrapOperations.get(bridge);
  if (existing) return existing;

  const operation = Promise.resolve()
    .then(() => bridge.consumeBootstrap())
    .then((bootstrap) => {
      if (isDesktopBootstrapSession(bootstrap)) setDesktopSession(bootstrap.token, bootstrap.user);
    })
    .catch(() => undefined);
  bootstrapOperations.set(bridge, operation);
  return operation;
}
