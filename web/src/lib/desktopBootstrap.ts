import { type AuthUser, setDesktopSession } from "@/lib/api";

export interface DesktopBootstrapSession {
  token: string;
  user: AuthUser;
}

export interface BorealisDesktopBridge {
  consumeBootstrap(): Promise<DesktopBootstrapSession | null>;
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
