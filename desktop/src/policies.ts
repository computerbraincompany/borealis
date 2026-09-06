const MAX_EMBEDDED_PNG_URL_BYTES = 8 * 1024 * 1024;

export function appOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("invalid application port");
  return `http://127.0.0.1:${port}`;
}

export function isTrustedAppUrl(value: string, trustedOrigin: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === trustedOrigin &&
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function isAllowedPreviewWindowUrl(value: string): boolean {
  return value === "about:blank";
}

/**
 * Strict allowlist for the one main-mediated `shell.openExternal` action
 * (a backend-issued one-time sign-in intent). Only `https:` targets may be
 * opened, plus plain `http:` for the exact loopback/`.local` development
 * targets the connection boundary itself admits. URL credentials are always
 * refused. This is the outer gate; the URL is still only opened after the
 * backend verifies-and-consumes the intent token bound to the exact URL.
 */
export function isExternalOpenUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "https:") return parsed.hostname.length > 0;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::1" || host === "[::1]") return true;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  );
}

export function isAllowedRenderResourceUrl(value: string): boolean {
  if (value === "about:blank") return true;
  if (Buffer.byteLength(value, "utf8") > MAX_EMBEDDED_PNG_URL_BYTES)
    return false;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function hasPdfMagic(value: Uint8Array): boolean {
  return (
    value.length >= 5 &&
    Buffer.from(value.subarray(0, 5)).equals(Buffer.from("%PDF-"))
  );
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPngMagic(value: Uint8Array): boolean {
  return (
    value.length >= PNG_MAGIC.length &&
    Buffer.from(value.subarray(0, PNG_MAGIC.length)).equals(PNG_MAGIC)
  );
}
