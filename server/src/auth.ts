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
  return jwt.sign(payload, config.jwtSecret, { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyToken(token: string): AuthPayload {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as Partial<AuthPayload>;
  if (
    typeof payload.userId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.userId) ||
    typeof payload.email !== "string"
  ) {
    throw new Error("invalid token payload");
  }
  return payload as AuthPayload;
}

export async function authRoutes(app: FastifyInstance) {
  const authBodySchema = {
    type: "object",
    required: ["email", "password"],
    additionalProperties: false,
    properties: {
      email: { type: "string", minLength: 3, maxLength: 254 },
      password: { type: "string", minLength: 6, maxLength: 72 },
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
        return reply.code(400).send({ error: "password must contain between 6 and 72 bytes" });
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
      if (email.length > 254 || Buffer.byteLength(password, "utf8") > 72) {
        return reply.code(401).send({ error: "invalid credentials" });
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

  app.get("/api/me", { preHandler: requireAuth }, async (req, reply) => {
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
