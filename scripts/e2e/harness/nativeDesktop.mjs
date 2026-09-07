/**
 * Driver-assisted native acceptance. The external operator uses normal OS UI
 * automation (for example CUA); this module never attaches CDP, injects a
 * preload, mutates the ledger, or weakens the packaged application.
 *
 * Each request has a fresh nonce and the exact live PID/profile/bundle hash.
 * A bounded, private response attests actual UI observations; independent
 * read-only queries verify the same bootstrap account's durable state. This
 * is an operator-assisted gate, not an unattended claim of native UI coverage.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { expectedAnalysisRows } from "../fixtures/lib/finance-expected.mjs";
import { assert, HarnessError, pidAlive, sleep } from "./util.mjs";
import { launchFixture } from "./providers.mjs";

export const NATIVE_CHECKPOINTS = Object.freeze({
  A: [
    [
      "connections",
      "In Settings > Connections create and discover a stdio fixture and the OAuth HTTP fixture. Sign in using the app's system-browser link, observe callback success, return and Test/Discover. Observe credentials stored securely. Re-test after token expiry to exercise refresh.",
    ],
    [
      "agent",
      "Create/reopen an agent with selected discovered read-only tools and job setup; run a selected-tool chat with selected-empty sources. Disable its connection; prove the subsequent tool invocation is blocked. Reopen the agent to inspect persisted identity, skills and job setup.",
    ],
  ],
  B: [
    [
      "capture",
      "Upload the four finance CSVs through the native file chooser and select them. Run a scripted DuckDB query in chat, save its parameterized analysis using a required string month parameter default 2025-06, reopen it outside chat and run June. Use the exact native-finance.sql in the driver directory.",
    ],
    [
      "analysis",
      "Change the month parameter to 2025-05, rerun, inspect numeric comparison and export CSV/JSON. Reopen the June result unchanged; the harness compares both periods to independent raw-fixture arithmetic and checks original provenance hashes.",
    ],
  ],
  C: [
    [
      "publish",
      "In a new chat with the four finance sources selected and no agent, request the scripted June chart report. In Reports choose Create editable copy, publish its first version and inspect its table, chart and provenance. The harness freezes the first publication bytes.",
    ],
    [
      "document",
      "Edit narrative, request/apply a selected-section rewrite, publish a second version and reopen the old version unchanged. Export HTML/PDF/Markdown/DOCX to the session exports directory; inspect revision-bound evidence/charts and stale edit behavior. The shared payload-less legacy UI is covered separately by browser journey C.",
    ],
  ],
  D: [
    [
      "folder",
      "Create a library and folder connection using the real native folder chooser, selecting fixture_folder. Preview and import notes.md; wait for Ready. Enable Watch. Observe selected-empty chat membership remains unchanged.",
    ],
    [
      "watch",
      "The harness has edited notes.md after watch was enabled. Without clicking Refresh, observe the new ready generation; inspect source keyword/semantic search and section details. Capture a real cited chat answer with only notes.md selected. Preview a temporary upstream rename/removal without importing a duplicate, restore its original name, and verify source retention and the captured citation.",
    ],
    [
      "permission",
      "The harness removed read access only from the owned notes.md fixture. Open this folder connection's Preview through the native UI. Require the visible instruction: Restore read access to the folder and its files, then retry. Confirm nothing was imported and the prior source and citation remain. Leave permissions unchanged until this checkpoint passes; the read-only guard requires KNOWLEDGE_FILE_UNREADABLE in the exact watched connection and failed preview.",
    ],
    [
      "retry",
      "The harness restored read access to the owned notes.md fixture. Retry Preview through the native UI, require a successful unchanged-file scan and cleared permission status, then reopen the prior source/citation unchanged. Do not reselect the folder or replace the source to hide a recovery failure.",
    ],
    [
      "webdav",
      "Connect the authenticated WebDAV fixture in Libraries, preview and import its source, then refresh and inspect history. Verify its credential is stored securely by the packaged safeStorage custody path.",
    ],
  ],
  E: [
    [
      "research",
      "Import the ten-document supplier corpus, exercise the unsupported-file case, and select all nine ready supported documents. Create research, edit its question plan, inspect evidence/conflicts/gaps, generate five typed comparison columns, inspect machine cells and evidence. Compare facts to the supplier expected fixture.",
    ],
    [
      "rerun",
      "Correct/review a cell, cancel/resume/reload as specified, rerun and export memo/table. Confirm the reviewed correction survives and original machine outputs remain frozen.",
    ],
  ],
  F: [
    [
      "approve",
      "Create a weekly Europe/Berlin recipe using selected inputs and a saved analysis. Enable local change notifications, run through readiness/analysis/comparison into Reviews, approve one draft. The harness freezes the immutable review decision.",
    ],
    [
      "brief",
      "Run another draft and reject it. Inspect immutable history and the content-minimal notification inbox, mark/dismiss a notification, and confirm no external delivery.",
    ],
  ],
});

function openLedger(repoRoot, profileDir) {
  const require = createRequire(path.join(repoRoot, "server", "package.json"));
  const Database = require("better-sqlite3");
  return new Database(path.join(profileDir, "borealis.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
}

function nativeWatchedRefresh(repoRoot, profileDir, refreshId) {
  const db = openLedger(repoRoot, profileDir);
  try {
    return db
      .prepare(
        `SELECT r.id, r.status, r.requested_by, r.finished_at, c.watch_enabled,
        (SELECT count(*) FROM knowledge_refreshes a WHERE a.account_id=r.account_id AND a.status='active') AS active_refreshes
       FROM knowledge_refreshes r JOIN knowledge_connections c ON c.id=r.connection_id AND c.account_id=r.account_id
       JOIN users u ON u.id=r.account_id
       WHERE u.email='local@borealis.app' AND c.kind='desktop_folder'
         AND ${refreshId ? "r.id = ?" : "r.status='active' AND r.requested_by='scheduled' AND c.watch_enabled=1"}
       ORDER BY r.created_at DESC LIMIT 1`,
      )
      .get(...(refreshId ? [refreshId] : []));
  } finally {
    db.close();
  }
}

export function validateNativeWatchedQuit(observation, finalState, exitedAt) {
  assert(
    observation &&
      exitedAt >= observation.observedAt &&
      exitedAt - observation.observedAt <= 30_000,
    "NATIVE_QUIT_ACTIVE_WATCH_NOT_OBSERVED",
  );
  assert(
    finalState &&
      finalState.id === observation.id &&
      finalState.requested_by === "scheduled" &&
      finalState.watch_enabled === 1 &&
      finalState.status === "cancelled" &&
      typeof finalState.finished_at === "string" &&
      finalState.active_refreshes === 0,
    "NATIVE_QUIT_WATCH_NOT_FINALIZED",
  );
}

/** Expiry is a failed fixture hold, never evidence of shutdown cancellation. */
export function nativeEmbeddingHoldActive(state) {
  assert(
    state.embedding_hold === true && state.embedding_hold_expired === 0,
    "NATIVE_EMBEDDING_HOLD_EXPIRED_OR_DISABLED",
  );
  return state.embedding_held > 0 && state.embedding_active >= state.embedding_held;
}

