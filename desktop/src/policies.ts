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
