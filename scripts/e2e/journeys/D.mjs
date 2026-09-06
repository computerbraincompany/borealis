/**
 * Journey D — Living corpus (docs/END_TO_END_ACCEPTANCE.md).
 *
 * Real production build + real Chromium + the harness-launched authenticated
 * WebDAV fixture (real HTTP Basic auth, real PROPFIND/PUT/MKCOL/DELETE) +
 * the scripted provider for deterministic embeddings. Covers:
 *   - importing the committed `data/e2e/supplier-corpus` through the browser
 *     file picker (multi-file upload) plus the API-with-session copied-
 *     directory manifest commit (`POST /api/libraries/:id/directory-imports`,
 *     operation-id idempotence + membership-revision CAS), with byte/size
 *     expectations from the committed corpus manifest and the `.rtf` honestly
 *     refused by the upload contract;
 *   - a WebDAV knowledge connection created through the real Libraries →
 *     Knowledge connections UI into the same library: bad credentials first
 *     → failed preview + the actionable "Credentials rejected — replace the
 *     application password" reconnect state → good credentials through the
 *     credential edit → preview shows the classified diff INCLUDING the
 *     unsupported `.rtf` and the skipped hidden file → apply → ready members
 *     appear in the library;
 *   - edit/add/rename/remove through the fixture's real PUT/MKCOL/DELETE,
 *     then a UI Refresh: modified reuses the source id with a NEW generation;
 *     removed files land in `missing` refresh outcomes with their stale
 *     sources kept ready in the library (`missing_upstream` lifecycle); a
 *     later same-path replacement re-promotes the SAME source at a newer
 *     generation; a new nested file (MKCOL + PUT) and a duplicate path
 *     arrive through a second preview/apply;
 *   - keyword search finds fixture evidence with real typed locators (text
 *     spans for markdown, `PDF page` for the text PDF) and the passage panel
 *     shows bounded neighbors + generation; semantic search runs through the
 *     scripted embeddings and is stable across identical queries; the
 *     unsupported `.rtf` price (4600) and the hidden-file contents are never
 *     searchable;
 *   - the earlier answer's evidence stays frozen across every refresh:
 *     citations/excerpts byte-identical, the chat's selected scope
 *     byte-unchanged, the cited passage still readable with its locator, and
 *     the pruned pre-edit chunk honestly reporting unavailable navigation;
 *   - the WebDAV password never appears in any DTO, page text, or on-disk
 *     byte scan of the workspace or logs.
 *
 * Screenshots use the harness's content-free sequential names.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HarnessError, assert, pollUntil } from "../harness/util.mjs";
import { launchFixture } from "../harness/providers.mjs";

export const JOURNEY_ID = "D";
export const IMPLEMENTED = true;

const EMAIL = "e2e-journey-d@borealis.test";
const PASSWORD = "borealis-e2e-journey-d-pass";

const LIBRARY_NAME = "Supplier knowledge (E2E-D)";
const CONNECTION_NAME = "Team docs (E2E-D)";
const WEBDAV_USER = "e2e-d-user";

const ANSWER_D = "FINAL-D-EVIDENCE-6b02";

const SKIP_EXTENSIONS = new Set([".rtf"]);
const D1_TOKEN = "D1-ORIG-4471";
const D1_EDITED_TOKEN = "D1-EDITED-991";
const D2_REVIVE_TOKEN = "D2-REVIVE-551";
const D3_TOKEN = "D3-RENAME-7742";
const D4_TOKEN = "D4-NEW-6620";

/* ------------------------------------------------------------------ helpers */

async function goHash(session, route) {
  await session.page.evaluate((target) => {
    window.location.hash = target;
  }, route);
}

async function expectText(session, text, timeoutMs = 20_000) {
  await session.page.getByText(text).first().waitFor({ timeout: timeoutMs });
}

