/**
 * Journey A — Connected specialist (docs/END_TO_END_ACCEPTANCE.md).
 *
 * Real production build + real Chromium + the protocol fixtures launched
 * through the committed harness (`launchFixture`): one OAuth issuer and two
 * Streamable HTTP MCP fixtures (OAuth-verify and static bearer). The stdio
 * MCP fixture is spawned by the PRODUCT from the connection config — the
 * configured spawn command is the repository's own Node plus the committed
 * fixture script path. Covers:
 *   - BOTH connection kinds created through the real Settings → Connections
 *     UI: stdio (Test + Discover → 6 published tools) and Streamable HTTP;
 *     a static-bearer HTTP connection proves credential custody round-trips;
 *   - an OAuth-protected HTTP connection honestly reports "Sign-in required"
 *     before sign-in; the UI then renders exactly ONE validated sign-in
 *     link, the journey navigates it to the fixture's authorize endpoint,
 *     the loopback callback completes the PKCE exchange, and the row is
 *     polled to the terminal credential-stored state; Test + Discover go;
 *   - a NEW agent built in the AgentEditor Connected tab: read tools
 *     selected; the write-flagged `record_note` is refused at save, then
 *     allowed through the explicit per-binding writing allowance;
 *     `weird_schema` is visibly refused, dropped, and never saved; skills,
 *     identity, and the full job setup (starter prompts, output template,
 *     suggested library) persist across editor reopen;
 *   - a chat bound to that agent runs a real selected read-tool call
 *     (`echo_query`) through the scripted provider with bounded activity
 *     and the fixed connected-tool summaries in the UI;
 *   - mid-run disable: while a slow connected call executes, the stdio
 *     connection is disabled; the NEXT call in the accepted run fails with
 *     the sanitized unavailable summary while the answer still completes —
 *     the chat stays usable; a further turn fails acceptance closed with the
 *     server's stable disabled message and zero provider calls, and after
 *     re-enabling, plain chat turns work again;
 *   - a chat created from the agent's job stays selected-empty with the
 *     library expanded only as a projected suggestion (no implicit scope);
 *   - secret discipline: connection DTOs, rendered page text, server logs,
 *     and a raw byte scan of every workspace artifact never contain the
 *     configured stdio env secret or the bearer token.
 *
 * Screenshots use the harness's content-free sequential names.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HarnessError, assert, pollUntil } from "../harness/util.mjs";
import { launchFixture } from "../harness/providers.mjs";

export const JOURNEY_ID = "A";
export const IMPLEMENTED = true;

const EMAIL = "e2e-journey-a@borealis.test";
const PASSWORD = "borealis-e2e-journey-a-pass";

const STDIO_CONN = "stdio-node (E2E-A)";
const BEARER_CONN = "bearer-http (E2E-A)";
const OAUTH_CONN = "issuer-http (E2E-A)";
const AGENT_NAME = "Connected Specialist (E2E-A)";
const SKILL_NAME = "Evidence discipline (E2E-A)";
const LIBRARY_NAME = "A job library (E2E-A)";

const ANSWER_1 = "FINAL-A-ONE-3c81";
const ANSWER_2 = "FINAL-A-TWO-9d47";
const ANSWER_3 = "FINAL-A-THREE-2f5e";
const ANSWER_4 = "FINAL-A-FOUR-8a1c";
const DISABLED_STEP_SUMMARY =
  "The connected tool is currently unavailable and the call was not made. The operator can re-check the connection in Settings.";

/* ------------------------------------------------------------------ helpers */

async function goHash(session, route) {
  await session.page.evaluate((target) => {
    window.location.hash = target;
  }, route);
}

async function expectText(session, text, timeoutMs = 20_000) {
  await session.page.getByText(text).first().waitFor({ timeout: timeoutMs });
}

async function expectRowText(session, row, text, timeoutMs = 30_000) {
  await pollUntil(
    async () => (await row.getByText(text, { exact: false }).first().isVisible().catch(() => false)) === true,
    { deadlineMs: timeoutMs, intervalMs: 200 }
  ).then((seen) => assert(seen === true, "ROW_TEXT_TIMEOUT", text));
}