/** Content-free counts, all restricted to the native bootstrap account. */
export function nativeState(repoRoot, profileDir) {
  const db = openLedger(repoRoot, profileDir);
  try {
    const user = db
      .prepare("SELECT id FROM users WHERE email = 'local@borealis.app'")
      .get();
    assert(user, "NATIVE_BOOTSTRAP_ACCOUNT_MISSING");
    const count = (table, clause = "1") =>
      db
        .prepare(
          `SELECT count(*) AS n FROM ${table} WHERE account_id = ? AND (${clause})`,
        )
        .get(user.id).n;
    return {
      bootstrap: true,
      connections: count("connections", "discovery_revision > 0"),
      stdio: count(
        "connections",
        "kind = 'mcp_stdio' AND discovery_revision > 0",
      ),
      http: count(
        "connections",
        "kind = 'mcp_http' AND discovery_revision > 0",
      ),
      disabled: count("connections", "enabled = 0"),
      agents: count("agents"),
      mcp_runs: count(
        "chat_runs",
        "status = 'completed' AND agent_mcp_tools IS NOT NULL AND json_array_length(agent_mcp_tools) > 0",
      ),
      ready_sources: count("sources", "status = 'ready'"),
      analyses: count("analyses"),
      analysis_runs: count("analysis_runs", "status = 'succeeded'"),
      documents: count("documents", "current_revision >= 3"),
      rewrites: count("document_rewrites", "applied_revision_id IS NOT NULL"),
      publications: count("document_publications"),
      folder_changed: db
        .prepare(
          "SELECT count(*) AS n FROM knowledge_items i JOIN knowledge_connections c ON c.id = i.connection_id AND c.account_id = i.account_id JOIN sources s ON s.id = i.source_id AND s.account_id = i.account_id WHERE i.account_id = ? AND c.kind = 'desktop_folder' AND i.ingested_hash = ? AND s.status = 'ready'",
        )
        .get(
          user.id,
          createHash("sha256")
            .update("# Native folder fixture\nNATIVE_FOLDER_CHANGED_260907.\n")
            .digest("hex"),
        ).n,
      folders: count(
        "knowledge_connections",
        "kind = 'desktop_folder' AND status = 'ready' AND watch_enabled = 1",
      ),
      webdav: count(
        "knowledge_connections",
        "kind = 'webdav' AND status = 'ready' AND credential_configured = 1",
      ),
      refreshes: count("knowledge_refreshes", "status = 'completed'"),
      folder_permission_blocked: count(
        "knowledge_connections",
        "kind='desktop_folder' AND watch_enabled=1 AND status_code='KNOWLEDGE_FILE_UNREADABLE'",
      ),
      folder_permission_previews: db
        .prepare(
          "SELECT count(*) n FROM knowledge_previews p JOIN knowledge_connections c ON c.id=p.connection_id AND c.account_id=p.account_id WHERE p.account_id=? AND c.kind='desktop_folder' AND c.watch_enabled=1 AND p.status='failed' AND p.error_code='KNOWLEDGE_FILE_UNREADABLE'",
        )
        .get(user.id).n,
      folder_complete_previews: db
        .prepare(
          "SELECT count(*) n FROM knowledge_previews p JOIN knowledge_connections c ON c.id=p.connection_id AND c.account_id=p.account_id WHERE p.account_id=? AND c.kind='desktop_folder' AND c.watch_enabled=1 AND p.status='complete' AND p.error_code IS NULL",
        )
        .get(user.id).n,
      watched_source_hash: createHash("sha256")
        .update(
          JSON.stringify(
            db
              .prepare(
                "SELECT i.source_id,i.ingested_hash,s.ready_generation,s.status FROM knowledge_items i JOIN knowledge_connections c ON c.id=i.connection_id AND c.account_id=i.account_id JOIN sources s ON s.id=i.source_id AND s.account_id=i.account_id WHERE i.account_id=? AND c.kind='desktop_folder' AND c.watch_enabled=1 ORDER BY i.id",
              )
              .all(user.id),
          ),
        )
        .digest("hex"),
      captured_note_answers: db
        .prepare(
          "SELECT count(DISTINCT m.id) n FROM messages m JOIN chats chat ON chat.id=m.chat_id JOIN json_each(m.meta,'$.evidence') e JOIN knowledge_items i ON i.source_id=json_extract(e.value,'$.source_id') AND i.account_id=chat.account_id JOIN knowledge_connections c ON c.id=i.connection_id AND c.account_id=i.account_id WHERE chat.account_id=? AND m.role='assistant' AND c.kind='desktop_folder' AND c.watch_enabled=1",
        )
        .get(user.id).n,
      research_runs: count(
        "research_runs",
        "status IN ('completed','needs_review')",
      ),
      corrections: count("research_table_cells", "origin = 'correction'"),
      inherited_corrections: db
        .prepare(
          "SELECT count(*) AS n FROM research_table_cells c JOIN research_runs r ON r.id=c.run_id AND r.account_id=c.account_id JOIN research_table_cells prior ON prior.run_id=c.corrected_from_run_id AND prior.account_id=c.account_id AND prior.column_id=c.column_id AND prior.row_source_id=c.row_source_id AND prior.row_generation=c.row_generation AND prior.origin='correction' WHERE c.account_id=? AND c.origin='correction' AND r.rerun_of=c.corrected_from_run_id AND r.status IN ('completed','needs_review') AND c.value IS prior.value AND c.status=prior.status AND c.evidence_refs=prior.evidence_refs",
        )
        .get(user.id).n,
      research_comparisons: db
        .prepare(
          "SELECT count(*) AS n FROM research_runs r WHERE r.account_id=? AND r.status IN ('completed','needs_review') AND json_array_length(r.sources)=9 AND (SELECT count(DISTINCT c.column_id) FROM research_table_cells c WHERE c.run_id=r.id AND c.account_id=r.account_id AND c.origin='machine')=5",
        )
        .get(user.id).n,
      scheduled_recipes: count(
        "brief_recipes",
        "schedule_kind='weekly' AND time_zone='Europe/Berlin' AND notifications_enabled=1",
      ),
      approved: count("brief_runs", "stage = 'approved'"),
      rejected: count("brief_runs", "stage = 'rejected'"),
      notifications: count(
        "brief_notifications",
        "state IN ('read','dismissed')",
      ),
      custody: fs.existsSync(
        path.join(profileDir, "connection-custody", "sealed-key.bin"),
      ),
      browser_custody_absent: !fs.existsSync(
        path.join(profileDir, "connections.key"),
      ),
    };
  } finally {
    db.close();
  }
}