async function expectIn(scope, matcher, timeoutMs = 20_000) {
  await scope.getByText(matcher).first().waitFor({ timeout: timeoutMs });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Closes any open dialog overlays deterministically (Radix Escape). */
async function closeDialogs(session) {
  const closed = await pollUntil(
    async () => {
      const open = await session.page.locator('[role="dialog"]:visible').count();
      if (open === 0) return true;
      await session.page.keyboard.press("Escape");
      return false;
    },
    { deadlineMs: 8_000, intervalMs: 300 }
  );
  assert(closed === true, "DIALOGS_NOT_CLOSED");
}

/** One WebDAV call against the fixture's real transport (Basic auth). */
async function davRequest(origin, method, relPath, { user, password, body, expectStatus, headers = {} }) {
  const auth = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  const res = await fetch(`${origin}${relPath}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...headers },
    body: body ?? undefined,
    redirect: "error",
  });
  const text = await res.text().catch(() => "");
  assert(expectStatus === undefined || res.status === expectStatus, "WEBDAV_STATUS", `${method} ${relPath} → ${res.status}`);
  return text;
}

/** Raw byte scan: no file under `root` may contain the ASCII needle. */
function scanForBytes(root, needle) {
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
        throw new HarnessError("PASSWORD_BYTES_LEAKED", path.relative(root, full));
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

  const webdavPass = `D-WEBDAV-PASS-${randomUUID()}`;
  const webdavWrongPass = `D-WEBDAV-WRONG-${randomUUID()}`;
  const corpusDir = path.join(repoRoot, "data", "e2e", "supplier-corpus");
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, "manifest.json"), "utf8"));
  const corpusFiles = manifest.documents.map((doc) => doc.file);
  const supported = corpusFiles.filter((file) => !SKIP_EXTENSIONS.has(path.extname(file).toLowerCase()));
  assert(supported.length === 9 && corpusFiles.length === 10, "CORPUS_SHAPE");

  /* -- P0: seed the WebDAV tree, then launch the fixture on it ------------ */
  const davRoot = workspace.assertOwnedPath(path.join(workspace.root, "webdav-tree"));
  fs.mkdirSync(davRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(davRoot, "d1.md"),
    `# CedarNorth ridge notes\nHosting renewal window 2026-05.\nCedar token ${D1_TOKEN}.\n`
  );
  fs.writeFileSync(path.join(davRoot, "d2.md"), "# Everline notes\nEverline token D2-KEEP-1180.\n");
  fs.writeFileSync(path.join(davRoot, "d3.md"), `# BlueRiver notes\nBlueRiver token ${D3_TOKEN}.\n`);
  fs.mkdirSync(path.join(davRoot, "sub"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(davRoot, "sub", "readme.md"), "# Nested notes\nNested scan-depth proof.\n");
  fs.copyFileSync(path.join(corpusDir, "08_delta_renewal_memo.rtf"), path.join(davRoot, "memo.rtf"));
  fs.writeFileSync(path.join(davRoot, ".hidden-notes.md"), `Hidden memo mentions 4600 and ${D4_TOKEN}.\n`);
  const webdav = await launchFixture({
    workspace,
    name: "webdav",
    env: { E2E_WEBDAV_ROOT: davRoot, E2E_WEBDAV_USER: WEBDAV_USER, E2E_WEBDAV_PASS: webdavPass },
  });
  workspace.onCleanup(() => webdav.stop());
  assert(typeof webdav.ready?.origin === "string", "WEBDAV_READY_ORIGIN");

  const session = await browser.newSession({ origin: server.origin });
  try {
    await session.register({ email: EMAIL, password: PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P1: import the committed corpus (browser picker + manifest) -------- */
    await goHash(session, "/sources");
    await expectText(session, "Upload files");
    await session.page
      .locator('input[type="file"]')
      .first()
      .setInputFiles(supported.map((file) => path.join(corpusDir, file)));
    const readySources = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const items = res.body?.items ?? [];
        if (items.length !== supported.length) return null;
        if (!items.every((item) => item.status === "ready")) return null;
        return items;
      },
      { deadlineMs: 150_000, intervalMs: 300 }
    );
    assert(readySources !== null, "CORPUS_NOT_READY");
    const byName = Object.fromEntries(readySources.map((item) => [item.display_name, item]));
    for (const doc of manifest.documents) {
      if (SKIP_EXTENSIONS.has(path.extname(doc.file).toLowerCase())) continue;
      const source = byName[doc.file];
      assert(source, "CORPUS_MEMBER_MISSING", doc.file);
      assert(source.size_bytes === doc.bytes, "CORPUS_SIZE_MISMATCH", doc.file);
      assert(sha256(fs.readFileSync(path.join(corpusDir, doc.file))) === doc.sha256, "CORPUS_SHA_MISMATCH", doc.file);
    }
    checks.corpus = { files: supported.length, bytes_verified: true };

    // The unsupported `.rtf` is honestly refused at the upload boundary.
    session.allowStatuses([422, 409]);
    const rtfBytes = fs.readFileSync(path.join(corpusDir, "08_delta_renewal_memo.rtf"));
    const rtfRes = await session.page.evaluate(
      async ({ bytes, token }) => {
        const form = new FormData();
        form.append("file", new File([new Uint8Array(bytes)], "08_delta_renewal_memo.rtf", { type: "application/rtf" }));
        const res = await fetch("/api/sources/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { bytes: Array.from(rtfBytes), token: await session.token() }
    );
    assert(rtfRes.status === 422 && /unsupported/i.test(String(rtfRes.body?.error)), "RTF_UPLOAD_REJECTED", String(rtfRes.status));

    // Library through the UI, then the copied-directory manifest commit
    // (API-with-session) against the exact membership revision.
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

    const libDetail = (await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 })).body;
    const operationId = randomUUID();
    const items = supported.map((file) => ({ source_id: byName[file].id, relative_path: `supplier-corpus/${file}` }));
    const committed = await session.apiFetch(`/api/libraries/${library.id}/directory-imports`, {
      method: "POST",
      body: { operation_id: operationId, expected_revision: libDetail.revision, items },
      expectStatus: 200,
    });
    assert(committed.body?.added === supported.length, "DIRECTORY_IMPORT_ADDED", JSON.stringify(committed.body));
    const replay = await session.apiFetch(`/api/libraries/${library.id}/directory-imports`, {
      method: "POST",
      body: { operation_id: operationId, expected_revision: libDetail.revision, items },
      expectStatus: 200,
    });
    assert(replay.body?.idempotent === true && replay.body?.added === 0, "DIRECTORY_IMPORT_REPLAY", JSON.stringify(replay.body));
    const staleCommit = await session.apiFetch(`/api/libraries/${library.id}/directory-imports`, {
      method: "POST",
      body: {
        operation_id: randomUUID(),
        expected_revision: libDetail.revision,
        items: [{ source_id: byName[supported[0]].id, relative_path: "supplier-corpus/conflict.md" }],
      },
      expectStatus: 409,
    });
    assert(staleCommit.body?.code === "LIBRARY_REVISION_CONFLICT", "DIRECTORY_IMPORT_CAS", String(staleCommit.body?.code));
    const membersAfterCommit = (await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 })).body;
    assert(membersAfterCommit.members?.length === supported.length, "LIBRARY_MEMBERS_COMMITTED");
    checks.directory_import = { added: committed.body.added, replay: "idempotent", cas: "409" };

    /* -- P2: library search — keyword locators, semantic, honest absence --- */
    const manageCard = session.page.locator("div.p-4").filter({ hasText: LIBRARY_NAME }).first();
    // Each search runs in a fresh dialog: a long result list would otherwise
    // grow the dialog past the viewport and strand the form controls.
    const searchOnce = async (fn) => {
      await manageCard.getByRole("button", { name: "Manage", exact: true }).click();
      const manage = session.page.getByRole("dialog", { name: LIBRARY_NAME }).first();
      await manage.getByRole("button", { name: "Search sources", exact: true }).click();
      const panel = session.page.getByRole("dialog", { name: `Search ${LIBRARY_NAME}` }).first();
      await fn(panel);
      // Escape closes the (search, then manage) dialogs; a long result list
      // can push the header close button outside the viewport.
      await closeDialogs(session);
    };
    const withQuery = async (panel, query) => {
      await panel.getByLabel("Search query").fill(query);
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      await panel.getByText(/hits?\b/).first().waitFor({ timeout: 20_000 });
    };

    await searchOnce(async (panel) => {
      await withQuery(panel, "21000");
      await expectIn(panel, /21000/);
      // Text documents carry typed text-span locators.
      await expectIn(panel, /text chars/);
      await panel.getByRole("button", { name: "Open passage" }).first().click();
      await expectIn(panel, /Passage — /);
      await expectIn(panel, /generation \d+|captured generation/);
      await panel.getByLabel("Close passage").click();
      artifacts.push(await session.screenshot(artifactsDir));
    });
    await searchOnce(async (panel) => {
      // The text PDF carries a real page locator (committed corpus fact 4100).
      await withQuery(panel, "4100");
      await expectIn(panel, /PDF page \d+/);
      artifacts.push(await session.screenshot(artifactsDir));
    });
    await searchOnce(async (panel) => {
      // The unsupported `.rtf` price and hidden-file content are not searchable.
      await withQuery(panel, "4600");
      await expectIn(panel, "No indexed passages matched.");
    });

    // Semantic search through the scripted embeddings: runs, returns hits,
    // and is stable across identical queries.
    const embedBefore = (await provider.state()).embedding_calls;
    let semanticTop = "";
    for (let pass = 0; pass < 2; pass += 1) {
      await searchOnce(async (panel) => {
        await panel.getByRole("radio", { name: "Semantic", exact: true }).check();
        await withQuery(panel, "enterprise hosting agreement renewal price");
        const top = await panel.locator("li button").first().innerText();
        if (pass === 0) semanticTop = top;
        else assert(top === semanticTop && top.length > 0, "SEMANTIC_UNSTABLE");
      });
    }
    const embedAfter = (await provider.state()).embedding_calls;
    assert(embedAfter - embedBefore >= 2, "SEMANTIC_EMBED_COUNT", `${embedAfter - embedBefore}`);
    checks.search = { keyword: true, semantic: "stable", rtf_absent: true, embed_calls: embedAfter - embedBefore };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P3: attach the library to a chat and freeze its evidence ---------- */
    await manageCard.getByRole("button", { name: "Manage", exact: true }).click();
    const manage1 = session.page.getByRole("dialog", { name: LIBRARY_NAME }).first();
    await manage1.getByRole("button", { name: "Attach to new chat", exact: true }).click();
    await session.page.getByLabel("Ask Borealis about your data").waitFor({ timeout: 20_000 });
    await expectText(session, `${supported.length} sources`, 15_000);
    const attached = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/chats", { expectStatus: 200 });
        const chat = (res.body?.items ?? [])[0];
        if (!chat) return null;
        const detail = (await session.apiFetch(`/api/chats/${chat.id}`, { expectStatus: 200 })).body;
        return (detail.sources ?? []).length === supported.length ? detail : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    );
    assert(attached !== null, "CHAT_SCOPE_NOT_ATTACHED");
    const chatId = attached.id;
    const chatScopeIds = JSON.stringify((attached.sources ?? []).map((s) => s.id).sort());

    await provider.setScript({
      steps: [
        {
          type: "tool_call",
          id: "call_d_retrieve",
          name_pieces: ["retrieve"],
          argument_pieces: ['{"query": ', JSON.stringify("21000 EUR enterprise hosting renewal") + "}"],
        },
        {
          type: "text",
          pieces: [
            "The CedarCloud agreements carry the enterprise price [1]. Living-corpus answer frozen for refresh checks. ",
            ANSWER_D,
          ],
        },
      ],
      onExhausted: "repeat-last",
    });
    await session.page
      .getByLabel("Ask Borealis about your data")
      .fill("What does the CedarCloud enterprise agreement cost?");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, ANSWER_D, 120_000);
    const frozenAssistant = await pollUntil(
      async () => {
        const detail = (await session.apiFetch(`/api/chats/${chatId}`, { expectStatus: 200 })).body;
        return (detail.messages ?? []).find((m) => m.role === "assistant" && (m.meta?.evidence ?? []).length > 0) ?? null;
      },
      { deadlineMs: 30_000, intervalMs: 300 }
    );
    assert(frozenAssistant !== null, "EVIDENCE_NOT_PERSISTED");
    const frozenEvidence = frozenAssistant.meta.evidence;
    const frozenCitations = frozenAssistant.meta.citations ?? [];
    assert(frozenEvidence.length > 0 && frozenCitations.some((c) => c.n === 1), "CITATION_NOT_RESOLVED");
    const frozenJson = JSON.stringify({ evidence: frozenEvidence, citations: frozenCitations });
    const citedChunk = frozenCitations.find((c) => c.n === 1);
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P4: WebDAV knowledge connection through the real UI --------------- */
    await goHash(session, "/libraries");
    await expectText(session, "New library");
    const knowledge = session.page.locator('section[aria-label="Knowledge connections"]');
    await knowledge.getByRole("button", { name: "WebDAV", exact: true }).click();
    const webdavDialog = session.page.getByRole("dialog", { name: "New WebDAV collection" }).first();
    await webdavDialog.getByLabel("Connection name").fill(CONNECTION_NAME);
    await webdavDialog.getByLabel("Collection URL").fill(`${webdav.ready.origin}/`);
    await webdavDialog.getByLabel("Username").fill(WEBDAV_USER);
    await webdavDialog.getByLabel("Application password").fill(webdavWrongPass);
    await webdavDialog.getByRole("button", { name: "Create connection", exact: true }).click();
    const connCard = knowledge.locator("div.p-4").filter({ hasText: CONNECTION_NAME }).first();
    await connCard.waitFor({ timeout: 15_000 });
    await expectIn(connCard, "Not tested yet");
    artifacts.push(await session.screenshot(artifactsDir));

    // Bad credentials first: the preview scan fails honestly and the row
    // lands in the actionable reconnect state (the badge re-renders when the
    // panel re-fetches on remount).
    await connCard.getByRole("button", { name: "Preview", exact: true }).click();
    const previewBad = session.page.getByRole("dialog", { name: `Preview — ${CONNECTION_NAME}` }).first();
    await expectIn(previewBad, /The scan failed \(KNOWLEDGE_UPSTREAM_UNAUTHORIZED\)/, 30_000);
    artifacts.push(await session.screenshot(artifactsDir));
    await closeDialogs(session);
    await goHash(session, "/chat");
    await goHash(session, "/libraries");
    await expectText(session, "New library");
    await expectIn(
      knowledge.locator("div.p-4").filter({ hasText: CONNECTION_NAME }).first(),
      "Credentials rejected — replace the application password"
    );

    const connRow = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/knowledge-connections", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.name === CONNECTION_NAME) ?? null;
      },
      { deadlineMs: 10_000, intervalMs: 200 }
    );
    assert(
      connRow.status === "disconnected" && connRow.status_code === "KNOWLEDGE_UPSTREAM_UNAUTHORIZED",
      "BAD_CRED_STATE",
      JSON.stringify({ s: connRow.status, c: connRow.status_code })
    );
    await session.apiFetch(`/api/knowledge-connections/${connRow.id}`, {
      method: "PATCH",
      body: { credentials: { password: webdavPass }, expected_revision: connRow.revision },
      expectStatus: 200,
    });

    /* -- P5: preview diff (unsupported + skipped reported), then apply ----- */
    await connCard.getByRole("button", { name: "Preview", exact: true }).click();
    const preview1 = session.page.getByRole("dialog", { name: `Preview — ${CONNECTION_NAME}` }).first();
    await expectIn(preview1, /4 new/, 30_000);
    await expectIn(preview1, /1 unsupported/);
    await expectIn(preview1, /1 skipped/);
    for (const rel of ["d1.md", "d2.md", "d3.md", "sub/readme.md"]) {
      assert((await preview1.getByLabel(`Select ${rel}`).count()) === 1, "PREVIEW_ENTRY_MISSING", rel);
    }
    await expectIn(preview1, "Unsupported");
    artifacts.push(await session.screenshot(artifactsDir));
    await preview1.getByLabel("Select d1.md").check();
    await preview1.getByLabel("Select d2.md").check();
    await preview1.getByLabel("Select d3.md").check();
    await preview1.getByLabel("Select sub/readme.md").check();
    await preview1.getByRole("button", { name: /Import selected \(4\)/ }).click();
    const libraryReady13 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 });
        const members = res.body?.members ?? [];
        if (members.length !== supported.length + 4) return null;
        return members.every((m) => m.status === "ready") ? members : null;
      },
      { deadlineMs: 150_000, intervalMs: 400 }
    );
    assert(libraryReady13 !== null, "APPLY_MEMBERS_NOT_READY");
    checks.webdav_apply = { members: libraryReady13.length };

    /* -- P6: edit/remove via the fixture transport, refresh, lifecycle ------ */
    // A readable passage for the served file BEFORE the edit (UI + API).
    await searchOnce(async (panel) => {
      await withQuery(panel, D1_TOKEN);
      await expectIn(panel, /1 hit/);
      await panel.getByRole("button", { name: "Open passage" }).first().click();
      await expectIn(panel, /Passage — /);
      await expectIn(panel, /text chars \d+–\d+/);
      artifacts.push(await session.screenshot(artifactsDir));
    });

    const d1Member = libraryReady13.find((m) => (m.display_name || m.name) === "d1.md");
    assert(d1Member, "D1_MEMBER_MISSING");
    const d1GenerationBefore = d1Member.ready_generation;
    const d1Search = await session.apiFetch(`/api/libraries/${library.id}/search`, {
      method: "POST",
      body: { query: D1_TOKEN, mode: "keyword" },
      expectStatus: 200,
    });
    assert(d1Search.body?.hits?.length === 1, "D1_SINGLE_HIT");
    const d1ChunkId = d1Search.body.hits[0].chunk_id;

    // Edit d1, add a nested file (MKCOL proves the collection-write path),
    // duplicate d3 under a new path, then remove d2 and d3 upstream.
    await davRequest(webdav.ready.origin, "MKCOL", "/sub", {
      user: WEBDAV_USER,
      password: webdavPass,
    }).catch(() => undefined); // `sub` exists from seeding; MKCOL 405 is fine here
    await davRequest(webdav.ready.origin, "PUT", "/d1.md", {
      user: WEBDAV_USER,
      password: webdavPass,
      body: `# CedarNorth ridge notes\nHosting renewal window 2026-06.\nCedar token ${D1_EDITED_TOKEN}.\n`,
      expectStatus: 204,
      headers: { "Content-Type": "text/markdown" },
    });
    await davRequest(webdav.ready.origin, "PUT", "/sub/delta.md", {
      user: WEBDAV_USER,
      password: webdavPass,
      body: `# Delta addendum\nDelta token ${D4_TOKEN}.\n`,
      expectStatus: 201,
      headers: { "Content-Type": "text/markdown" },
    });
    await davRequest(webdav.ready.origin, "PUT", "/d3renamed.md", {
      user: WEBDAV_USER,
      password: webdavPass,
      body: `# BlueRiver notes\nBlueRiver token ${D3_TOKEN}.\n`,
      expectStatus: 201,
      headers: { "Content-Type": "text/markdown" },
    });
    await davRequest(webdav.ready.origin, "DELETE", "/d3.md", { user: WEBDAV_USER, password: webdavPass, expectStatus: 204 });
    await davRequest(webdav.ready.origin, "DELETE", "/d2.md", { user: WEBDAV_USER, password: webdavPass, expectStatus: 204 });

    // UI Refresh: the durable run reports the mixed outcome. (Remount the
    // panel first: the apply flow snapshots the apply-refresh status once, so
    // the row's transient "Refreshing" affordance needs a fresh fetch.)
    await goHash(session, "/chat");
    await goHash(session, "/libraries");
    await expectText(session, "New library");
    await connCard.getByRole("button", { name: "Refresh", exact: true }).click();
    await pollUntil(
      async () => (await knowledge.getByText(/Refresh for this connection: (Partial|Completed)/).count()) > 0,
      { deadlineMs: 90_000, intervalMs: 500 }
    ).then((seen) => assert(seen === true, "REFRESH_TERMINAL"));
    const refreshes1 = (await session.apiFetch(`/api/knowledge-connections/${connRow.id}/refreshes`, { expectStatus: 200 })).body;
    const manualRefresh = (refreshes1.items ?? [])[0];
    assert(manualRefresh?.requested_by === "manual", "MANUAL_REFRESH_RECORDED");
    const refreshDetail = (await session.apiFetch(`/api/knowledge-refreshes/${manualRefresh.id}`, { expectStatus: 200 })).body;
    const itemByPath = Object.fromEntries((refreshDetail.items ?? []).map((item) => [item.relative_path, item]));
    assert(itemByPath["d1.md"]?.status === "ready", "D1_REFRESH_STATUS", String(itemByPath["d1.md"]?.status));
    assert(
      itemByPath["d1.md"].source_id === d1Member.id &&
        itemByPath["d1.md"].promoted_generation === itemByPath["d1.md"].current_ready_generation + 1 &&
        itemByPath["d1.md"].current_ready_generation === d1GenerationBefore,
      "D1_SAME_SOURCE_NEW_GENERATION",
      JSON.stringify(itemByPath["d1.md"])
    );
    assert(itemByPath["d2.md"]?.status === "missing", "D2_MISSING_STATUS");
    assert(itemByPath["d3.md"]?.status === "missing", "D3_MISSING_STATUS");
    artifacts.push(await session.screenshot(artifactsDir));

    // `missing_upstream` keeps the stale sources ready in the library.
    const membersAfterMissing = (await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 })).body;
    assert(membersAfterMissing.members?.length === supported.length + 4, "MISSING_MEMBERS_DROPPED");
    const keptD2 = membersAfterMissing.members.find((m) => (m.display_name || m.name) === "d2.md");
    assert(keptD2?.status === "ready", "MISSING_STALE_SOURCE_UNREADY");

    // The pre-edit chunk honestly reports unavailable navigation, while the
    // edited content becomes searchable.
    session.allowStatuses([404, 410]);
    const stalePassage = await session.apiFetch(`/api/sources/${d1Member.id}/passages/${d1ChunkId}`);
    assert(stalePassage.status === 410 || stalePassage.status === 404, "STALE_CHUNK_STATUS", String(stalePassage.status));
    await searchOnce(async (panel) => {
      await withQuery(panel, D1_EDITED_TOKEN);
      await expectIn(panel, /1 hit/);
    });
    checks.refresh_lifecycle = {
      d1: "same source, new generation",
      d2_d3: "missing_upstream, stale retained",
      stale_chunk: stalePassage.status,
    };

    /* -- P7: same-path replacement reuses the removed source ---------------- */
    await davRequest(webdav.ready.origin, "PUT", "/d2.md", {
      user: WEBDAV_USER,
      password: webdavPass,
      body: `# Everline notes\nEverline token ${D2_REVIVE_TOKEN}.\n`,
      expectStatus: 201,
      headers: { "Content-Type": "text/markdown" },
    });
    const connList = (await session.apiFetch("/api/knowledge-connections", { expectStatus: 200 })).body;
    const connNow = (connList.items ?? []).find((item) => item.id === connRow.id);
    assert(connNow, "CONNECTION_ROW_MISSING_P7");
    const started = await session.apiFetch(`/api/knowledge-connections/${connRow.id}/refreshes`, {
      method: "POST",
      body: { expected_connection_revision: connNow.revision },
      expectStatus: 202,
    });
    const reviveDetail = await pollUntil(
      async () => {
        const detail = (await session.apiFetch(`/api/knowledge-refreshes/${started.body.refresh.id}`, { expectStatus: 200 })).body;
        if (detail.refresh?.status === "active") return null;
        const d2 = (detail.items ?? []).find((item) => item.relative_path === "d2.md");
        return d2 && d2.status === "ready" ? detail : null;
      },
      { deadlineMs: 120_000, intervalMs: 400 }
    );
    assert(reviveDetail !== null, "D2_SAME_PATH_REPLACEMENT");
    const d2Item = reviveDetail.items.find((item) => item.relative_path === "d2.md");
    const d2Member = membersAfterMissing.members.find((m) => (m.display_name || m.name) === "d2.md");
    assert(
      d2Item.source_id === d2Member.id && d2Item.promoted_generation > d2Item.current_ready_generation,
      "D2_SOURCE_NOT_REUSED",
      JSON.stringify(d2Item)
    );
    checks.same_path_replacement = { source_reused: true, generation: d2Item.promoted_generation };

    /* -- P8: second preview/apply picks up nested new + duplicate ---------- */
    await connCard.getByRole("button", { name: "Preview", exact: true }).click();
    const preview2 = session.page.getByRole("dialog", { name: `Preview — ${CONNECTION_NAME}` }).first();
    // The renamed copy classifies New (duplicate pairing is not made against
    // a `missing_upstream` managed identity).
    await expectIn(preview2, /2 new/, 30_000);
    await expectIn(preview2, /1 missing/);
    await preview2.getByLabel("Select sub/delta.md").check();
    await preview2.getByLabel("Select d3renamed.md").check();
    await preview2.getByRole("button", { name: /Import selected \(2\)/ }).click();
    const membersFinal = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 });
        const members = res.body?.members ?? [];
        if (members.length !== supported.length + 6) return null;
        return members.every((m) => m.status === "ready") ? members : null;
      },
      { deadlineMs: 150_000, intervalMs: 400 }
    );
    assert(membersFinal !== null, "FINAL_MEMBERS_NOT_READY");
    checks.final_library = { members: membersFinal.length };

    await searchOnce(async (panel) => {
      await withQuery(panel, D4_TOKEN);
      await expectIn(panel, /1 hit/);
    });
    await searchOnce(async (panel) => {
      await withQuery(panel, "4600");
      await expectIn(panel, "No indexed passages matched.");
    });

    /* -- P9: earlier answer frozen; chat scope byte-unchanged -------------- */
    await goHash(session, `/chat/${chatId}`);
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await expectText(session, ANSWER_D, 30_000);
    const afterChat = (await session.apiFetch(`/api/chats/${chatId}`, { expectStatus: 200 })).body;
    const afterAssistant = (afterChat.messages ?? []).find(
      (m) => m.role === "assistant" && (m.meta?.evidence ?? []).length > 0
    );
    assert(afterAssistant !== undefined, "FROZEN_ANSWER_LOST");
    assert(
      JSON.stringify({ evidence: afterAssistant.meta.evidence, citations: afterAssistant.meta.citations ?? [] }) ===
        frozenJson,
      "EVIDENCE_NOT_FROZEN"
    );
    const chatScopeAfter = JSON.stringify((afterChat.sources ?? []).map((s) => s.id).sort());
    assert(chatScopeAfter === chatScopeIds, "CHAT_SCOPE_DRIFTED");
    // The cited passage (a corpus document the refresh never touched) is
    // still readable with its typed locator.
    const citedPassage = await session.apiFetch(`/api/sources/${citedChunk.source_id}/passages/${citedChunk.chunk_id}`, {
      expectStatus: 200,
    });
    assert((citedPassage.body?.chunk?.locators ?? []).length > 0, "CITED_LOCATOR_MISSING");
    // And the frozen excerpt is visible in the chat's evidence panel.
    await session.page.getByRole("button", { name: /^Citation 1/ }).first().click();
    await expectText(session, "These passages were retrieved");
    const excerptVisible = await session.page
      .getByText(frozenEvidence[0].excerpt.slice(0, 40))
      .first()
      .isVisible()
      .catch(() => false);
    assert(excerptVisible === true, "FROZEN_EXCERPT_NOT_VISIBLE");
    artifacts.push(await session.screenshot(artifactsDir));
    checks.frozen_answer = "excerpt + citations byte-identical; locator readable; scope unchanged";

    /* -- P10: the WebDAV password never leaks ------------------------------ */
    const connDtoJson = JSON.stringify(await session.apiFetch("/api/knowledge-connections", { expectStatus: 200 }));
    const connDetailJson = JSON.stringify(await session.apiFetch("/api/knowledge-connections", { expectStatus: 200 }));
    for (const surface of [connDtoJson, connDetailJson]) {
      assert(!surface.includes(webdavPass) && !surface.includes(webdavWrongPass), "DTO_PASSWORD_LEAK");
    }
    const pageText = await session.page.evaluate(() => document.body.innerText);
    assert(!pageText.includes(webdavPass), "PAGE_PASSWORD_LEAK");
    const filesScanned = scanForBytes(workspace.workspaceDir, webdavPass) + scanForBytes(workspace.logsDir, webdavPass);
    checks.password_scan = { files: filesScanned, clean: true };

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
