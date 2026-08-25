import { config } from "./config.js";
import { pool } from "./db.js";
import { py } from "./pythonClient.js";

export type ServiceHealthStatus = "operational" | "unavailable";

export type ServiceHealthId = "api" | "database" | "data_service" | "model_gateway" | "model_runtime";

export interface ServiceHealth {
  id: ServiceHealthId;
  name: string;
  description: string;
  status: ServiceHealthStatus;
  latency_ms: number;
}

export interface SystemHealth {
  status: "operational" | "degraded";
  checked_at: string;
  services: ServiceHealth[];
}

interface HealthCheckDefinition {
  id: ServiceHealthId;
  name: string;
  operational: string;
  unavailable: string;
  check: () => Promise<boolean>;
}

export interface SystemHealthDependencies {
  now?: () => number;
  database: () => Promise<boolean>;
  dataService: () => Promise<boolean>;
  modelGateway: () => Promise<boolean>;
  modelRuntime: () => Promise<boolean>;
}

const HEALTH_TIMEOUT_MS = 2_000;

async function fetchOk(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

async function databaseHealthy(): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("health check timed out")), HEALTH_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Build the authenticated readiness view from bounded, body-free probes. The
 * response deliberately contains no endpoints, credentials, provider errors,
 * database metadata, or model names.
 */
export function createSystemHealthCheck(dependencies: SystemHealthDependencies) {
  const now = dependencies.now ?? Date.now;

  return async (): Promise<SystemHealth> => {
    const definitions: HealthCheckDefinition[] = [
      {
        id: "api",
        name: "Borealis API",
        operational: "The application server is accepting requests.",
        unavailable: "The application server is unavailable.",
        check: async () => true,
      },
      {
        id: "database",
        name: "Database",
        operational: "Chats, sources, and reports can be stored.",
        unavailable: "Chats, sources, and reports cannot be stored right now.",
        check: dependencies.database,
      },
      {
        id: "data_service",
        name: "Data service",
        operational: "Dataset queries, charts, and reports are available.",
        unavailable: "Dataset queries, charts, and reports are unavailable.",
        check: dependencies.dataService,
      },
      {
        id: "model_gateway",
        name: "LiteLLM gateway",
        operational: "Model requests can reach the configured gateway.",
        unavailable: "Chat and embedding requests cannot reach LiteLLM.",
        check: dependencies.modelGateway,
      },
      {
        id: "model_runtime",
        name: "LM Studio runtime",
        operational: "The local model runtime is responding.",
        unavailable: "LiteLLM cannot complete model work until LM Studio is available.",
        check: dependencies.modelRuntime,
      },
    ];

    const services = await Promise.all(
      definitions.map(async (definition): Promise<ServiceHealth> => {
        const startedAt = now();
        let healthy: boolean;
        try {
          healthy = await definition.check();
        } catch {
          healthy = false;
        }
        const latency = Math.max(0, Math.min(Math.round(now() - startedAt), HEALTH_TIMEOUT_MS));
        return {
          id: definition.id,
          name: definition.name,
          description: healthy ? definition.operational : definition.unavailable,
          status: healthy ? "operational" : "unavailable",
          latency_ms: latency,
        };
      })
    );

    return {
      status: services.every((service) => service.status === "operational") ? "operational" : "degraded",
      checked_at: new Date(now()).toISOString(),
      services,
    };
  };
}

export const checkSystemHealth = createSystemHealthCheck({
  database: databaseHealthy,
  dataService: () => py.health(),
  modelGateway: () =>
    fetchOk(`${config.llmBaseUrl}/health/liveliness`, { Authorization: `Bearer ${config.llmApiKey}` }),
  modelRuntime: () => fetchOk(`${config.lmStudioBaseUrl}/v1/models`),
});