export function nativePublicationFile(profileDir, row, extension) {
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const attempt = path.basename(path.dirname(row.html_path));
  assert(
    [row.account_id, row.document_id, attempt].every(
      (value) => typeof value === "string" && uuid.test(value),
    ),
    "NATIVE_PUBLICATION_ID_INVALID",
  );
  assert(
    ["html", "pdf", "zip", "docx"].includes(extension),
    "NATIVE_PUBLICATION_EXTENSION_INVALID",
  );
  const directory = path.join(
    profileDir,
    "reports",
    "documents",
    row.account_id,
    row.document_id,
    attempt,
  );
  assert(
    row.html_path === path.join(directory, "document.html") &&
      row.pdf_path === path.join(directory, "document.pdf"),
    "NATIVE_PUBLICATION_PATH_INVALID",
  );
  let current = profileDir;
  for (const segment of [
    "",
    "reports",
    "documents",
    row.account_id,
    row.document_id,
    attempt,
  ]) {
    if (segment) current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        fs.realpathSync(current) === current,
      "NATIVE_PUBLICATION_DIRECTORY_UNSAFE",
    );
  }
  const file = path.join(directory, `document.${extension}`);
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= 32 * 1024 * 1024 &&
      fs.realpathSync(file) === file,
    "NATIVE_PUBLICATION_FILE_UNSAFE",
  );
  return file;
}

function latestNativePublication(repoRoot, profileDir, documentId) {
  const db = openLedger(repoRoot, profileDir);
  try {
    const account = db
      .prepare("SELECT id FROM users WHERE email = 'local@borealis.app'")
      .get().id;
    const row = documentId
      ? db
          .prepare(
            "SELECT p.*, d.origin_analysis_result_id, d.origin_report_id FROM document_publications p JOIN documents d ON d.id=p.document_id AND d.account_id=p.account_id WHERE p.account_id=? AND p.document_id=? ORDER BY p.version DESC LIMIT 1",
          )
          .get(account, documentId)
      : db
          .prepare(
            "SELECT p.*, d.origin_analysis_result_id, d.origin_report_id FROM document_publications p JOIN documents d ON d.id=p.document_id AND d.account_id=p.account_id WHERE p.account_id=? ORDER BY p.created_at DESC, p.id DESC LIMIT 1",
          )
          .get(account);
    assert(
      row && (row.origin_analysis_result_id || row.origin_report_id),
      "NATIVE_PUBLICATION_LINEAGE_MISSING",
    );
    if (row.origin_report_id) {
      const report = db
        .prepare(
          "SELECT payload FROM reports WHERE id=? AND account_id=? AND status='published'",
        )
        .get(row.origin_report_id, account);
      assert(report?.payload, "NATIVE_PUBLICATION_REPORT_LINEAGE_MISSING");
      const revision = db
        .prepare(
          "SELECT payload FROM document_revisions WHERE id=? AND account_id=?",
        )
        .get(row.revision_id, account);
      const tree = JSON.parse(revision.payload);
      const expected = expectedAnalysisRows(
        fs.readFileSync(
          path.join(repoRoot, "data", "sample", "transactions.csv"),
          "utf8",
        ),
        "2025-06",
      ).map((values) => [values[1], values[2], values[3]]);
      assert(
        tree.charts.length >= 1 &&
          tree.tables.some(
            (table) => JSON.stringify(table.rows) === JSON.stringify(expected),
          ),
        "NATIVE_PUBLICATION_FINANCE_CONTENT_MISSING",
      );
    }
    return row;
  } finally {
    db.close();
  }
}

