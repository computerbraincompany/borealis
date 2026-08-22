import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { q } from "./db.js";

export interface AuthPayload {
  userId: string;
  email: string;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwtSecret) as AuthPayload;
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/register", async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "invalid email" });
    if (password.length < 6) return reply.code(400).send({ error: "password must be at least 6 chars" });
    const exists = await q(`SELECT id FROM users WHERE email=$1`, [email]);
    if (exists.length) return reply.code(409).send({ error: "email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const [user] = await q(
      `INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id`,
      [email, hash]
    );
    return reply.send({ token: signToken({ userId: user.id, email }), user: { id: user.id, email } });
  });

  app.post("/api/login", async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const [user] = await q(`SELECT id, email, password_hash FROM users WHERE email=$1`, [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return reply.code(401).send({ error: "invalid credentials" });
    return reply.send({ token: signToken({ userId: user.id, email: user.email }), user: { id: user.id, email: user.email } });
  });

  app.get("/api/me", { preHandler: requireAuth }, async (req, reply) => {
    const user = (req as any).user;
    return reply.send(user);
  });
}

export function requireAuth(req: FastifyRequest, _reply: any, next: (err?: any) => void) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    (req as any).user = verifyToken(token);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

export function getAccountId(req: FastifyRequest): string {
  return (req as any).user.userId;
}
