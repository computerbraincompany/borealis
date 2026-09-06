import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { BODYLESS_MUTATION_LIMIT_BYTES } from "./bodyLimits.js";
import { STARTER_JOBS } from "../starterJobs.js";

/**
 * Versioned agent job setup — Connected agents stage 4.
 *
 * `GET /api/jobs` serves the two bundled editable starter jobs (finance
 * analysis, diligence memo) as seedable definitions. They carry no implicit
 * attached data (empty `job_setup.library_ids`, built-in tools only) and no
 * required remote service. A user confirms a starter into a real agent by
 * creating (or patching) an agent from the definition — after that the job
 * is an ordinary versioned agent whose edits affect only the NEXT accepted
 * turn. Creating a chat from a job uses the `job` field on
 * `POST /api/chats` (see the chats route).
 */
export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/jobs",
    {
      onRequest: requireAuth,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      // No response schema on purpose: the job-setup block is a versioned
      // discriminated shape (M13 adds template variants) and Fastify's
      // serializer would strip properties it does not enumerate. The
      // definitions are static server-side constants validated by the
      // job-codec test matrix, never user input.
      schema: { tags: ["jobs"], summary: "List the bundled editable starter job templates" },
    },
    async (req, reply) => {
      // Static definitions; `getAccountId` only enforces the session.
      getAccountId(req);
      return reply.send({ jobs: STARTER_JOBS });
    }
  );
}