function immutableState(repoRoot, profileDir) {
  const db = openLedger(repoRoot, profileDir);
  try {
    const account = db
      .prepare("SELECT id FROM users WHERE email = 'local@borealis.app'")
      .get().id;
    const snapshot = {};
    for (const row of db
      .prepare(
        "SELECT m.id,m.content,m.meta FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.account_id=? AND m.role='assistant' AND json_array_length(m.meta,'$.evidence')>0",
      )
      .all(account)) {
      snapshot[`captured_chat:${row.id}`] = createHash("sha256")
        .update(JSON.stringify(row))
        .digest("hex");
    }
    for (const table of [
      "analysis_results",
      "document_revisions",
      "document_publications",
      "brief_review_events",
    ]) {
      for (const row of db
        .prepare(`SELECT * FROM ${table} WHERE account_id = ?`)
        .all(account)) {
        snapshot[`${table}:${row.id}`] = createHash("sha256")
          .update(JSON.stringify(row))
          .digest("hex");
        if (table === "document_publications") {
          for (const field of ["html_path", "pdf_path"]) {
            nativePublicationFile(
              profileDir,
              row,
              field === "html_path" ? "html" : "pdf",
            );
            snapshot[`${table}:${row.id}:${field}`] = createHash("sha256")
              .update(fs.readFileSync(row[field]))
              .digest("hex");
          }
        }
      }
    }
    for (const row of db
      .prepare(
        "SELECT * FROM research_table_cells WHERE account_id = ? AND origin = 'machine'",
      )
      .all(account)) {
      const key = [
        row.run_id,
        row.column_id,
        row.row_source_id,
        row.row_generation,
      ].join(":");
      snapshot[`research_machine:${key}`] = createHash("sha256")
        .update(JSON.stringify(row))
        .digest("hex");
    }
    return snapshot;
  } finally {
    db.close();
  }
}

function verifyFinanceResults(repoRoot, profileDir, requireMay) {
  const db = openLedger(repoRoot, profileDir);
  try {
    const results = db
      .prepare(
        "SELECT r.rows, r.parameter_values, r.source_provenance FROM analysis_results r JOIN users u ON u.id = r.account_id WHERE u.email = 'local@borealis.app'",
      )
      .all();
    const fixture = fs.readFileSync(
      path.join(repoRoot, "data", "sample", "transactions.csv"),
      "utf8",
    );
    for (const month of requireMay ? ["2025-06", "2025-05"] : ["2025-06"]) {
      const result = results.find((row) =>
        JSON.parse(row.parameter_values).some(
          (parameter) =>
            parameter.name === "month" && parameter.value === month,
        ),
      );
      assert(result, "NATIVE_FINANCE_PERIOD_MISSING");
      const actual = JSON.parse(result.rows);
      const expected = expectedAnalysisRows(fixture, month);
      assert(actual.length === expected.length, "NATIVE_FINANCE_ROW_COUNT");
      for (let row = 0; row < expected.length; row += 1) {
        assert(
          actual[row].length === expected[row].length,
          "NATIVE_FINANCE_COLUMN_COUNT",
        );
        for (let column = 0; column < expected[row].length; column += 1) {
          const wanted = expected[row][column];
          const observed = actual[row][column];
          assert(
            typeof wanted === "number"
              ? typeof observed === "number" &&
                  Math.abs(wanted - observed) < 0.000001
              : wanted === observed,
            "NATIVE_FINANCE_NUMERIC_MISMATCH",
          );
        }
      }
      assert(
        JSON.parse(result.source_provenance).length === 4,
        "NATIVE_FINANCE_PROVENANCE_SCOPE",
      );
    }
  } finally {
    db.close();
  }
}

export function checkNativeState(checkpoint, state, baseline) {
  const required = {
    bootstrap: state.bootstrap,
    "A.connections":
      state.stdio >= 1 &&
      state.http >= 1 &&
      state.custody &&
      state.browser_custody_absent,
    "A.agent": state.agents >= 1 && state.mcp_runs >= 1 && state.disabled >= 1,
    "B.capture":
      state.ready_sources >= 4 &&
      state.analyses >= 1 &&
      state.analysis_runs >= 1,
    "B.analysis": state.analysis_runs > baseline.analysis_runs,
    "C.publish": state.publications >= 1,
    "C.document":
      state.documents >= 1 && state.rewrites >= 1 && state.publications >= 2,
    "D.folder": state.folders >= 1 && state.ready_sources >= 1,
    "D.watch":
      state.refreshes > baseline.refreshes &&
      state.folder_changed >= 1 &&
      state.captured_note_answers >= 1,
    "D.permission":
      state.folder_permission_blocked >= 1 &&
      state.folder_permission_previews > baseline.folder_permission_previews &&
      state.watched_source_hash === baseline.watched_source_hash &&
      state.captured_note_answers >= 1,
    "D.retry":
      state.folder_permission_blocked === 0 &&
      state.folders >= 1 &&
      state.folder_complete_previews > baseline.folder_complete_previews &&
      state.watched_source_hash === baseline.watched_source_hash &&
      state.captured_note_answers >= 1,
    "D.webdav":
      state.webdav >= 1 && state.custody && state.browser_custody_absent,
    "E.research": state.research_comparisons >= 1,
    "E.rerun":
      state.research_runs > baseline.research_runs &&
      state.corrections >= 1 &&
      state.inherited_corrections > baseline.inherited_corrections,
    "F.approve": state.approved >= 1 && state.scheduled_recipes >= 1,
    "F.brief":
      state.approved >= 1 && state.rejected >= 1 && state.notifications >= 1,
  };
  assert(
    Object.hasOwn(required, checkpoint) && required[checkpoint],
    `NATIVE_STATE_UNVERIFIED:${checkpoint}`,
  );
}

