import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { DuplicateEmailError } from "./db/stores/chatStore.js";
import { storageRuntime } from "./storageRuntime.js";

export interface AuthPayload {
  userId: string;
  email: string;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, initializedJwtSecret(), { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyToken(token: string): AuthPayload {
  const payload = jwt.verify(token, initializedJwtSecret(), { algorithms: ["HS256"] }) as Partial<AuthPayload>;
  if (
    typeof payload.userId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.userId) ||
    typeof payload.email !== "string"
  ) {
    throw new Error("invalid token payload");
  }
  return payload as AuthPayload;
}

function initializedJwtSecret(): string {
  if (!config.jwtSecret) throw new Error("JWT signing secret is not initialized");
  return config.jwtSecret;
}

export async function authRoutes(app: FastifyInstance) {
  const authBodySchema = {
    type: "object",
    required: ["email", "password"],
    additionalProperties: false,
    properties: {
      email: { type: "string", minLength: 3, maxLength: 254 },
      // Length bounds are enforced in the handlers so over-length passwords
      // get an actionable message instead of a generic schema rejection.
      password: { type: "string", minLength: 6 },
    },
  } as const;
  app.post(
    "/api/register",
    { bodyLimit: 2 * 1024, schema: { body: authBodySchema, security: [] } },
    async (req, reply) => {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as { email?: unknown; password?: unknown })
          : {};
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return reply.code(400).send({ error: "invalid email" });
      if (password.length < 6 || Buffer.byteLength(password, "utf8") > 72)
        return reply.code(400).send({ error: "password must contain between 6 and 72 characters" });
      const hash = await bcrypt.hash(password, 10);
      let user;
      try {
        user = await storageRuntime().chats.createUser({ email, passwordHash: hash });
      } catch (error) {
        if (error instanceof DuplicateEmailError) {
          return reply.code(409).send({ error: "email already registered" });
        }
        throw error;
      }
      return reply.send({ token: signToken({ userId: user.id, email }), user: { id: user.id, email } });
    }
  );

  app.post(
    "/api/login",
    { bodyLimit: 2 * 1024, schema: { body: authBodySchema, security: [] } },
    async (req, reply) => {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as { email?: unknown; password?: unknown })
          : {};
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (email.length > 254) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      // An over-length password is a request-shape problem, not a credential
      // mismatch; it stays account-agnostic and never reaches the user lookup.
      if (Buffer.byteLength(password, "utf8") > 72) {
        return reply.code(400).send({ error: "password must contain at most 72 characters" });
      }
      const user = await storageRuntime().chats.findUserByEmail(email);
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return reply.code(401).send({ error: "invalid credentials" });
      return reply.send({
        token: signToken({ userId: user.id, email: user.email }),
        user: { id: user.id, email: user.email },
      });
    }
  );

  app.get("/api/me", { onRequest: requireAuth }, async (req, reply) => {
    const user = (req as any).user;
    return reply.send(user);
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    (req as any).user = verifyToken(token);
  } catch {
    const requestId = String(reply.getHeader("X-Request-ID") || req.id);
    return reply.code(401).send({ error: "unauthorized", request_id: requestId });
  }
}

export function getAccountId(req: FastifyRequest): string {
  return (req as any).user.userId;
}

/** Install account existence checks on authenticated routes before body parsing. */
export function installAccountSessionValidation(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    const hooks = route.onRequest ? (Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest]) : [];
    const authIndex = hooks.indexOf(requireAuth);
    if (authIndex === -1) return;
    route.onRequest = [
      ...hooks.slice(0, authIndex + 1),
      async (req, reply) => {
        const user = await storageRuntime().chats.findUserById(getAccountId(req));
        if (!user)
          return reply.code(401).send({
            error: "Your session no longer belongs to an active account. Sign in again.",
            code: "SESSION_ACCOUNT_UNAVAILABLE",
            request_id: String(reply.getHeader("X-Request-ID") || req.id),
          });
      },
      ...hooks.slice(authIndex + 1),
    ];
  });
}
