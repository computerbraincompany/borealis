import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;

const unsafeAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unsafeAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // Deprecated IPv4-compatible addresses and both standardized NAT64
  // translation prefixes can route an apparently IPv6 URL to a private IPv4
  // destination. Deny them as a class rather than trying to decode each one.
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  unsafeAddresses.addSubnet(network, prefix, "ipv6");
}

export class UrlPolicyError extends Error {
  constructor(message = "URL is not permitted") {
    super(message);
    this.name = "UrlPolicyError";
  }
}

export function explicitHttpUrls(text: string): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\])}]+/gi)) {
    try {
      urls.add(normalizeHttpUrl(match[0].replace(/[.,;:!?]+$/g, "")));
    } catch {
      // Invalid URL-shaped text is not authority for outbound access.
    }
  }
  return urls;
}

export function normalizeHttpUrl(value: string): string {
  return parseHttpUrl(value).toString();
}

export function parseHttpUrl(value: string, options: { allowNonDefaultPort?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UrlPolicyError();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new UrlPolicyError();
  if (
    !options.allowNonDefaultPort &&
    ((url.protocol === "http:" && url.port && url.port !== "80") ||
      (url.protocol === "https:" && url.port && url.port !== "443"))
  )
    throw new UrlPolicyError();
  url.hash = "";
  return url;
}

export function resolveRedirectTarget(current: URL, location: string): URL {
  const target = new URL(normalizeHttpUrl(new URL(location, current).toString()));
  if (current.protocol === "https:" && target.protocol !== "https:") {
    throw new UrlPolicyError("HTTPS redirects may not downgrade to HTTP");
  }
  return target;
}

function isUnsafeIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return unsafeAddresses.check(address, "ipv4");
  if (family === 6) return unsafeAddresses.check(address, "ipv6");
  return true;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicFetchTransport {
  resolve(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(url: URL, addresses: ResolvedAddress[], signal: AbortSignal): Promise<IncomingMessage>;
}

export async function resolvePublicDestination(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UrlPolicyError();
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await Promise.race([
        lookup(hostname, { all: true, verbatim: true }).catch(() => []),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
  if (!addresses.length || addresses.some(({ address }) => isUnsafeIp(address))) throw new UrlPolicyError();
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function requestPinned(
  url: URL,
  addresses: ResolvedAddress[],
  signal: AbortSignal,
  headers: Record<string, string> = { Accept: "text/plain,text/html,application/json;q=0.8" }
): Promise<IncomingMessage> {
  const selected = addresses[0];
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outbound = request(
      url,
      {
        method: "GET",
        signal,
        headers,
        // Pin the validated DNS result so a second lookup cannot redirect the
        // socket to a private address (DNS-rebinding TOCTOU).
        lookup: ((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
          callback(null, selected.address, selected.family);
        }) as any,
      },
      resolve
    );
    outbound.once("error", reject);
    outbound.end();
  });
}

export async function fetchPublicText(
  rawUrl: string,
  explicitlyRequested: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<{ url: string; status: number; text: string; truncated: boolean }> {
  return fetchPublicTextWithTransport(
    rawUrl,
    explicitlyRequested,
    { resolve: resolvePublicDestination, request: requestPinned },
    { signal, timeoutMs: FETCH_TIMEOUT_MS }
  );
}

/** Injectable transport keeps the redirect/deadline policy executable in unit tests. */
export async function fetchPublicTextWithTransport(
  rawUrl: string,
  explicitlyRequested: ReadonlySet<string>,
  transport: PublicFetchTransport,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ url: string; status: number; text: string; truncated: boolean }> {
  const requested = normalizeHttpUrl(rawUrl);
  if (!explicitlyRequested.has(requested))
    throw new UrlPolicyError("URL must appear explicitly in the current user message");

  let current = new URL(requested);
  // One signal is created outside the redirect loop so DNS, every hop, and
  // response streaming all consume the same wall-clock deadline.
  const operationSignal = combineSignals(options.signal, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await transport.resolve(current, operationSignal);
    const res = await transport.request(current, addresses, operationSignal);
    const status = res.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      const location = res.headers.location;
      res.destroy();
      if (!location || redirects === MAX_REDIRECTS) throw new UrlPolicyError("unsafe redirect");
      current = resolveRedirectTarget(current, location);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      return { url: current.toString(), status, text: "", truncated: false };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const rawChunk of res) {
      const value = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const remaining = MAX_RESPONSE_BYTES - total;
      if (remaining <= 0) {
        truncated = true;
        res.destroy();
        break;
      }
      chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.length, remaining);
      if (value.length > remaining) {
        truncated = true;
        res.destroy();
        break;
      }
    }
    const raw = Buffer.concat(chunks, total).toString("utf8");
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url: current.toString(), status, text, truncated };
  }
  throw new UrlPolicyError();
}