/** Deterministic model-facing alias for one connection/tool binding. */
function mcpToolAlias(connectionId, toolId) {
  return `mcp_${createHash("sha256")
    .update(`borealis-mcp-alias:v1|${connectionId}|${toolId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function toolCallStep(id, alias, argumentPieces) {
  return {
    type: "tool_call",
    id,
    name_pieces: [alias.slice(0, 8), alias.slice(8)],
    argument_pieces: argumentPieces,
  };
}

function textStep(pieces) {
  return { type: "text", pieces };
}

/** Opens the Settings modal on its Connections section. */
async function openConnections(session) {
  await session.openSettings();
  await session.page.getByRole("button", { name: "Connections", exact: true }).click();
  await expectText(session, "Add connection");
}

function connectionsRow(session, name) {
  return session.page.locator("div.divide-y > div.p-4").filter({ hasText: name }).first();
}

/** Drives the New connection dialog for one draft. */
async function createConnectionViaUi(session, draft) {
  await session.page.getByRole("button", { name: "Add connection", exact: true }).click();
  await session.page.getByLabel("Connection name").fill(draft.name);
  await session.page
    .getByRole("button", { name: draft.kind === "mcp_stdio" ? "stdio process" : "Streamable HTTP" })
    .click();
  if (draft.kind === "mcp_stdio") {
    await session.page.getByLabel("Stdio executable path").fill(draft.command);
    await session.page.getByLabel("Stdio arguments").fill(draft.args.join("\n"));
  } else {
    await session.page.getByLabel("Connection endpoint URL").fill(draft.url);
  }
  for (const [index, secret] of (draft.headers ?? []).entries()) {
    const fieldset = session.page.locator("fieldset").filter({ hasText: "Custom HTTP headers (secrets)" });
    await fieldset.getByRole("button", { name: "Add entry" }).click();
    await session.page.getByLabel(`Custom HTTP headers (secrets) name ${index + 1}`).fill(secret.name);
    await session.page.getByLabel(`Custom HTTP headers (secrets) value ${index + 1}`).fill(secret.value);
  }
  for (const [index, secret] of (draft.env ?? []).entries()) {
    const fieldset = session.page.locator("fieldset").filter({ hasText: "Environment secrets" });
    await fieldset.getByRole("button", { name: "Add entry" }).click();
    await session.page.getByLabel(`Environment secrets name ${index + 1}`).fill(secret.name);
    await session.page.getByLabel(`Environment secrets value ${index + 1}`).fill(secret.value);
  }
  await session.page.getByRole("button", { name: "Create connection", exact: true }).click();
  await pollUntil(
    async () => (await connectionsRow(session, draft.name).isVisible().catch(() => false)) === true,
    { deadlineMs: 15_000, intervalMs: 150 }
  ).then((seen) => assert(seen === true, "CONNECTION_ROW_MISSING", draft.name));
}

async function clickRowAction(session, name, action) {
  await connectionsRow(session, name).getByRole("button", { name: action, exact: true }).click();
}

/** Re-mounts the Settings → Connections panel so rows refetch from the API. */
async function refreshConnectionsPanel(session) {
  await session.closeSettings();
  await openConnections(session);
}

/** Waits for the server-side status evidence, then re-renders the rows. */
async function waitForConnectionStatus(session, name, wanted, code) {
  const match = await pollUntil(
    async () => {
      const res = await session.apiFetch("/api/connections", { expectStatus: 200 });
      const found = (res.body?.items ?? []).find((item) => item.name === name);
      return found?.status === wanted.status && found?.status_code === wanted.status_code ? found : null;
    },
    { deadlineMs: 40_000, intervalMs: 250 }
  );
  assert(match !== null, "CONNECTION_STATUS_TIMEOUT", code);
  await refreshConnectionsPanel(session);
}

/** Uploads bytes through the real page context (multipart, session token). */
async function uploadFileViaPage(session, fileName, bytes, contentType) {
  const token = await session.token();
  return session.page.evaluate(
    async ({ fileName, bytes, contentType, token }) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(bytes)], fileName, { type: contentType }));
      const res = await fetch("/api/sources/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { fileName, bytes: Array.from(bytes), contentType, token }
  );
}

/** Raw byte scan: no file under `root` may contain the ASCII needle. */
function assertNoBytes(root, needle) {
  const encoded = Buffer.from(needle, "utf8");
  const stack = [root];
  let files = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      if (stat.size > 64 * 1024 * 1024) continue;
      files += 1;
      if (fs.readFileSync(full).includes(encoded)) {
        throw new HarnessError("SECRET_BYTES_LEAKED", path.relative(root, full));
      }
    }
  }
  return files;
}

/* ------------------------------------------------------------------ journey */

