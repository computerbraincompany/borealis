import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import { hasDesktopOperatorCapability, requireAuth } from "../auth.js";
import {
  ContainedConfigError,
  readContainedConfig,
  writeContainedConfig,
  MAX_CONTAINED_ARG_CHARS,
  MAX_CONTAINED_EXTRA_ARGS,
  type ContainedConfig,
} from "../contained/configStore.js";
import { ContainedDownloadError } from "../contained/downloadManager.js";
import { downloadManager, engineManager } from "../contained/runtime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  CONTAINED_CONFIG_BODY_LIMIT_BYTES,
  CONTAINED_DOWNLOAD_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";

export interface ContainedRoutesOptions {
  /**
   * Trusted desktop composition mode derived from server startup options,
   * never from request data. Process-control mutations require this to be
   * exactly `true` in addition to a valid signed desktop-operator claim.
   */
  readonly desktop?: boolean;
}

/**
 * Redacted status projection of the stored contained configuration. It never
 * carries an absolute path, the executable digest, or the raw argument array;
 * every authenticated read sees the same projection.
 */
interface RedactedContainedConfig {
  readonly enabled: boolean;
  readonly binary: string | null;
  readonly model: string | null;
  readonly extra_arg_count: number;
}

function redactContainedConfig(config: ContainedConfig | null): RedactedContainedConfig | null {
  if (!config) return null;
  if (!config.enabled) {
    return { enabled: false, binary: null, model: null, extra_arg_count: 0 };
  }
  return {
    enabled: true,
    binary: path.basename(config.binary_path) || null,
    model: path.basename(config.model_path) || null,
    extra_arg_count: config.extra_args.length,
  };
}

/**
 * Desktop-operator gate. Authentication (`requireAuth`) runs first as the
 * preceding `onRequest` hook; this only adds the authority decision: the
 * server instance must be composed with the trusted `desktop: true` option
 * and the verified token must carry the literal capability. The rejection is
 * a stable generic 403 with the request ID and no mode/account/path detail,
 * and it returns before any handler touches config, files, downloads, or
 * processes.
 */
function createDesktopOperatorGate(desktopMode: boolean) {
  return async function requireDesktopOperator(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (desktopMode === true && hasDesktopOperatorCapability(req)) return undefined;
    const requestId = String(reply.getHeader("X-Request-ID") || req.id);
    return reply.code(403).send({ error: "desktop operator authority required", request_id: requestId });
  };
}

const containedConfigSchema = {
  type: "object",
  required: ["enabled"],
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    binary_path: { type: "string", minLength: 1, maxLength: 4_096 },
    model_path: { type: "string", minLength: 1, maxLength: 4_096 },
    extra_args: {
      type: "array",
      maxItems: MAX_CONTAINED_EXTRA_ARGS,
      items: { type: "string", minLength: 1, maxLength: MAX_CONTAINED_ARG_CHARS },
    },
  },
} as const;

const containedDownloadSchema = {
  type: "object",
  required: ["url", "filename", "sha256"],
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2_048 },
    filename: { type: "string", minLength: 1, maxLength: 180 },
    sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
  },
} as const;

const containedFilenameParams = {
  type: "object",
  required: ["filename"],
  additionalProperties: false,
  properties: { filename: { type: "string", pattern: "^[A-Za-z0-9._-]{1,180}$" } },
} as const;

function sendContainedError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ContainedConfigError) {
    reply.code(400).send({ error: error.message });
    return true;
  }
  if (error instanceof ContainedDownloadError) {
    reply.code(400).send({ error: error.message });
    return true;
  }
  return false;
}

export const containedRoutes: FastifyPluginAsync<ContainedRoutesOptions> = async (app, options) => {
  const desktopMode = options.desktop === true;
  // Mutating routes authenticate first and then require the desktop-operator
  // capability in `onRequest`, before body parsing or any side effect.
  const operatorOnRequest = [requireAuth, createDesktopOperatorGate(desktopMode)];

  app.get("/api/contained", { onRequest: requireAuth }, async (_req, reply) => {
    try {
      return reply.send({
        config: redactContainedConfig(await readContainedConfig()),
        engine: engineManager.snapshot(),
        downloads: downloadManager.snapshot(),
      });
    } catch (error) {
      if (sendContainedError(reply, error)) return;
      throw error;
    }
  });

  app.put(
    "/api/contained/config",
    {
      onRequest: operatorOnRequest,
      bodyLimit: CONTAINED_CONFIG_BODY_LIMIT_BYTES,
      schema: { body: containedConfigSchema },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          enabled: boolean;
          binary_path?: string;
          model_path?: string;
          extra_args?: string[];
        };
        const saved = await writeContainedConfig({
          enabled: body.enabled,
          binaryPath: body.binary_path,
          modelPath: body.model_path,
          extraArgs: body.extra_args,
        });
        return reply.send(redactContainedConfig(saved));
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/contained/downloads",
    {
      onRequest: operatorOnRequest,
      bodyLimit: CONTAINED_DOWNLOAD_BODY_LIMIT_BYTES,
      schema: { body: containedDownloadSchema },
    },
    async (req, reply) => {
      try {
        const body = req.body as { url: string; filename: string; sha256: string };
        const download = await downloadManager.start(body);
        return reply.code(202).send(download);
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/contained/engine/start",
    { onRequest: operatorOnRequest, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES },
    async (_req, reply) => {
      try {
        const state = await engineManager.start();
        return reply.code(202).send(state);
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/contained/engine/stop",
    { onRequest: operatorOnRequest, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES },
    async (_req, reply) => {
      try {
        return reply.send(await engineManager.stop());
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/contained/downloads/:filename",
    {
      onRequest: operatorOnRequest,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: { params: containedFilenameParams },
    },
    async (req, reply) => {
      try {
        const canceled = await downloadManager.cancel((req.params as { filename: string }).filename);
        if (!canceled) return reply.code(404).send({ error: "download not found" });
        return reply.send({ ok: true });
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );
};