function verifyNativeQuit(app) {
  assert(!pidAlive(app.pid), "NATIVE_QUIT_PID_ALIVE");
  const namespace = path.join(
    path.dirname(app.profileDir),
    `.${path.basename(app.profileDir)}.borealis-instance.lock`,
  );
  const entries = fs.existsSync(namespace) ? fs.readdirSync(namespace) : [];
  assert(
    !entries.some(
      (name) => name.startsWith("owner.") || name.startsWith(".tmp."),
    ),
    "NATIVE_QUIT_WORKSPACE_LOCK_RETAINED",
  );
  let singleton;
  try {
    singleton = fs.lstatSync(path.join(app.profileDir, "SingletonLock"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert(!singleton, "NATIVE_QUIT_PROFILE_LOCK_RETAINED");
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(
    !processes.split("\n").some((line) => line.includes(app.profileDir)),
    "NATIVE_QUIT_CHILD_PROCESS_RETAINED",
  );
}

export function validateNativeResponse(response, request) {
  assert(response && typeof response === "object", "NATIVE_RESPONSE_INVALID");
  for (const key of [
    "nonce",
    "checkpoint",
    "pid",
    "profile",
    "package_sha256",
  ]) {
    assert(response[key] === request[key], "NATIVE_RESPONSE_IDENTITY_MISMATCH");
  }
  assert(
    response.status === "pass" ||
      response.status === "blocked" ||
      response.status === "fail",
    "NATIVE_RESPONSE_STATUS_INVALID",
  );
  assert(
    ["cua_repl", "manual-native-ui", "macos-accessibility"].includes(
      response.driver,
    ),
    "NATIVE_RESPONSE_DRIVER_MISSING",
  );
  assert(
    Array.isArray(response.observations) &&
      response.observations.length >= 1 &&
      response.observations.length <= 30 &&
      response.observations.every(
        (item) =>
          typeof item === "string" && item.length >= 12 && item.length <= 1000,
      ),
    "NATIVE_RESPONSE_OBSERVATIONS_MISSING",
  );
  if (response.status !== "pass")
    throw new HarnessError(
      `NATIVE_DRIVER_${response.status.toUpperCase()}:${request.checkpoint}`,
    );
  if (request.checkpoint === "D.permission") {
    assert(
      response.observations.some((observation) =>
        observation.includes(
          "Restore read access to the folder and its files, then retry.",
        ),
      ),
      "NATIVE_PERMISSION_GUIDANCE_UNVERIFIED",
    );
  }
}

/** Manual CRC32 (ZIP member integrity), independent of runtime version. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * Minimal strict ZIP central-directory reader: name → bytes, with CRC and
 * size verification per member (stored or deflate). Shared by the Markdown
 * ZIP and the DOCX/OOXML assertions; malformed archives fail loudly.
 */
function readZip(buffer, code) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, `${code}_ZIP_EOCD_MISSING`);
  const count = buffer.readUInt16LE(eocd + 10);
  assert(count > 0 && count < 512, `${code}_ZIP_MEMBER_COUNT`, String(count));
  const members = new Map();
  let p = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    assert(
      buffer.readUInt32LE(p) === 0x02014b50,
      `${code}_ZIP_CENTRAL_MALFORMED`,
    );
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const csize = buffer.readUInt32LE(p + 20);
    const usize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    assert(
      buffer.readUInt32LE(localOff) === 0x04034b50,
      `${code}_ZIP_LOCAL_MALFORMED`,
      name,
    );
    const localNameLen = buffer.readUInt16LE(localOff + 26);
    const localExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8)
      data = Buffer.from(
        inflateRawSync(raw, { maxOutputLength: 32 * 1024 * 1024 }),
      );
    else
      throw new HarnessError(
        `${code}_ZIP_METHOD_UNSUPPORTED`,
        `${name}:${method}`,
      );
    assert(data.length === usize, `${code}_ZIP_SIZE_MISMATCH`, name);
    assert(crc32(data) === crc >>> 0, `${code}_ZIP_CRC_MISMATCH`, name);
    members.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

function verifyDocumentExports(exportsDir, profileDir, publication) {
  const files = fs
    .readdirSync(exportsDir)
    .filter((name) => !name.startsWith("."));
  for (const extension of ["html", "pdf", "zip", "docx"]) {
    const candidates = files.filter((name) => name.endsWith(`.${extension}`));
    assert(candidates.length > 0, `NATIVE_EXPORT_MISSING:${extension}`);
    const expectedBytes = fs.readFileSync(
      nativePublicationFile(profileDir, publication, extension),
    );
    const expectedHash = createHash("sha256")
      .update(expectedBytes)
      .digest("hex");
    let matched = false;
    for (const name of candidates) {
      const file = path.join(exportsDir, name);
      const stat = fs.lstatSync(file);
      assert(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size > 0 &&
          stat.size <= 32 * 1024 * 1024,
        "NATIVE_EXPORT_INVALID",
      );
      const bytes = fs.readFileSync(file);
      const samePublication =
        createHash("sha256").update(bytes).digest("hex") === expectedHash;
      matched ||= samePublication;
      if (extension === "pdf")
        assert(
          bytes.subarray(0, 5).toString() === "%PDF-",
          "NATIVE_EXPORT_PDF_MAGIC",
        );
      if (extension === "docx" || extension === "zip") {
        const members = readZip(bytes, "NATIVE_EXPORT");
        assert(
          members.has(
            extension === "docx" ? "word/document.xml" : "document.md",
          ),
          "NATIVE_EXPORT_ZIP_CONTENT",
        );
        if (extension === "zip") {
          assert(
            members.has("manifest.json"),
            "NATIVE_EXPORT_MARKDOWN_MANIFEST",
          );
          if (samePublication) {
            const manifest = JSON.parse(
              members.get("manifest.json").toString("utf8"),
            );
            assert(
              manifest.document_id === publication.document_id &&
                manifest.revision_id === publication.revision_id &&
                manifest.publication_version === publication.version,
              "NATIVE_EXPORT_PUBLICATION_IDENTITY",
            );
          }
        }
      }
      if (extension === "html")
        assert(
          /<!doctype html|<html/i.test(bytes.toString()),
          "NATIVE_EXPORT_HTML_STRUCTURE",
        );
    }
    assert(matched, `NATIVE_EXPORT_CURRENT_PUBLICATION_MISSING:${extension}`);
  }
}

export async function runNativeJourneys({
  workspace,
  repoRoot,
  app,
  provider,
  ids,
  driverTimeoutMs = 1_200_000,
  onJourney = () => {},
}) {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "NATIVE_PLATFORM_REQUIRED",
  );
  assert(
    Number.isInteger(driverTimeoutMs) &&
      driverTimeoutMs >= 1000 &&
      driverTimeoutMs <= 3_600_000,
    "NATIVE_DRIVER_TIMEOUT_INVALID",
  );
  const bridgeDir = path.join(workspace.root, "native-driver");
  fs.mkdirSync(bridgeDir, { mode: 0o700 });
  const exportsDir = path.join(workspace.artifactsDir, "native-exports");
  fs.mkdirSync(exportsDir, { mode: 0o700 });
  const folder = path.join(workspace.root, "native-folder");
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.writeFileSync(
    path.join(folder, "notes.md"),
    "# Native folder fixture\nNATIVE_FOLDER_ORIGINAL_260907.\n",
    { mode: 0o600 },
  );
  const dav = await launchFixture({
    workspace,
    name: "webdav",
    env: {
      E2E_WEBDAV_USER: "e2e-user",
      E2E_WEBDAV_PASS: "e2e-pass",
    },
  });
  workspace.onCleanup(() => dav.stop());
  const issuer = await launchFixture({
    workspace,
    name: "oauth-issuer",
    env: { E2E_OAUTH_ACCESS_TTL_SECONDS: "30" },
  });
  workspace.onCleanup(() => issuer.stop());
  const mcp = await launchFixture({
    workspace,
    name: "mcp-server-http",
    env: {
      E2E_MCP_OAUTH_VERIFY: "1",
      E2E_MCP_ISSUER_ORIGIN: issuer.ready.origin,
    },
  });
  workspace.onCleanup(() => mcp.stop());
  const packageHash = createHash("sha256")
    .update(
      fs.readFileSync(
        path.join(app.app.appDir, "Contents", "Resources", "app.asar"),
      ),
    )
    .digest("hex");
  const packagedFile = path.join(
    app.app.appDir,
    "Contents",
    "Resources",
    "app.asar",
  );
  const packagedStat = fs.statSync(packagedFile);
  const identity = {
    pid: app.pid,
    profile: app.profileDir,
    package_sha256: packageHash,
  };
  fs.writeFileSync(
    path.join(bridgeDir, "session.json"),
    JSON.stringify(
      {
        ...identity,
        app: app.app.appDir,
        origin: app.origin,
        provider: provider.origin,
        fixture_folder: folder,
        finance_folder: path.join(repoRoot, "data", "sample"),
        supplier_folder: path.join(repoRoot, "data", "e2e", "supplier-corpus"),
        exports: exportsDir,
        mcp_http: mcp.ready.endpoint,
        stdio_command: process.execPath,
        stdio_args: [
          path.join(
            repoRoot,
            "scripts",
            "e2e",
            "fixtures",
            "mcp-server-stdio.mjs",
          ),
        ],
        webdav: {
          origin: dav.ready.origin,
          username: "e2e-user",
          password: "e2e-pass",
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.stdout.write(`E2E_NATIVE_DRIVER_READY ${bridgeDir}\n`);
  const records = [];
  const requireWatchedQuit = ids.includes("D");
  let baseline = nativeState(repoRoot, app.profileDir);
  let immutable = immutableState(repoRoot, app.profileDir);
  let initialDocumentPublication;
  const parameterSql =
    "SELECT LEFT(CAST(date AS VARCHAR), 7) AS month, category, COUNT(*) AS tx_count, ROUND(SUM(amount), 2) AS net_amount, '=' || LEFT(CAST(date AS VARCHAR), 7) || '|Borealis-E2E' AS formula_probe, '\"low, ' || LEFT(CAST(date AS VARCHAR), 7) || '\"' AS quote_probe FROM transactions WHERE LEFT(CAST(date AS VARCHAR), 7) = ? GROUP BY 1, 2 ORDER BY 1, 2";
  fs.writeFileSync(path.join(bridgeDir, "native-finance.sql"), parameterSql, {
    mode: 0o600,
  });
  async function checkpoint(name, instruction) {
    const currentPackage = fs.statSync(packagedFile);
    assert(
      currentPackage.ino === packagedStat.ino &&
        currentPackage.size === packagedStat.size &&
        currentPackage.mtimeMs === packagedStat.mtimeMs,
      "NATIVE_PACKAGE_CHANGED_DURING_RUN",
    );
    assert(pidAlive(app.pid), "NATIVE_APP_EXITED");
    const request = {
      ...identity,
      nonce: randomUUID(),
      checkpoint: name,
      instruction,
      issued_at: new Date().toISOString(),
    };
    const responseFile = path.join(bridgeDir, "response.json");
    assert(!fs.existsSync(responseFile), "NATIVE_UNEXPECTED_RESPONSE");
    fs.writeFileSync(
      path.join(bridgeDir, "request.json"),
      JSON.stringify(request, null, 2),
      { mode: 0o600 },
    );
    process.stdout.write(`E2E_NATIVE_CHECKPOINT ${name}\n`);
    const deadline = Date.now() + driverTimeoutMs;
    let activeWatch;
    let exitedAt;
    while (!fs.existsSync(responseFile)) {
      assert(pidAlive(app.pid) || name === "quit", "NATIVE_APP_EXITED");
      if (name === "quit" && requireWatchedQuit) {
        if (pidAlive(app.pid)) {
          const current = nativeWatchedRefresh(repoRoot, app.profileDir);
          const held = nativeEmbeddingHoldActive(await provider.state());
          if (current && held)
            activeWatch = { id: current.id, observedAt: Date.now() };
        } else exitedAt ??= Date.now();
      }
      if (Date.now() >= deadline)
        throw new HarnessError(`NATIVE_DRIVER_TIMEOUT:${name}`);
      await sleep(250);
    }
    const stat = fs.lstatSync(responseFile);
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size <= 64 * 1024 &&
        (stat.mode & 0o077) === 0,
      "NATIVE_RESPONSE_FILE_INVALID",
    );
    const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
    validateNativeResponse(response, request);
    if (name === "quit") {
      verifyNativeQuit(app);
      if (requireWatchedQuit) {
        const finalState =
          activeWatch &&
          nativeWatchedRefresh(repoRoot, app.profileDir, activeWatch.id);
        validateNativeWatchedQuit(
          activeWatch,
          finalState,
          exitedAt ?? Date.now(),
        );
        const providerAfterQuit = await provider.state();
        assert(
          !nativeEmbeddingHoldActive(providerAfterQuit) &&
            providerAfterQuit.embedding_active === 0 &&
            providerAfterQuit.embedding_held === 0,
          "NATIVE_EMBEDDING_HOLD_NOT_RELEASED",
        );
        fs.writeFileSync(
          path.join(workspace.artifactsDir, "native-watch-quit.json"),
          JSON.stringify(
            {
              requested_by: finalState.requested_by,
              watch_enabled: true,
              embedding_response_held: true,
              embedding_hold_expired: 0,
              embedding_requests_after_exit: 0,
              observed_active_before_exit_ms:
                (exitedAt ?? Date.now()) - activeWatch.observedAt,
              final_status: finalState.status,
              finished_at: finalState.finished_at,
              active_refreshes_after_exit: finalState.active_refreshes,
              pid_gone: true,
              locks_released: true,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
    } else {
      assert(pidAlive(app.pid), "NATIVE_APP_EXITED");
      const state = nativeState(repoRoot, app.profileDir);
      checkNativeState(name, state, baseline);
      const nextImmutable = immutableState(repoRoot, app.profileDir);
      for (const [key, value] of Object.entries(immutable))
        assert(nextImmutable[key] === value, "NATIVE_IMMUTABLE_STATE_CHANGED");
      immutable = nextImmutable;
      if (name === "B.capture" || name === "B.analysis")
        verifyFinanceResults(repoRoot, app.profileDir, name === "B.analysis");
      if (name === "E.research") {
        execFileSync(
          process.execPath,
          [
            path.join(repoRoot, "scripts/e2e/native-research-fixture.mjs"),
            workspace.root,
            "verify-facts",
          ],
          { timeout: 15000, stdio: "pipe" },
        );
      }
      if (name === "C.publish")
        initialDocumentPublication = latestNativePublication(
          repoRoot,
          app.profileDir,
        );
      if (name === "C.document") {
        assert(
          initialDocumentPublication,
          "NATIVE_INITIAL_PUBLICATION_MISSING",
        );
        const latest = latestNativePublication(
          repoRoot,
          app.profileDir,
          initialDocumentPublication.document_id,
        );
        assert(
          latest.version > initialDocumentPublication.version &&
            latest.revision > initialDocumentPublication.revision,
          "NATIVE_NEW_PUBLICATION_MISSING",
        );
        verifyDocumentExports(exportsDir, app.profileDir, latest);
      }
      baseline = state;
    }
    fs.unlinkSync(responseFile);
    const result = {
      checkpoint: name,
      status: "pass",
      driver: response.driver,
      observations: response.observations,
      finished_at: new Date().toISOString(),
    };
    records.push(result);
    fs.writeFileSync(
      path.join(workspace.artifactsDir, "native-checkpoints.json"),
      JSON.stringify(
        { package_sha256: packageHash, checkpoints: records },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  await checkpoint(
    "bootstrap",
    "Observe normal packaged startup uses local@borealis.app without registration, selected-empty composer, and no sign-out. Confirm app origin matches session.json. Use only normal native UI automation; do not inspect session secrets, inject JavaScript or attach a debugger.",
  );
  const journeys = [];
  for (const id of ids) {
    const started = Date.now();
    for (const [step, instruction] of NATIVE_CHECKPOINTS[id]) {
      if (id === "D" && (step === "permission" || step === "retry")) {
        const fixture = path.join(folder, "notes.md");
        const stat = fs.lstatSync(fixture);
        assert(
          stat.isFile() && !stat.isSymbolicLink(),
          "NATIVE_FOLDER_FIXTURE_UNSAFE",
        );
        fs.chmodSync(fixture, step === "permission" ? 0 : 0o600);
      }
      if (id === "D" && step === "watch")
        fs.writeFileSync(
          path.join(folder, "notes.md"),
          "# Native folder fixture\nNATIVE_FOLDER_CHANGED_260907.\n",
          { mode: 0o600 },
        );
      if (id === "A" && step === "agent") {
        const db = openLedger(repoRoot, app.profileDir);
        let tool;
        try {
          tool = db
            .prepare(
              "SELECT t.connection_id,t.tool_id FROM connection_tool_snapshots t JOIN connections c ON c.id=t.connection_id AND c.account_id=t.account_id JOIN users u ON u.id=c.account_id WHERE u.email='local@borealis.app' AND c.kind='mcp_stdio' AND t.name='echo_query' ORDER BY c.created_at LIMIT 1",
            )
            .get();
        } finally {
          db.close();
        }
        assert(tool, "NATIVE_ECHO_TOOL_UNAVAILABLE");
        const alias = `mcp_${createHash("sha256").update(`borealis-mcp-alias:v1|${tool.connection_id}|${tool.tool_id}`).digest("hex").slice(0, 32)}`;
        await provider.setScript({
          steps: [
            {
              type: "tool_call",
              id: "native_echo_call",
              name_pieces: [alias],
              argument_pieces: [
                JSON.stringify({ text: "native selected tool acceptance" }),
              ],
            },
            { type: "text", pieces: ["Native selected-tool answer complete."] },
          ],
          onExhausted: "repeat-last",
        });
      }
      if (id === "B" && step === "capture") {
        const captureSql = parameterSql.replace(
          "WHERE LEFT(CAST(date AS VARCHAR), 7) = ? ",
          "",
        );
        await provider.setScript({
          steps: [
            {
              type: "tool_call",
              id: "native_finance_query",
              name_pieces: ["query_data"],
              argument_pieces: [JSON.stringify({ sql: captureSql })],
            },
            {
              type: "text",
              pieces: [
                "Native finance query complete. Save the query as an analysis.",
              ],
            },
          ],
          onExhausted: "repeat-last",
        });
      }
      if (id === "D" && step === "watch") {
        await provider.setScript({
          steps: [
            {
              type: "tool_call",
              id: "native_notes_retrieve",
              name_pieces: ["retrieve"],
              argument_pieces: [
                JSON.stringify({ query: "NATIVE_FOLDER_CHANGED_260907" }),
              ],
            },
            {
              type: "text",
              pieces: [
                "The managed note contains NATIVE_FOLDER_CHANGED_260907 [1].",
              ],
            },
          ],
          onExhausted: "repeat-last",
        });
      }
      if (id === "C" && step === "publish") {
        const rows = expectedAnalysisRows(
          fs.readFileSync(
            path.join(repoRoot, "data", "sample", "transactions.csv"),
            "utf8",
          ),
          "2025-06",
        ).map((values) => [values[1], values[2], values[3]]);
        const tool = (callId, name, args) => ({
          type: "tool_call",
          id: callId,
          name_pieces: [name],
          argument_pieces: [JSON.stringify(args)],
        });
        await provider.setScript({
          steps: [
            tool("native_document_query", "query_data", {
              sql: "SELECT category,COUNT(*) AS transactions,ROUND(SUM(amount),2) AS net_amount FROM transactions WHERE LEFT(CAST(date AS VARCHAR),7)='2025-06' GROUP BY 1 ORDER BY 1",
            }),
            tool("native_document_chart", "render_chart", {
              spec: {
                type: "bar",
                title: "Native June category totals",
                categories: rows.map((row) => row[0]),
                series: [
                  { name: "net_amount", data: rows.map((row) => row[2]) },
                ],
                x_label: "Category",
                y_label: "Net amount",
              },
            }),
            {
              ...tool("native_document_report", "create_report", {
                title: "Native June finance report",
                sections: [
                  {
                    heading: "Overview",
                    markdown:
                      "June category totals come from the four selected finance sources.",
                  },
                  {
                    heading: "Breakdown",
                    markdown:
                      "The table and chart show the captured June result.",
                  },
                ],
                tables: [
                  { columns: ["category", "transactions", "net_amount"], rows },
                ],
              }),
              echo_chart_from_tool_call_id: "native_document_chart",
            },
            {
              type: "text",
              pieces: [
                "Native June report is ready. Open Reports to create an editable copy.",
              ],
            },
          ],
          onExhausted: "repeat-last",
        });
      }
      if (
        (id === "C" && step === "document") ||
        (id === "F" && step === "approve")
      ) {
        await provider.setScript({
          steps: [
            {
              type: "text",
              pieces: [
                id === "C"
                  ? "Native revised narrative: the saved finance result remains the source of the numerical findings."
                  : "Native weekly finance brief is ready for review against the saved result.",
              ],
            },
          ],
          onExhausted: "repeat-last",
        });
      }
      await checkpoint(`${id}.${step}`, instruction);
    }
    journeys.push({
      journey: id,
      status: "pass",
      surface: "packaged-native-ui",
      duration_ms: Date.now() - started,
    });
    onJourney(journeys.at(-1));
  }
  if (requireWatchedQuit) {
    const hold = await fetch(`${provider.origin}/fixture/embedding-delay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embedding_hold: true, hold_timeout_ms: 30000 }),
      signal: AbortSignal.timeout(5000),
    });
    assert(hold.ok, "NATIVE_EMBEDDING_HOLD_FAILED");
    await hold.arrayBuffer();
    // The already-selected regular fixture file changes upstream; no app
    // store/API is mutated. The production desktop watch must ingest it.
    fs.writeFileSync(
      path.join(folder, "notes.md"),
      "# Native folder fixture\nNATIVE_FOLDER_QUIT_CHANGED_260907.\n",
      { mode: 0o600 },
    );
  }
  await checkpoint(
    "quit",
    requireWatchedQuit
      ? "The harness changed the owned watched notes.md file and explicitly holds fixture embedding responses until release or client cancellation. A thirty-second hold expiry is a failure, never a successful response. In Libraries observe its automatic scheduled folder refresh while ingestion is active; do not substitute a manual refresh. While that scheduled refresh is active, quit with Cmd+Q. Respond after the process exits. The harness independently requires a scheduled desktop-folder active row with an outstanding embedding response, that same row cancelled in the stopped ledger, and PID/children/lock cleanup. Do not release the fixture hold. Quit while the scheduled refresh is active; a timed-out hold cannot pass this gate."
      : "Quit the actual packaged app normally with Cmd+Q and respond after the process exits. This selected diagnostic subset excludes journey D and does not prove active watched-refresh shutdown; the harness checks PID/children/locks.",
  );
  return {
    journeys,
    checkpoints: records.length,
    package_sha256: packageHash,
    active_watched_quit: requireWatchedQuit ? "pass" : "not_selected",
  };
}