export async function run(ctx) {
  const { server, provider, browser, workspace, artifactsDir, repoRoot } = ctx;
  const artifacts = [];
  const checks = {};

  const envCanary = `A-ENV-CANARY-${randomUUID()}`;
  const bearerToken = `A-BEARER-TOKEN-${randomUUID()}`;
  const stdioScript = path.join(repoRoot, "scripts", "e2e", "fixtures", "mcp-server-stdio.mjs");
  assert(fs.existsSync(stdioScript), "STDIO_FIXTURE_MISSING", stdioScript);

  /* -- P0: launch journey fixtures through the committed harness ----------- */
  const issuer = await launchFixture({ workspace, name: "oauth-issuer" });
  workspace.onCleanup(() => issuer.stop());
  const oauthHttp = await launchFixture({
    workspace,
    name: "mcp-server-http",
    env: { E2E_MCP_OAUTH_VERIFY: "1", E2E_MCP_ISSUER_ORIGIN: issuer.ready.origin, E2E_MCP_SLOW_MS: "5000" },
  });
  workspace.onCleanup(() => oauthHttp.stop());
  const bearerHttp = await launchFixture({
    workspace,
    name: "mcp-server-http",
    env: { E2E_MCP_BEARER: bearerToken },
  });
  workspace.onCleanup(() => bearerHttp.stop());
  assert(oauthHttp.ready.auth_required === "oauth-verify", "MCP_HTTP_OAUTH_MODE");
  assert(bearerHttp.ready.auth_required === "bearer", "MCP_HTTP_BEARER_MODE");

  /* -- P1: account + stdio connection through the real UI ------------------ */
  const session = await browser.newSession({ origin: server.origin });
  try {
    await session.register({ email: EMAIL, password: PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));

    await openConnections(session);
    await createConnectionViaUi(session, {
      name: STDIO_CONN,
      kind: "mcp_stdio",
      // The product spawns this exact command: repository Node + fixture path.
      command: process.execPath,
      args: [stdioScript],
      // Keeps the deliberate slow-call inside a 5 s window for P7.
      env: [
        { name: "E2E_STATIC_TOKEN", value: envCanary },
        { name: "E2E_MCP_SLOW_MS", value: "5000" },
      ],
    });
    await clickRowAction(session, STDIO_CONN, "Test");
    await expectRowText(session, connectionsRow(session, STDIO_CONN), "Ready");
    await clickRowAction(session, STDIO_CONN, "Discover");
    await expectRowText(session, connectionsRow(session, STDIO_CONN), "discovery r1 · 6 published tools");
    await expectRowText(session, connectionsRow(session, STDIO_CONN), "Stored securely — never shown again");
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P2: static-bearer HTTP connection (custody round-trip) ------------- */
    await createConnectionViaUi(session, {
      name: BEARER_CONN,
      kind: "mcp_http",
      url: bearerHttp.ready.endpoint,
      headers: [{ name: "authorization", value: `Bearer ${bearerToken}` }],
    });
    await clickRowAction(session, BEARER_CONN, "Test");
    await expectRowText(session, connectionsRow(session, BEARER_CONN), "Ready");

    /* -- P3: OAuth HTTP connection, honest pre-sign-in state ---------------- */
    session.allowStatuses([409, 404]);
    await createConnectionViaUi(session, { name: OAUTH_CONN, kind: "mcp_http", url: oauthHttp.ready.endpoint });
    // A pre-sign-in probe is refused by the OAuth-protected endpoint; the
    // panel keeps the failed action's feedback without overwriting the row,
    // so the durable server-side evidence is awaited and then re-rendered.
    await clickRowAction(session, OAUTH_CONN, "Test");
    await waitForConnectionStatus(
      session,
      OAUTH_CONN,
      { status: "disconnected", status_code: "CONNECTION_AUTH_REQUIRED" },
      "oauth pre-sign-in"
    );
    await expectRowText(session, connectionsRow(session, OAUTH_CONN), "Sign-in required");
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P4: sign in through the real link → callback → terminal state ------ */
    await connectionsRow(session, OAUTH_CONN).getByRole("button", { name: "Sign in", exact: true }).click();
    const signInCard = session.page.getByLabel("Sign-in link");
    await signInCard.waitFor({ timeout: 15_000 });
    const links = signInCard.locator("a");
    assert((await links.count()) === 1, "SIGNIN_LINK_COUNT", String(await links.count()));
    const authorizeUrl = await links.first().getAttribute("href");
    assert(
      typeof authorizeUrl === "string" && authorizeUrl.startsWith(`${issuer.ready.origin}/authorize`),
      "SIGNIN_LINK_TARGET",
      String(authorizeUrl).split("?")[0].slice(0, 48)
    );
    await session.page.goto(authorizeUrl, { waitUntil: "domcontentloaded" });
    assert(session.page.url().includes("/callback"), "SIGNIN_CALLBACK_MISSING", session.page.url().split("?")[0]);
    artifacts.push(await session.screenshot(artifactsDir));
    // Return to the app origin first: the session token lives in the app's
    // own localStorage, not the callback listener's origin.
    await session.gotoHash("/settings");
    await session.page.getByLabel("Settings sections").first().waitFor({ timeout: 30_000 });
    await session.page.getByRole("button", { name: "Connections", exact: true }).click();

    const listBody = await session.apiFetch("/api/connections", { expectStatus: 200 });
    const oauthRow = (listBody.body?.items ?? []).find((item) => item.name === OAUTH_CONN);
    assert(oauthRow, "OAUTH_CONNECTION_ROW_API");
    const stored = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/connections/${oauthRow.id}`, { expectStatus: 200 });
        return res.body?.credential_state === "stored" ? res.body : null;
      },
      { deadlineMs: 45_000, intervalMs: 250 }
    );
    assert(stored !== null, "SIGNIN_NOT_TERMINAL");
    checks.oauth_signin = "terminal-stored";

    // Re-render the panel so the row carries the stored-credential evidence;
    // Test + Discover then go green on the OAuth-protected endpoint.
    await refreshConnectionsPanel(session);
    await expectRowText(session, connectionsRow(session, OAUTH_CONN), "Stored securely — never shown again");
    await clickRowAction(session, OAUTH_CONN, "Test");
    await expectRowText(session, connectionsRow(session, OAUTH_CONN), "Ready");
    await clickRowAction(session, OAUTH_CONN, "Discover");
    await expectRowText(session, connectionsRow(session, OAUTH_CONN), "discovery r1 · 6 published tools");
    artifacts.push(await session.screenshot(artifactsDir));

    const oauthDetail = (await session.apiFetch(`/api/connections/${oauthRow.id}`, { expectStatus: 200 })).body;
    const oauthSlowToolId = oauthDetail.tools.find((tool) => tool.name === "slow_snooze")?.tool_id;
    assert(typeof oauthSlowToolId === "string", "OAUTH_SLOW_TOOL_ID");
    const stdioRow = (listBody.body?.items ?? []).find((item) => item.name === STDIO_CONN);
    assert(stdioRow, "STDIO_CONNECTION_ROW_API");
    const stdioId = stdioRow.id;
    const stdioDetail = (await session.apiFetch(`/api/connections/${stdioId}`, { expectStatus: 200 })).body;
    const stdioToolIds = Object.fromEntries(stdioDetail.tools.map((tool) => [tool.name, tool.tool_id]));
    for (const required of ["echo_query", "slow_snooze", "record_note", "weird_schema"]) {
      assert(typeof stdioToolIds[required] === "string", "STDIO_TOOL_ID", required);
    }
    checks.stdio_discovery = { revision: stdioDetail.discovery_revision, tools: stdioDetail.tools.length };

    /* -- P5: a source and a library for the agent's job setup --------------- */
    const csvName = "a-journey-note.csv";
    const upload = await uploadFileViaPage(
      session,
      csvName,
      Buffer.from("note,value\nconnected specialist,7\n", "utf8"),
      "text/csv"
    );
    assert(upload.status === 200 && typeof upload.body?.id === "string", "SOURCE_UPLOAD_FAILED", String(upload.status));
    const csvSourceId = upload.body.id;
    const csvReady = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const found = (res.body?.items ?? []).find((item) => item.id === csvSourceId);
        return found?.status === "ready" ? found : null;
      },
      { deadlineMs: 90_000, intervalMs: 300 }
    );
    assert(csvReady !== null, "CSV_SOURCE_NOT_READY");

    await goHash(session, "/libraries");
    await expectText(session, "New library");
    await session.page.getByRole("button", { name: "New library", exact: true }).click();
    await session.page.getByLabel("Library name").fill(LIBRARY_NAME);
    await session.page.getByRole("button", { name: "Create", exact: true }).click();
    const library = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/libraries", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.name === LIBRARY_NAME) ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(library !== null, "LIBRARY_NOT_CREATED");
    await session.apiFetch(`/api/libraries/${library.id}/sources`, {
      method: "PUT",
      body: { source_ids: [csvSourceId] },
      expectStatus: 200,
    });

    /* -- P6: build the agent through the real AgentEditor ------------------- */
    await goHash(session, "/agents");
    await expectText(session, "New agent");
    await session.page.getByRole("button", { name: "New agent", exact: true }).click();
    const editor = session.page.getByRole("dialog", { name: "New agent" }).first();
    await editor.getByLabel("Agent name").fill(AGENT_NAME);
    await editor.getByLabel("Agent instructions").fill(
      "You are the connected specialist. Use selected connected tools for live checks and cite evidence numbers."
    );

    await session.page.getByRole("tab", { name: "Skills", exact: true }).click();
    await editor.getByRole("button", { name: "Create skill", exact: true }).click();
    await editor.getByLabel("Skill name").fill(SKILL_NAME);
    await editor.getByLabel("Description", { exact: true }).fill("Ground every claim in retrieved evidence.");
    await editor
      .getByLabel("Markdown instructions")
      .fill("Always cite the numbered evidence passages for connected-tool facts.");
    await editor.getByRole("button", { name: "Save skill", exact: true }).click();
    await pollUntil(
      async () => (await editor.getByLabel(`Assign ${SKILL_NAME}`).isVisible().catch(() => false)) === true,
      { deadlineMs: 15_000, intervalMs: 200 }
    ).then((seen) => assert(seen === true, "SKILL_NOT_LISTED"));
    await editor.getByLabel(`Assign ${SKILL_NAME}`).check();

    await session.page.getByRole("tab", { name: "Connected", exact: true }).click();
    // Scope inside the Connected tabpanel: the editor dialog itself also
    // carries `overflow-hidden rounded-lg border` classes.
    const cardFor = (connectionName) =>
      session.page
        .getByRole("tabpanel")
        .locator("div.overflow-hidden.rounded-lg.border")
        .filter({ hasText: connectionName })
        .first();
    const stdioCard = cardFor(STDIO_CONN);
    const oauthCard = cardFor(OAUTH_CONN);
    await stdioCard.getByLabel("Select connected tool echo_query").check();
    await stdioCard.getByLabel("Select connected tool slow_snooze").check();
    await stdioCard.getByLabel("Select connected tool record_note").check();
    await stdioCard.getByLabel("Select connected tool weird_schema").check();
    await oauthCard.getByLabel("Select connected tool finance_sum").check();
    await oauthCard.getByLabel("Select connected tool slow_snooze").check();

    // The refused saves are deliberate negative-path probes (stable 400s
    // surfaced as the visible refusal UI); admit exactly that code.
    session.allowStatuses([400]);
    // The server codec sorts binding selections by (connection_id, tool_id),
    // so which refusal surfaces first is deterministic: the flagged stdio
    // tools are ordered by their stable tool ids.
    const weirdFirst = stdioToolIds.weird_schema.localeCompare(stdioToolIds.record_note) < 0;
    const saveButton = () => editor.getByRole("button", { name: "Create agent", exact: true });

    // Phase 1 — one of the two server-side refusals surfaces (write flag or
    // unsupported schema) depending on the sorted selection order.
    await saveButton().click();
    if (weirdFirst) {
      await expectText(session, "Unsupported schema — this workspace refuses to execute it.", 15_000);
      assert(
        await stdioCard.getByLabel("Select connected tool weird_schema").isDisabled().catch(() => false),
        "WEIRD_SCHEMA_NOT_DISABLED"
      );
      artifacts.push(await session.screenshot(artifactsDir));
      // Phase 2 — the write-flagged tool is then refused until the explicit
      // per-binding allowance is granted.
      await saveButton().click();
      await expectText(session, "looks write-oriented", 15_000);
      await stdioCard.getByLabel("Allow writing for connected tool record_note").waitFor({ timeout: 15_000 });
      await stdioCard.getByLabel("Allow writing for connected tool record_note").check();
    } else {
      await expectText(session, "looks write-oriented", 15_000);
      await stdioCard.getByLabel("Allow writing for connected tool record_note").waitFor({ timeout: 15_000 });
      artifacts.push(await session.screenshot(artifactsDir));
      await stdioCard.getByLabel("Allow writing for connected tool record_note").check();
      // Phase 2 — the unsupported-schema tool is refused, visibly flagged,
      // disabled, and dropped from the draft by the refusal itself.
      await saveButton().click();
      await expectText(session, "Unsupported schema — this workspace refuses to execute it.", 15_000);
      assert(
        await stdioCard.getByLabel("Select connected tool weird_schema").isDisabled().catch(() => false),
        "WEIRD_SCHEMA_NOT_DISABLED"
      );
    }
    artifacts.push(await session.screenshot(artifactsDir));

    // Final save — both refusals resolved (allowance granted; refused schema
    // dropped); this one lands.
    await saveButton().click();
    await pollUntil(
      async () => (await session.page.getByRole("dialog", { name: "New agent" }).count()) === 0,
      { deadlineMs: 20_000, intervalMs: 200 }
    ).then((closed) => assert(closed === true, "AGENT_EDITOR_NOT_CLOSED"));
    const agent = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/agents", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.name === AGENT_NAME) ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(agent !== null, "AGENT_NOT_CREATED");
    const detail = (await session.apiFetch(`/api/agents/${agent.id}`, { expectStatus: 200 })).body;
    const bindings = detail.mcp_tools ?? [];
    assert(bindings.length === 5, "AGENT_BINDING_COUNT", String(bindings.length));
    assert(
      bindings.every((b) => b.discovery_revision === 1) &&
        bindings.some(
          (b) => b.connection_id === stdioId && b.allow_write === true && b.tool_id === stdioToolIds.record_note
        ) &&
        bindings.filter((b) => b.connection_id === stdioId).length === 3 &&
        bindings.filter((b) => b.connection_id !== stdioId).length === 2 &&
        bindings.filter((b) => b.allow_write !== true).length === 4,
      "AGENT_BINDING_SHAPE",
      JSON.stringify(bindings.map((b) => [b.tool_id ?? b.connection_id, b.allow_write === true]))
    );
    assert(!JSON.stringify(detail.mcp_tools).includes(stdioToolIds.weird_schema), "WEIRD_SCHEMA_PERSISTED");
    assert((detail.skill_ids ?? []).length === 1, "AGENT_SKILL_NOT_PERSISTED");
    checks.agent = { created_version: detail.current_version ?? detail.version, bindings: bindings.length };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P7: chat bound to the agent; real selected-tool turn --------------- */
    await goHash(session, "/chat");
    await session.page.getByLabel("Ask Borealis about your data").waitFor({ timeout: 20_000 });
    await session.page.getByRole("button", { name: "Agent: None" }).click();
    await session.page
      .getByRole("menuitemradio", { name: new RegExp(AGENT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
      .click();
    const echoAlias = mcpToolAlias(stdioId, stdioToolIds.echo_query);
    const slowAlias = mcpToolAlias(stdioId, stdioToolIds.slow_snooze);
    let before = await provider.state();
    await provider.setScript({
      steps: [
        toolCallStep("call_a_echo_1", echoAlias, ['{"text": ', JSON.stringify("journey-A-turn-one") + "}"]),
        textStep(["Echo completed for turn one. ", ANSWER_1]),
      ],
      onExhausted: "fail",
    });
    await session.page.getByLabel("Ask Borealis about your data").fill("Echo a live check through the connection.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, "Borealis is working", 15_000);
    await expectText(session, ANSWER_1, 120_000);
    artifacts.push(await session.screenshot(artifactsDir));
    let after = await provider.state();
    // 3 POSTs: the tool round, the final text, and the chat-title probe.
    assert(after.chat_calls - before.chat_calls === 3, "TURN1_PROVIDER_ARITY", `+${after.chat_calls - before.chat_calls}`);
    checks.turn1_chat_calls = after.chat_calls - before.chat_calls;

    const chatList = (await session.apiFetch("/api/chats", { expectStatus: 200 })).body?.items ?? [];
    assert(chatList.length === 1, "CHAT_COUNT", String(chatList.length));
    const chatId = chatList[0].id;
    const chatDetail = (await session.apiFetch(`/api/chats/${chatId}`, { expectStatus: 200 })).body;
    // The chat DTO carries the write-once binding as `agent: { id, ... }`.
    assert(chatDetail.agent?.id === agent.id, "CHAT_AGENT_BOUND", String(chatDetail.agent?.id));
    assert(chatDetail.source_mode === "selected" && (chatDetail.sources ?? []).length === 0, "CHAT_SCOPE_NOT_EMPTY");

    /* -- P8: mid-run disable → next call sanitized-fails, turn completes ---- */
    const oauthSlowAlias = mcpToolAlias(oauthRow.id, oauthSlowToolId);
    before = await provider.state();
    await provider.setScript({
      steps: [
        toolCallStep("call_a_slow", slowAlias, ["{}"]),
        toolCallStep("call_a_echo_2", echoAlias, ['{"text": ', JSON.stringify("journey-A-turn-two") + "}"]),
        toolCallStep("call_a_oauth_slow", oauthSlowAlias, ["{}"]),
        textStep(["Recovered turn with one blocked call. ", ANSWER_2]),
      ],
      onExhausted: "fail",
    });
    await session.page.getByLabel("Ask Borealis about your data").fill("Run the slow check, then echo again.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    // Once the provider has the first request, the stdio slow call dispatches
    // immediately and sleeps 5 s; disable inside that window so the NEXT call
    // of this accepted run fails closed while the run continues.
    await pollUntil(async () => (await provider.state()).chat_calls >= before.chat_calls + 1, {
      deadlineMs: 30_000,
      intervalMs: 100,
    }).then((seen) => assert(seen === true, "TURN2_FIRST_CALL"));
    // In-run bounded activity surface: the connected-tool step summaries.
    await expectText(session, "Running a connected tool action.", 10_000);
    await session.page.getByText(/^View activity/).first().click().catch(() => undefined);
    const stdioLive = (await session.apiFetch(`/api/connections/${stdioId}`, { expectStatus: 200 })).body;
    await session.apiFetch(`/api/connections/${stdioId}`, {
      method: "PATCH",
      body: { enabled: false, expected_revision: stdioLive.revision },
      expectStatus: 200,
    });
    // The next call fails with the sanitized unavailable summary (observable
    // while the still-authorized OAuth slow call keeps the run open), and the
    // answer still completes.
    await expectText(session, DISABLED_STEP_SUMMARY, 25_000);
    await expectText(session, "1 failed", 25_000);
    artifacts.push(await session.screenshot(artifactsDir));
    await expectText(session, ANSWER_2, 120_000);
    after = await provider.state();
    assert(after.chat_calls - before.chat_calls === 4, "TURN2_PROVIDER_ARITY", `+${after.chat_calls - before.chat_calls}`);
    checks.turn2_blocked_call = true;

    /* -- P9: future turns fail acceptance closed; re-enable → usable -------- */
    session.allowStatuses([409]);
    before = await provider.state();
    const refused = await session.apiFetch(`/api/chats/${chatId}/messages`, {
      method: "POST",
      body: { content: "This turn must not be accepted while the connection is disabled." },
      expectStatus: 409,
    });
    assert(
      typeof refused.body?.error === "string" && /disabled/i.test(refused.body.error),
      "DISABLED_ACCEPTANCE_MESSAGE",
      String(refused.body?.error ?? "").slice(0, 80)
    );
    after = await provider.state();
    assert(after.chat_calls === before.chat_calls, "DISABLED_ACCEPT_NO_PROVIDER_CALL");
    checks.disabled_acceptance_refused = true;

    const stdioDisabled = (await session.apiFetch(`/api/connections/${stdioId}`, { expectStatus: 200 })).body;
    assert(stdioDisabled.enabled === false, "DISABLE_NOT_PERSISTED");
    await session.apiFetch(`/api/connections/${stdioId}`, {
      method: "PATCH",
      body: { enabled: true, expected_revision: stdioDisabled.revision },
      expectStatus: 200,
    });
    before = await provider.state();
    await provider.setScript({ steps: [textStep(["Chat is usable again. ", ANSWER_3])], onExhausted: "fail" });
    await session.page.getByLabel("Ask Borealis about your data").fill("Plain turn after recovery.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, ANSWER_3, 120_000);
    after = await provider.state();
    assert(after.chat_calls - before.chat_calls === 1, "TURN3_PROVIDER_ARITY", `+${after.chat_calls - before.chat_calls}`);
    checks.reenabled_chat_usable = true;

    /* -- P9b: add the job setup through the UI (agent revision 2) ----------- */
    await goHash(session, "/agents");
    const jobCard = session.page.locator("div.p-4").filter({ hasText: AGENT_NAME }).first();
    await jobCard.getByRole("button", { name: "Edit", exact: true }).click();
    const editor2 = session.page.getByRole("dialog", { name: "Edit agent" }).first();
    await editor2.getByRole("tab", { name: "Job", exact: true }).click();
    await editor2.getByRole("button", { name: "Add prompt", exact: true }).click();
    await editor2
      .getByLabel("Starter prompt 1", { exact: true })
      .fill("Run the connected specialist check (E2E-A) on the current book.");
    await editor2.getByLabel("Apply an output template").check();
    await editor2.getByLabel("Output template instruction").fill("Finish with a one-paragraph decision note.");
    await editor2.getByLabel(`Suggest library ${LIBRARY_NAME}`).check();
    await editor2.getByRole("button", { name: "Save changes", exact: true }).click();
    const v2 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/agents/${agent.id}`, { expectStatus: 200 });
        return (res.body?.current_version ?? res.body?.version) === 2 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    );
    assert(v2 !== null, "AGENT_JOB_REVISION");
    assert(
      JSON.stringify(v2.job_setup?.starter_prompts ?? []).includes("E2E-A") &&
        v2.job_setup?.output_template?.instruction?.includes("decision note") &&
        JSON.stringify(v2.job_setup?.library_ids ?? []) === JSON.stringify([library.id]),
      "AGENT_JOB_NOT_PERSISTED"
    );

    /* -- P10: reopen the editor; identity/skills/job/binding persist -------- */
    await goHash(session, "/agents");
    const reopenedCard = session.page.locator("div.p-4").filter({ hasText: AGENT_NAME }).first();
    await reopenedCard.getByRole("button", { name: "Edit", exact: true }).click();
    const reopened = session.page.getByRole("dialog", { name: "Edit agent" }).first();
    assert((await reopened.getByLabel("Agent name").inputValue()) === AGENT_NAME, "REOPEN_IDENTITY");
    assert(
      (await reopened.getByLabel("Agent instructions").inputValue()).includes("connected specialist"),
      "REOPEN_INSTRUCTIONS"
    );
    await session.page.getByRole("tab", { name: "Skills", exact: true }).click();
    assert(await reopened.getByLabel(`Assign ${SKILL_NAME}`).isChecked(), "REOPEN_SKILL");
    await session.page.getByRole("tab", { name: "Connected", exact: true }).click();
    const reopenedStdioCard = cardFor(STDIO_CONN);
    const reopenedOauthCard = cardFor(OAUTH_CONN);
    assert(await reopenedStdioCard.getByLabel("Select connected tool echo_query").isChecked(), "REOPEN_ECHO");
    assert(await reopenedStdioCard.getByLabel("Select connected tool slow_snooze").isChecked(), "REOPEN_SLOW");
    assert(await reopenedOauthCard.getByLabel("Select connected tool finance_sum").isChecked(), "REOPEN_FINANCE");
    assert(await reopenedOauthCard.getByLabel("Select connected tool slow_snooze").isChecked(), "REOPEN_OAUTH_SLOW");
    assert(await reopenedStdioCard.getByLabel("Select connected tool record_note").isChecked(), "REOPEN_RECORD");
    assert(
      await reopenedStdioCard.getByLabel("Allow writing for connected tool record_note").isChecked(),
      "REOPEN_ALLOW_WRITE"
    );
    assert(
      (await reopenedStdioCard.getByLabel("Select connected tool weird_schema").isChecked()) === false,
      "REOPEN_WEIRD_SELECTED"
    );
    await session.page.getByRole("tab", { name: "Job", exact: true }).click();
    assert((await reopened.getByLabel("Starter prompt 1", { exact: true }).inputValue()).includes("E2E-A"), "REOPEN_STARTER_PROMPT");
    assert(
      (await reopened.getByLabel("Output template instruction").inputValue()).includes("decision note"),
      "REOPEN_TEMPLATE"
    );
    assert(await reopened.getByLabel(`Suggest library ${LIBRARY_NAME}`).isChecked(), "REOPEN_LIBRARY_SUGGESTION");
    artifacts.push(await session.screenshot(artifactsDir));
    await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
    await pollUntil(
      async () => (await session.page.getByRole("dialog", { name: "Edit agent" }).count()) === 0,
      { deadlineMs: 10_000, intervalMs: 150 }
    ).then((closed) => assert(closed === true, "REOPEN_EDITOR_NOT_CLOSED"));

    /* -- P10b: a fresh job-bound chat shows the confirmation gate; starting
       without the suggested sources stays selected-empty (no expansion).   -- */
    await goHash(session, "/chat");
    await session.page.getByLabel("Ask Borealis about your data").waitFor({ timeout: 20_000 });

    await session.page.getByRole("button", { name: "Agent: None" }).click();
    await session.page
      .getByRole("menuitemradio", { name: new RegExp(AGENT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
      .click();
    // The first send creates the job-bound chat but holds the message until
    // the job's suggested-library confirmation is answered.
    await session.page.getByLabel("Ask Borealis about your data").fill("First turn after confirming no sources.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, "confirm sources before the first message", 15_000);
    artifacts.push(await session.screenshot(artifactsDir));
    before = await provider.state();
    await provider.setScript({ steps: [textStep(["Gate cleared. ", ANSWER_4])], onExhausted: "fail" });
    await session.page.getByRole("button", { name: "Start without these sources", exact: true }).click();
    await session.page.getByLabel("Ask Borealis about your data").fill("First turn after confirming no sources.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, ANSWER_4, 120_000);
    after = await provider.state();
    // First turn on a fresh chat: the final text plus the title probe.
    assert(after.chat_calls - before.chat_calls === 2, "TURN4_PROVIDER_ARITY", `+${after.chat_calls - before.chat_calls}`);
    const gateChats = (await session.apiFetch("/api/chats", { expectStatus: 200 })).body?.items ?? [];
    const gateChat = gateChats.find((c) => c.agent?.id === agent.id && c.id !== chatId);
    assert(gateChat !== undefined, "GATE_CHAT_NOT_CREATED");
    const gateChatDetail = (await session.apiFetch(`/api/chats/${gateChat.id}`, { expectStatus: 200 })).body;
    assert(
      gateChatDetail.source_mode === "selected" && (gateChatDetail.sources ?? []).length === 0,
      "GATE_CHAT_SCOPE_EXPANDED",
      JSON.stringify({ mode: gateChatDetail.source_mode, n: (gateChatDetail.sources ?? []).length })
    );
    checks.gate_chat = "confirmed without sources; selected-empty persisted";

    /* -- P11: job chat stays selected-empty (no implicit scope) ------------- */
    const jobChat = await session.apiFetch("/api/chats", {
      method: "POST",
      body: {
        title: "Job chat (E2E-A)",
        agent_id: agent.id,
        job: { suggested_library_ids: [library.id] },
      },
      expectStatus: 200,
    });
    assert(
      jobChat.body?.source_mode === "selected" && (jobChat.body?.sources ?? []).length === 0,
      "JOB_CHAT_NOT_SELECTED_EMPTY",
      JSON.stringify({ mode: jobChat.body?.source_mode, n: (jobChat.body?.sources ?? []).length })
    );
    const projection = jobChat.body?.job;
    assert(
      JSON.stringify(projection?.suggested_source_ids ?? []) === JSON.stringify([csvSourceId]) &&
        (projection?.starter_prompts ?? []).some((prompt) => prompt.includes("E2E-A")) &&
        projection?.output_template?.instruction?.includes("decision note"),
      "JOB_PROJECTION",
      JSON.stringify(projection ?? null).slice(0, 120)
    );
    const jobChatDetail = (await session.apiFetch(`/api/chats/${jobChat.body.id}`, { expectStatus: 200 })).body;
    assert(
      (jobChatDetail.sources ?? []).length === 0 && jobChatDetail.source_mode === "selected",
      "JOB_CHAT_SCOPE_NOT_DURABLE"
    );
    checks.job_chat_scope = "selected-empty, suggestion projected only";

    /* -- P12: secrets never appear in DTOs, pages, logs, or raw bytes ------- */
    const connectionsJson = JSON.stringify(await session.apiFetch("/api/connections", { expectStatus: 200 }));
    const stdioDetailJson = JSON.stringify(await session.apiFetch(`/api/connections/${stdioId}`, { expectStatus: 200 }));
    const oauthDetailJson = JSON.stringify(
      await session.apiFetch(`/api/connections/${oauthRow.id}`, { expectStatus: 200 })
    );
    for (const surface of [connectionsJson, stdioDetailJson, oauthDetailJson]) {
      assert(!surface.includes(envCanary), "DTO_LEAK", "env secret in connection DTO");
      assert(!surface.includes(bearerToken), "DTO_LEAK", "bearer token in connection DTO");
    }
    await session.closeSettings().catch(() => undefined);
    await openConnections(session);
    const pageText = await session.page.evaluate(() => document.body.innerText);
    assert(!pageText.includes(envCanary) && !pageText.includes(bearerToken), "PAGE_SECRET_LEAK");
    artifacts.push(await session.screenshot(artifactsDir));

    const filesScanned = assertNoBytes(workspace.workspaceDir, envCanary) + assertNoBytes(workspace.logsDir, envCanary);
    assertNoBytes(workspace.workspaceDir, bearerToken);
    assertNoBytes(workspace.logsDir, bearerToken);
    checks.secret_scan = { files: filesScanned, clean: true };

    /* -- wrap up ------------------------------------------------------------ */
    await server.quiesceWorkers({ token: await session.token() });
    session.assertClean();

    return { artifacts, checks };
  } catch (error) {
    // Failure triage without touching the harness summary contract: stable
    // codes ride in the summary; this file keeps the selector/route detail.
    const { writeText } = await import("../harness/util.mjs");
    await writeText(
      path.join(artifactsDir, "debug-failure.txt"),
      String(error?.stack ?? error?.message ?? error).slice(0, 1_500)
    ).catch(() => undefined);
    await session
      .screenshot(artifactsDir)
      .then((name) => artifacts.push(name))
      .catch(() => undefined);
    throw error;
  } finally {
    await session.close().catch(() => undefined);
  }
}
