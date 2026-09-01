import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { routes } from "../routes.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
  CONTAINED_CONFIG_BODY_LIMIT_BYTES,
  CONNECTOR_JSON_BODY_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
  LONG_TEXT_JSON_BODY_LIMIT_BYTES,
  PREFERENCE_JSON_BODY_LIMIT_BYTES,
  SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
} from "../routes/bodyLimits.js";

vi.mock("../runtimeSettings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtimeSettings.js")>();
  return { ...actual, runtimeSettingsStore: () => ({}) };
});

interface ObservedRoute {
  readonly method: string;
  readonly url: string;
  readonly onRequest: unknown;
  readonly preHandler: unknown;
  readonly bodyLimit: number | undefined;
}

function includesHook(candidate: unknown, hook: unknown): boolean {
  return Array.isArray(candidate) ? candidate.includes(hook) : candidate === hook;
}

describe("route security policy", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("keeps the public set explicit and authenticates every protected API route onRequest", async () => {
    const app = Fastify({ bodyLimit: 8 * 1024 });
    apps.push(app);
    const observed: ObservedRoute[] = [];
    app.addHook("onRoute", (options) => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      for (const method of methods) {
        observed.push({
          method: String(method),
          url: options.url,
          onRequest: options.onRequest,
          preHandler: options.preHandler,
          bodyLimit: options.bodyLimit,
        });
      }
    });

    await routes(app);
    await app.ready();

    const apiRoutes = observed.filter((route) => route.url.startsWith("/api/"));
    const publicOperations = new Set(["POST /api/register", "POST /api/login"]);
    expect(apiRoutes.length).toBeGreaterThan(2);
    for (const route of apiRoutes) {
      const operation = `${route.method} ${route.url}`;
      if (publicOperations.has(operation)) {
        expect(includesHook(route.onRequest, requireAuth), operation).toBe(false);
      } else {
        expect(includesHook(route.onRequest, requireAuth), operation).toBe(true);
      }
      expect(includesHook(route.preHandler, requireAuth), operation).toBe(false);
    }

    const health = observed.find((route) => route.method === "GET" && route.url === "/health");
    expect(health).toBeDefined();
    expect(includesHook(health?.onRequest, requireAuth)).toBe(false);
  });

  it("gives every mutation an explicit parser limit and preserves large-route budgets", async () => {
    const app = Fastify({ bodyLimit: 8 * 1024 });
    apps.push(app);
    const observed: ObservedRoute[] = [];
    app.addHook("onRoute", (options) => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      for (const method of methods) {
        observed.push({
          method: String(method),
          url: options.url,
          onRequest: options.onRequest,
          preHandler: options.preHandler,
          bodyLimit: options.bodyLimit,
        });
      }
    });

    await routes(app);
    await app.ready();

    const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const mutations = observed.filter((route) => mutationMethods.has(route.method));
    for (const route of mutations) {
      expect(Number.isSafeInteger(route.bodyLimit), `${route.method} ${route.url}`).toBe(true);
      expect(route.bodyLimit, `${route.method} ${route.url}`).toBeGreaterThan(0);
    }

    const operation = (method: string, url: string): ObservedRoute => {
      const matches = observed.filter((route) => route.method === method && route.url === url);
      expect(matches, `${method} ${url}`).toHaveLength(1);
      return matches[0];
    };
    expect(operation("POST", "/api/register").bodyLimit).toBe(2 * 1024);
    expect(operation("POST", "/api/login").bodyLimit).toBe(2 * 1024);
    expect(operation("POST", "/api/agents").bodyLimit).toBe(LONG_TEXT_JSON_BODY_LIMIT_BYTES);
    expect(operation("POST", "/api/chats").bodyLimit).toBe(IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES);
    expect(operation("PUT", "/api/chats/:id/sources").bodyLimit).toBe(IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES);
    expect(operation("PATCH", "/api/chats/:id").bodyLimit).toBe(COMPACT_JSON_BODY_LIMIT_BYTES);
    expect(operation("PUT", "/api/libraries/:id/sources").bodyLimit).toBe(IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES);
    expect(operation("POST", "/api/connectors").bodyLimit).toBe(CONNECTOR_JSON_BODY_LIMIT_BYTES);
    expect(operation("PATCH", "/api/preferences").bodyLimit).toBe(PREFERENCE_JSON_BODY_LIMIT_BYTES);
    expect(operation("PATCH", "/api/settings").bodyLimit).toBe(SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES);
    expect(operation("POST", "/api/settings/test").bodyLimit).toBe(SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES);
    expect(operation("POST", "/api/models/qualify").bodyLimit).toBe(SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES);
    expect(operation("PUT", "/api/contained/config").bodyLimit).toBe(CONTAINED_CONFIG_BODY_LIMIT_BYTES);
    expect(operation("DELETE", "/api/chats/:id").bodyLimit).toBe(BODYLESS_MUTATION_LIMIT_BYTES);
    expect(operation("POST", "/api/chats/:id/messages").bodyLimit).toBe(config.maxMessageChars * 12 + 4_096);
    expect(operation("POST", "/api/sources/upload").bodyLimit).toBe(config.maxUploadBytes + 64 * 1024);
  });
});
