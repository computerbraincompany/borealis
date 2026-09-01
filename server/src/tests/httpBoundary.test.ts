import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { installHttpBoundary } from "../httpErrors.js";
import { currentRequestId } from "../requestContext.js";
import { requireAuth, signToken } from "../auth.js";

describe("Fastify request boundary", () => {
  it("installs its hooks only once per Fastify instance", () => {
    const app = Fastify();
    const addHook = vi.spyOn(app, "addHook");

    installHttpBoundary(app);
    installHttpBoundary(app);

    expect(addHook.mock.calls.filter(([name]) => name === "onRequest")).toHaveLength(1);
  });

  it("keeps concurrent normalized request contexts isolated", async () => {
    const app = Fastify();
    installHttpBoundary(app);
    app.get("/context", async (req) => {
      await new Promise((resolve) => setTimeout(resolve, req.headers["x-delay"] === "slow" ? 10 : 1));
      return { request_id: currentRequestId() };
    });
    await app.ready();
    try {
      const [slow, fast] = await Promise.all([
        app.inject({ method: "GET", url: "/context", headers: { "x-request-id": "slow.request", "x-delay": "slow" } }),
        app.inject({ method: "GET", url: "/context", headers: { "x-request-id": "fast.request", "x-delay": "fast" } }),
      ]);
      expect(slow.json()).toEqual({ request_id: "slow.request" });
      expect(fast.json()).toEqual({ request_id: "fast.request" });
      expect(slow.headers["x-request-id"]).toBe("slow.request");
      expect(fast.headers["x-request-id"]).toBe("fast.request");
    } finally {
      await app.close();
    }
  });

  it("returns a generic correlated envelope without leaking thrown details", async () => {
    const app = Fastify();
    installHttpBoundary(app);
    app.get("/failure", async () => {
      throw new Error("private path /secret/file and token");
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/failure",
        headers: { "x-request-id": "safe.failure-1" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "internal server error", request_id: "safe.failure-1" });
      expect(response.body).not.toContain("/secret/file");
      expect(response.body).not.toContain("token");
    } finally {
      await app.close();
    }
  });

  it("maps malformed JSON and unknown routes to bounded correlated envelopes", async () => {
    const app = Fastify();
    installHttpBoundary(app);
    app.post("/json", async () => ({ ok: true }));
    await app.ready();
    try {
      const malformed = await app.inject({
        method: "POST",
        url: "/json",
        headers: { "content-type": "application/json", "x-request-id": "json.invalid" },
        payload: '{"broken":',
      });
      const missing = await app.inject({
        method: "GET",
        url: "/private/secret?token=do-not-reflect",
        headers: { "x-request-id": "route.missing" },
      });

      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: "invalid request", request_id: "json.invalid" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "not found", request_id: "route.missing" });
      expect(missing.body).not.toContain("private/secret");
      expect(missing.body).not.toContain("do-not-reflect");
    } finally {
      await app.close();
    }
  });

  it("returns an opaque direct 401 from auth without sentinel error matching", async () => {
    const app = Fastify();
    installHttpBoundary(app);
    app.get("/protected", { onRequest: requireAuth }, async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer definitely-not-a-token", "x-request-id": "auth.denied" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized", request_id: "auth.denied" });
    } finally {
      await app.close();
    }
  });

  it("authenticates before parsing and does not enter handlers for rejected bodies", async () => {
    const app = Fastify();
    installHttpBoundary(app);
    const parser = vi.fn((_req, body, done) => done(null, { value: body }));
    const store = vi.fn(async (_body: unknown) => undefined);
    app.addContentTypeParser("application/x-borealis-test", { parseAs: "string" }, parser);
    app.post("/protected", { onRequest: requireAuth, bodyLimit: 16 }, async (req) => {
      await store(req.body);
      return { ok: true };
    });
    app.post("/protected-json", { onRequest: requireAuth, bodyLimit: 16 }, async (req) => {
      await store(req.body);
      return { ok: true };
    });
    await app.ready();
    const authorization = `Bearer ${signToken({
      userId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.test",
    })}`;
    try {
      const unauthorizedOversize = await app.inject({
        method: "POST",
        url: "/protected",
        headers: { "content-type": "application/x-borealis-test", "x-request-id": "auth.before-size" },
        payload: "x".repeat(64),
      });
      expect(unauthorizedOversize.statusCode).toBe(401);
      expect(unauthorizedOversize.json()).toEqual({ error: "unauthorized", request_id: "auth.before-size" });
      expect(parser).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();

      const unauthorizedMalformed = await app.inject({
        method: "POST",
        url: "/protected-json",
        headers: { "content-type": "application/json", "x-request-id": "auth.before-json" },
        payload: '{"broken":',
      });
      expect(unauthorizedMalformed.statusCode).toBe(401);
      expect(unauthorizedMalformed.json()).toEqual({ error: "unauthorized", request_id: "auth.before-json" });
      expect(store).not.toHaveBeenCalled();

      const authorizedOversize = await app.inject({
        method: "POST",
        url: "/protected",
        headers: {
          authorization,
          "content-type": "application/x-borealis-test",
          "x-request-id": "body.too-large",
        },
        payload: "x".repeat(64),
      });
      expect(authorizedOversize.statusCode).toBe(413);
      expect(authorizedOversize.json()).toEqual({
        error: "request payload is too large",
        request_id: "body.too-large",
      });
      expect(parser).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();

      const authorizedMalformed = await app.inject({
        method: "POST",
        url: "/protected-json",
        headers: { authorization, "content-type": "application/json", "x-request-id": "json.after-auth" },
        payload: '{"broken":',
      });
      expect(authorizedMalformed.statusCode).toBe(400);
      expect(authorizedMalformed.json()).toEqual({ error: "invalid request", request_id: "json.after-auth" });
      expect(store).not.toHaveBeenCalled();

      const accepted = await app.inject({
        method: "POST",
        url: "/protected",
        headers: { authorization, "content-type": "application/x-borealis-test" },
        payload: "valid",
      });
      expect(accepted.statusCode).toBe(200);
      expect(parser).toHaveBeenCalledOnce();
      expect(store).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
