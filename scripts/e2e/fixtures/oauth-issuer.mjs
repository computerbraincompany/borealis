#!/usr/bin/env node
/**
 * Standalone minimal OAuth 2.0 authorization-code + PKCE issuer fixture for
 * loopback HTTP. Real protocol surface, deliberately tiny:
 *
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 metadata (also
 *       /.well-known/openid-configuration)
 *   POST /register      RFC 7591 dynamic client registration
 *   GET  /authorize     authorize with state + S256 PKCE; auto-approve, or
 *                       deny via E2E_OAUTH_AUTHORIZE_MODE=deny (or ?fx_mode=deny)
 *   POST /token         code exchange + refresh_token with rotation; every
 *                       refresh token is single-use
 *   POST /revoke        RFC 7009 revocation (always 200)
 *   POST /token/introspect  non-standard helper: {active, token_use, expires_at}
 *
 * Ready line: {"fixture":"oauth-issuer","origin"}
 *
 * Environment:
 *   E2E_OAUTH_ACCESS_TTL_SECONDS   default 3600 (set ~2 for expiry tests)
 *   E2E_OAUTH_REFRESH_TTL_SECONDS  default 86400
 *   E2E_OAUTH_CODE_TTL_SECONDS     default 60
 *   E2E_OAUTH_AUTHORIZE_MODE       approve (default) | deny
 *
 * Tokens are memory-only and never printed. Bodies are bounded and never
 * logged. SIGTERM closes only its own sockets and exits 0.
 */
import { randomBytes, createHash } from "node:crypto";
import {
  b64url,
  createTrackedServer,
  emitReady,
  installShutdown,
  listenLoopback,
  parseForm,
  readBoundedBody,
  sendJson,
} from "./lib/http-fixture.mjs";

const MAX_FORM_BYTES = 64 * 1024;
const accessTtl = ttl(process.env.E2E_OAUTH_ACCESS_TTL_SECONDS, 3600);
const refreshTtl = ttl(process.env.E2E_OAUTH_REFRESH_TTL_SECONDS, 86_400);
const codeTtl = ttl(process.env.E2E_OAUTH_CODE_TTL_SECONDS, 60);
const authorizeMode = process.env.E2E_OAUTH_AUTHORIZE_MODE === "deny" ? "deny" : "approve";

function ttl(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 && value <= 86_400_000 ? value : fallback;
}

let issuerOrigin = "http://127.0.0.1:0";

const clients = new Map(); // client_id -> { redirectUris, grants, authMethod }
const codes = new Map(); // code -> { clientId, redirectUri, challenge, expiresAt }
const accessTokens = new Map(); // token -> { clientId, expiresAt }
const refreshTokens = new Map(); // token -> { clientId, used, expiresAt }

function newToken(bytes) {
  return randomBytes(bytes).toString("hex");
}

