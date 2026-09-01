import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import {
  ContainedConfigError,
  readContainedConfig,
  writeContainedConfig,
  MAX_CONTAINED_ARG_CHARS,
  MAX_CONTAINED_EXTRA_ARGS,
} from "../contained/configStore.js";
import { ContainedDownloadError } from "../contained/downloadManager.js";
import { downloadManager, engineManager } from "../contained/runtime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  CONTAINED_CONFIG_BODY_LIMIT_BYTES,
  CONTAINED_DOWNLOAD_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";

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

export async function containedRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/contained", { onRequest: requireAuth }, async (_req, reply) => {
    try {
      return reply.send({
        config: await readContainedConfig(),
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
      onRequest: requireAuth,
      bodyLimit: CONTAINED_CONFIG_BODY_LIMIT_BYTES,
      schema: { body: containedConfigSchema },
    },
    async (req, reply) => {
      try {
        const body = req.body as { enabled: boolean; binary_path?: string; model_path?: string; extra_args?: string[] };
        const saved = await writeContainedConfig({
          enabled: body.enabled,
          binaryPath: body.binary_path,
          modelPath: body.model_path,
          extraArgs: body.extra_args,
        });
        return reply.send(saved);
      } catch (error) {
        if (sendContainedError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/contained/downloads",
    {
      onRequest: requireAuth,
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
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES },
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
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES },
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
      onRequest: requireAuth,
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
}
