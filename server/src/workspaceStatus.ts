import type { EffectiveLlmSettings } from "./settingsStore.js";
import { getEffectiveLlmSettings } from "./runtimeSettings.js";
import { probeEndpointOk } from "./endpointProbe.js";
import type { ContainedEngineStatus } from "./contained/engineManager.js";

export type ProviderLocality = "local" | "private" | "remote";

/**
 * The ambient workspace status shown in the application chrome. It carries the
 * locality of the configured provider, model presence, and reachability — and
 * deliberately nothing else: no endpoint URL, no credentials, no model lists,
 * and no provider error text.
 */
export interface WorkspaceStatus {
  readonly locality: ProviderLocality;
  readonly endpoint_reachable: boolean;
  readonly lm_studio_reachable: boolean | null;
  readonly chat_model: string;
  readonly embed_model: string;
  readonly contained: {
    readonly state: ContainedEngineStatus["state"];
    readonly model: string | null;
    readonly endpoint_host: string | null;
    readonly endpoint_managed_by_env: boolean;
  } | null;
  readonly checked_at: string;
  readonly latency_ms: number;
}

const STATUS_TTL_MS = 20_000;
const STATUS_PROBE_TIMEOUT_MS = 2_000;

export interface WorkspaceStatusDependencies {
  readonly now?: () => number;
  readonly probe?: typeof probeEndpointOk;
  readonly llmSettings?: () => Promise<EffectiveLlmSettings>;
  /** Ambient contained-engine view; null when no engine is active. */
  readonly contained?: () => ContainedEngineStatus | null;
}

function parseIpv4(host: string): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function ipv6Groups(host: string): readonly number[] | undefined {
  const withoutZone = host.split("%")[0];
  if (!withoutZone.includes(":")) return undefined;
  const parseGroup = (token: string): number | undefined =>
    /^[0-9a-f]{1,4}$/.test(token) ? parseInt(token, 16) : undefined;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  if (tail.length > 0 && tail[tail.length - 1].includes(".")) {
    const mapped = parseIpv4(tail[tail.length - 1]);
    if (!mapped) return undefined;
    tail.splice(
      tail.length - 1,
      1,
      ((mapped[0] << 8) | mapped[1]).toString(16),
      ((mapped[2] << 8) | mapped[3]).toString(16)
    );
  }
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    const groups = head.map(parseGroup);
    return groups.every((group) => group !== undefined) ? (groups as number[]) : undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return undefined;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail].map(parseGroup);
  return groups.every((group) => group !== undefined) ? (groups as number[]) : undefined;
}

function classifyIpv4(octets: readonly [number, number, number, number]): ProviderLocality {
  const [a, b, c] = octets;
  if (a === 127) return "local";
  if (a === 0 && b === 0 && c === 0 && octets[3] === 0) return "local";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return "remote";
}

const PRIVATE_HOSTNAME_SUFFIXES = [".local", ".lan", ".home", ".internal"];

/**
 * Classify where the configured model endpoint lives. Unparseable input
 * classifies as remote: the chrome must disclose the cautious reading.
 */
export function classifyProviderLocality(baseUrl: string): ProviderLocality {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "remote";
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);

  const ipv4 = parseIpv4(hostname);
  if (ipv4) return classifyIpv4(ipv4);

  const groups = ipv6Groups(hostname);
  if (groups) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) {
      return "local";
    }
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return classifyIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
    }
    if (g0 >= 0xfc00 && g0 <= 0xfdff) return "private";
    if (g0 >= 0xfe80 && g0 <= 0xfebf) return "private";
    return "remote";
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "local";
  if (PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return "private";
  if (hostname.includes(".")) return "remote";
  return "private";
}

export function createWorkspaceStatus(dependencies: WorkspaceStatusDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const probe = dependencies.probe ?? probeEndpointOk;
  const llmSettings = dependencies.llmSettings ?? getEffectiveLlmSettings;
  const contained = dependencies.contained ?? (() => null);

  let cache: { readonly status: WorkspaceStatus; readonly at: number } | undefined;
  let inFlight: Promise<WorkspaceStatus> | undefined;

  async function refresh(): Promise<WorkspaceStatus> {
    const settings = await llmSettings();
    const startedAt = now();
    // Probe exceptions degrade to "unreachable"; they never surface as errors.
    const [endpointReachable, lmStudioReachable] = await Promise.all([
      probe(`${settings.llmBaseUrl}/v1/models`, { apiKey: settings.apiKey, timeoutMs: STATUS_PROBE_TIMEOUT_MS }).catch(
        () => false
      ),
      settings.lmStudioBaseUrl
        ? probe(`${settings.lmStudioBaseUrl}/v1/models`, { timeoutMs: STATUS_PROBE_TIMEOUT_MS }).catch(
            () => false as const
          )
        : Promise.resolve(null),
    ]);
    const latency = Math.max(0, Math.min(Math.round(now() - startedAt), STATUS_PROBE_TIMEOUT_MS));
    const engine = contained();
    return Object.freeze({
      locality: classifyProviderLocality(settings.llmBaseUrl),
      endpoint_reachable: endpointReachable,
      lm_studio_reachable: lmStudioReachable,
      chat_model: settings.chatModel,
      embed_model: settings.embedModel,
      contained:
        engine && engine.state !== "off"
          ? Object.freeze({
              state: engine.state,
              model: engine.model,
              endpoint_host: engine.endpoint_host,
              endpoint_managed_by_env: engine.endpoint_managed_by_env,
            })
          : null,
      checked_at: new Date(now()).toISOString(),
      latency_ms: latency,
    });
  }

  return async function workspaceStatus(): Promise<WorkspaceStatus> {
    const at = now();
    if (cache && at - cache.at < STATUS_TTL_MS) return cache.status;
    if (!inFlight) {
      inFlight = refresh()
        .then((status) => {
          cache = { status, at: Date.parse(status.checked_at) };
          return status;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  };
}