function oauthError(res, status, code, description) {
  sendJson(res, status, { error: code, ...(description ? { error_description: description } : {}) });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function readBodyAndRespond(req, res, handler) {
  void (async () => {
    try {
      const raw = await readBoundedBody(req, MAX_FORM_BYTES);
      if (raw === null) return;
      const contentType = String(req.headers["content-type"] ?? "");
      let form;
      if (contentType.includes("application/json")) {
        try {
          form = JSON.parse(raw.toString("utf8"));
        } catch {
          form = null;
        }
      } else {
        form = parseForm(raw);
      }
      if (!form || typeof form !== "object") {
        oauthError(res, 400, "invalid_request");
        return;
      }
      await handler(form);
    } catch {
      oauthError(res, 400, "invalid_request");
    }
  })();
}

const tracked = createTrackedServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
    sendJson(res, 200, {
      issuer: issuerOrigin,
      authorization_endpoint: `${issuerOrigin}/authorize`,
      token_endpoint: `${issuerOrigin}/token`,
      registration_endpoint: `${issuerOrigin}/register`,
      revocation_endpoint: `${issuerOrigin}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["fixture"],
    });
    return;
  }

  if (req.method === "POST" && path === "/register") {
    readBodyAndRespond(req, res, (body) => {
      const redirectUris = body.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.length > 10 ||
        !redirectUris.every((item) => typeof item === "string" && /^https?:\/\/\S+$/.test(item))
      ) {
        oauthError(res, 400, "invalid_client_metadata", "redirect_uris required");
        return;
      }
      const clientId = newToken(16);
      clients.set(clientId, {
        redirectUris: [...redirectUris],
        grants: Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"],
        authMethod: typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none",
      });
      sendJson(res, 201, {
        client_id: clientId,
        client_id_issued_at: now(),
        redirect_uris: redirectUris,
        grant_types: clients.get(clientId).grants,
        token_endpoint_auth_method: clients.get(clientId).authMethod,
      });
    });
    return;
  }

  if (req.method === "GET" && path === "/authorize") {
    // Never redirect on a request we could not validate (open-redirect guard).
    const response = url.searchParams;
    const responseType = response.get("response_type");
    const clientId = response.get("client_id") ?? "";
    const redirectUri = response.get("redirect_uri") ?? "";
    const state = response.get("state");
    const challenge = response.get("code_challenge") ?? "";
    const challengeMethod = response.get("code_challenge_method") ?? "";
    const client = clients.get(clientId);
    if (responseType !== "code" || !client) {
      oauthError(res, 400, "invalid_request", "unsupported response_type or unknown client");
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      oauthError(res, 400, "invalid_request", "redirect_uri mismatch");
      return;
    }
    if (!challenge || challengeMethod !== "S256") {
      oauthError(res, 400, "invalid_request", "S256 PKCE is required");
      return;
    }
    const deny = (response.get("fx_mode") ?? authorizeMode) === "deny";
    const target = new URL(redirectUri);
    if (state) target.searchParams.set("state", state);
    if (deny) {
      target.searchParams.set("error", "access_denied");
      res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const code = newToken(24);
    codes.set(code, {
      clientId,
      redirectUri,
      challenge,
      expiresAt: now() + codeTtl,
    });
    target.searchParams.set("code", code);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (req.method === "POST" && path === "/token") {
    readBodyAndRespond(req, res, (body) => {
      const grantType = body.grant_type;
      if (grantType === "authorization_code") {
        const code = String(body.code ?? "");
        const verifier = String(body.code_verifier ?? "");
        const redirectUri = String(body.redirect_uri ?? "");
        const entry = codes.get(code);
        // Single-use code, expiry, redirect and PKCE binding are fail-closed.
        codes.delete(code);
        if (!entry || entry.expiresAt < now()) {
          oauthError(res, 400, "invalid_grant", "unknown or expired code");
          return;
        }
        if (entry.redirectUri !== redirectUri) {
          oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
          return;
        }
        const digest = b64url(createHash("sha256").update(verifier, "ascii").digest());
        if (!verifier || digest !== entry.challenge) {
          oauthError(res, 400, "invalid_grant", "pkce verification failed");
          return;
        }
        issueTokens(res, entry.clientId);
        return;
      }
      if (grantType === "refresh_token") {
        const token = String(body.refresh_token ?? "");
        const entry = refreshTokens.get(token);
        // Rotation: each refresh token is redeemable exactly once; a reuse of
        // an already-rotated token must fail closed.
        if (!entry || entry.used || entry.expiresAt < now()) {
          refreshTokens.delete(token);
          oauthError(res, 400, "invalid_grant", "unknown, used, or expired refresh token");
          return;
        }
        entry.used = true;
        issueTokens(res, entry.clientId);
        return;
      }
      oauthError(res, 400, "unsupported_grant_type");
    });
    return;
  }

  if (req.method === "POST" && path === "/revoke") {
    readBodyAndRespond(req, res, (body) => {
      const token = String(body.token ?? "");
      refreshTokens.delete(token);
      accessTokens.delete(token);
      sendJson(res, 200, {});
    });
    return;
  }

  if (req.method === "POST" && path === "/token/introspect") {
    readBodyAndRespond(req, res, (body) => {
      const token = String(body.token ?? "");
      const refresh = refreshTokens.get(token);
      if (refresh) {
        sendJson(res, 200, {
          active: !refresh.used && refresh.expiresAt >= now(),
          token_type: "refresh_token",
          client_id: refresh.clientId,
          expires_at: refresh.expiresAt,
        });
        return;
      }
      const access = accessTokens.get(token);
      if (!access) {
        sendJson(res, 200, { active: false });
        return;
      }
      sendJson(res, 200, {
        active: access.expiresAt >= now(),
        token_type: "access_token",
        client_id: access.clientId,
        expires_at: access.expiresAt,
        scope: "fixture",
      });
    });
    return;
  }

  oauthError(res, 404, "invalid_request", "unknown endpoint");
});

function issueTokens(res, clientId) {
  const accessToken = newToken(32);
  const refreshToken = newToken(32);
  accessTokens.set(accessToken, { clientId, expiresAt: now() + accessTtl });
  refreshTokens.set(refreshToken, { clientId, used: false, expiresAt: now() + refreshTtl });
  sendJson(res, 200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: accessTtl,
    scope: "fixture",
  });
}

const port = await listenLoopback(tracked.server);
issuerOrigin = `http://127.0.0.1:${port}`;
installShutdown(() => tracked.close());
emitReady({ fixture: "oauth-issuer", origin: issuerOrigin });
