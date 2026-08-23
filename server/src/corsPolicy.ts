import { config } from "./config.js";

export function isCorsOriginAllowed(origin: string | undefined, allowlist = config.corsOrigins): boolean {
  // Requests without Origin are non-browser/local clients, not cross-origin
  // credentialed browser requests.
  return origin === undefined || allowlist.includes(origin);
}

export function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allowed: boolean) => void
): void {
  callback(null, isCorsOriginAllowed(origin));
}
