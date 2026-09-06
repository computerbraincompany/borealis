/**
 * Playwright Chromium session helpers for the product-acceptance harness.
 *
 * - headless Chromium only; loopback traffic is never proxied;
 * - registration and login happen through the REAL rendered UI (the same
 *   forms a user sees), never by minting tokens or poking localStorage;
 * - a console/pageerror collector fails the run on unexpected errors,
 *   including React `act(...)` warnings; a narrow allowlist covers `401`
 *   resource failures observed while the auth bootstrap is in flight;
 * - screenshots are content-free: sequential `shot-NNN.png` names under the
 *   journey artifact directory, never derived from page content.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { HarnessError, assert } from "./util.mjs";

/** Resolve the pinned Playwright install owned by the server workspace package. */
async function loadPlaywright(repoRoot) {
  try {
    return await import("playwright");
  } catch {
    // Fall back to the physical workspace location, like the MCP fixtures do.
  }
  const physical = path.join(repoRoot, "server", "node_modules", "playwright", "index.mjs");
  if (!fs.existsSync(physical)) {
    throw new HarnessError("PLAYWRIGHT_UNRESOLVED", "run pnpm install at the repository root");
  }
  return import(pathToFileURL(physical).href);
}

export async function launchBrowser({ workspace, repoRoot }) {
  const playwright = await loadPlaywright(repoRoot);
  const browser = await playwright.chromium.launch({
    headless: true,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" },
  });
  const handle = {
    browser,
    async newSession({ origin }) {
      return createSession({ browser, origin, workspace });
    },
    async close() {
      await browser.close({ timeout: 15_000 }).catch(() => browser.process()?.kill("SIGKILL"));
    },
  };
  return handle;
}

/**
 * One authenticated-capable browser session with console collection. The
 * default failure policy is fail-closed: any console error or page error
 * outside the allowlist fails the journey at `assertClean()`.
 */
async function createSession({ browser, origin, workspace }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const collected = [];
  let authBootstrap = true;
  // 401 resource failures during the auth bootstrap phase are expected while
  // the SPA probes session-backed surfaces before a token exists.
  const phaseAllowlist = [/the server responded with a status of 401/i];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (authBootstrap && phaseAllowlist.some((pattern) => pattern.test(text))) {
      collected.push({ kind: "console", text: text.slice(0, 300), allowed: true });
      return;
    }
    collected.push({ kind: "console", text: text.slice(0, 300), allowed: false });
  });
  page.on("pageerror", (error) => {
    collected.push({ kind: "pageerror", text: String(error?.message ?? error).slice(0, 300), allowed: false });
  });
  page.on("requestfailed", (request) => {
    // Aborted navigations are routine; only note them for the failure dump.
    collected.push({ kind: "requestfailed", text: `${request.url().split("?")[0]} aborted`, allowed: true });
  });

  const session = {
    page,
    context,
    origin,

    setAuthBootstrap(value) {
      authBootstrap = Boolean(value);
    },

    async gotoHash(route) {
      await page.goto(`${origin}/#${route}`, { waitUntil: "domcontentloaded" });
    },

    async register({ email, password }) {
      authBootstrap = true;
      await session.gotoHash("/login");
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await session.awaitWorkspaceShell();
      authBootstrap = false;
    },

    async login({ email, password }) {
      authBootstrap = true;
      await session.logout();
      await session.gotoHash("/login");
      await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 10_000 });
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await session.awaitWorkspaceShell();
      authBootstrap = false;
    },

    /** The chat composer is the stable landmark of the authenticated shell. */
    async awaitWorkspaceShell() {
      await page.getByLabel("Ask Borealis about your data").waitFor({ timeout: 20_000 });
    },

    async logout() {
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    },

    /** Read the JWT the real UI stored, for API-side persistence assertions. */
    async token() {
      const token = await page.evaluate(() => window.localStorage.getItem("borealis_token"));
      assert(typeof token === "string" && token.length > 0, "SESSION_TOKEN_MISSING");
      return token;
    },

    async apiFetch(route, options = {}) {
      const token = await session.token();
      const result = await page.evaluate(
        async ({ route, token }) => {
          const res = await fetch(route, { headers: { Authorization: `Bearer ${token}` } });
          const type = res.headers.get("content-type") || "";
          const body = type.includes("json") ? await res.json().catch(() => null) : null;
          return { status: res.status, body };
        },
        { route, token }
      );
      if (options.expectStatus !== undefined) {
        assert(result.status === options.expectStatus, "API_STATUS_UNEXPECTED", `${route} → ${result.status}`);
      }
      return result;
    },

    async openSettings() {
      await page.evaluate(() => {
        window.location.hash = "/settings";
      });
      await page.getByLabel("Settings sections").first().waitFor({ timeout: 20_000 });
    },

    async closeSettings() {
      await page.evaluate(() => {
        window.location.hash = "/chat";
      });
      await session.awaitWorkspaceShell();
    },

    async expectTextOnPage(text) {
      await page.getByText(text).first().waitFor({ timeout: 15_000 });
    },

    /** Content-free screenshot name: shot-001.png under the journey directory. */
    async screenshot(artifactsDir) {
      session.shotCounter += 1;
      const name = `shot-${String(session.shotCounter).padStart(3, "0")}.png`;
      await page.screenshot({ path: path.join(artifactsDir, name), fullPage: false });
      return name;
    },
    shotCounter: 0,

    /** Fail the run on any collected error outside the active allowlist. */
    assertClean() {
      const unexpected = collected.filter((entry) => !entry.allowed);
      if (unexpected.length > 0) {
        // Codes only in the thrown message; text is truncated content anyway
        // and this summary is the only place it surfaces.
        const summary = unexpected
          .slice(0, 5)
          .map((entry) => `${entry.kind}:${entry.text.slice(0, 120)}`)
          .join(" | ");
        throw new HarnessError("BROWSER_CONSOLE_ERRORS", `${unexpected.length} unexpected: ${summary}`);
      }
      return { errors: 0, allowed: collected.filter((entry) => entry.allowed).length };
    },

    consoleLog: collected,

    async close() {
      await context.close().catch(() => undefined);
    },
  };

  return session;
}
