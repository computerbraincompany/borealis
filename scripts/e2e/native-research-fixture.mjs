// Operator helper: only synthetic provider controls and read-only owned ledger.
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workspace = process.argv[2];
const action = process.argv[3];
if (!workspace || !path.isAbsolute(workspace))
  throw new Error("ABSOLUTE_NATIVE_WORKSPACE_REQUIRED");
const session = JSON.parse(
  fs.readFileSync(path.join(workspace, "native-driver/session.json")),
);
if (new URL(session.provider).hostname !== "127.0.0.1")
  throw new Error("LOCAL_FIXTURE_REQUIRED");
if (
  session.profile !==
  path.join(fs.realpathSync(workspace), "desktop-app-profile")
)
  throw new Error("OWNED_NATIVE_PROFILE_REQUIRED");
const require = createRequire(path.join(repo, "server/package.json"));
const Database = require("better-sqlite3");
const ledger = () =>
  new Database(path.join(session.profile, "borealis.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
const withLedger = (read) => {
  const db = ledger();
  try {
    return read(db);
  } finally {
    db.close();
  }
};
const providerState = async () => {
  const response = await fetch(`${session.provider}/fixture/state`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("FIXTURE_STATE_UNAVAILABLE");
  return response.json();
};
const script = async (steps) => {
  const response = await fetch(`${session.provider}/fixture/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps, on_exhausted: "repeat-last" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("FIXTURE_SCRIPT_REJECTED");
  await response.arrayBuffer();
};
const text = (value) => ({
  type: "text",
  pieces: [typeof value === "string" ? value : JSON.stringify(value)],
});
if (action === "verify-facts") {
  const proof = withLedger((db) => {
    const run = db
      .prepare(
        `SELECT r.* FROM research_runs r JOIN research_definitions d ON d.id=r.definition_id
       JOIN users u ON u.id=r.account_id WHERE u.email='local@borealis.app'
       AND d.output_kind='comparison' AND r.rerun_of IS NULL AND r.status='completed'
       ORDER BY r.created_at LIMIT 1`,
      )
      .get();
    assert(run, "NATIVE_COMPARISON_MISSING");
    const revision = db
      .prepare(
        "SELECT columns FROM research_definition_revisions WHERE definition_id=? AND revision=?",
      )
      .get(run.definition_id, run.definition_revision);
    const columns = new Map(
      JSON.parse(revision.columns).map((column) => [column.id, column.label]),
    );
    const facts = new Map(
      JSON.parse(
        fs.readFileSync(
          path.join(repo, "data/e2e/supplier-corpus/manifest.json"),
        ),
      ).documents.map((document) => [document.file, document]),
    );
    const cells = db
      .prepare(
        "SELECT c.*,s.display_name FROM research_table_cells c JOIN sources s ON s.id=c.row_source_id AND s.account_id=c.account_id WHERE c.run_id=? AND c.origin='machine'",
      )
      .all(run.id);
    assert.equal(cells.length, 45, "NATIVE_COMPARISON_CELL_COUNT");
    const fields = {
      Price: "price",
      "Effective date": "effective_date",
      Renewal: "renewal",
      Tier: "tier",
      Exceptions: "exceptions",
    };
    let checked = 0;
    let gaps = 0;
    for (const cell of cells) {
      const field = fields[columns.get(cell.column_id)];
      assert(field, "NATIVE_COMPARISON_COLUMN_UNKNOWN");
      if (cell.display_name === "10_acme_scanned_invoice.pdf") {
        assert.equal(cell.status, "not_found");
        gaps++;
        continue;
      }
      let expected = facts.get(cell.display_name)?.fields[field];
      assert.notEqual(expected, undefined, "NATIVE_COMPARISON_FACT_MISSING");
      if (field === "price") expected = expected.value;
      if (field === "tier")
        expected = expected[0].toUpperCase() + expected.slice(1);
      if (
        field === "price" &&
        cell.display_name === "09_everline_term_sheet.md"
      ) {
        expected = "15000";
        assert.equal(cell.status, "invalid");
      }
      assert.deepEqual(
        JSON.parse(cell.value),
        expected,
        "NATIVE_COMPARISON_FACT_MISMATCH",
      );
      checked++;
    }
    assert.equal(gaps, 5);
    assert.equal(checked, 40);
    return {
      status: "pass",
      machine_cells: 45,
      fixture_fact_values_checked: checked,
      explicit_scanned_gaps: gaps,
      everline_off_type_preserved: true,
    };
  });
  fs.writeFileSync(
    path.join(workspace, "artifacts/native-research-facts.json"),
    JSON.stringify(proof, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(proof));
} else if (action === "plan-memo") {
  await script([
    text({
      steps: [
        {
          objective: "Gather pricing and term evidence for the reviewed memo",
          questions: ["price"],
        },
      ],
    }),
  ]);
  console.log("Synthetic memo plan installed.");
} else if (action === "cancel") {
  await script([{ type: "no_response" }]);
  console.log(
    "Silent synthetic provider installed; start and cancel using native UI.",
  );
} else if (action === "plan") {
  await script([
    text({
      steps: [
        {
          objective:
            "Find price, tier, date, renewal and exceptions in each supplier document",
          questions: ["price", "tier"],
        },
        {
          objective: "Compare conflicting or superseding supplier statements",
          questions: ["exceptions", "supersedes"],
        },
        {
          objective:
            "Identify renewal, effective dates and missing information",
          questions: ["renewal", "effective"],
        },
      ],
    }),
  ]);
  console.log("Synthetic plan response installed.");
} else if (
  action === "arm" ||
  action === "arm-rerun" ||
  action === "arm-memo"
) {
  const { user, before, sources } = withLedger((db) => {
    const user = db
      .prepare("SELECT id FROM users WHERE email='local@borealis.app'")
      .get();
    if (!user) throw new Error("NATIVE_BOOTSTRAP_ACCOUNT_MISSING");
    const before = new Set(
      db
        .prepare("SELECT id FROM research_runs WHERE account_id=?")
        .all(user.id)
        .map((r) => r.id),
    );
    const sources = db
      .prepare(
        "SELECT id, display_name FROM sources WHERE account_id=? AND status='ready'",
      )
      .all(user.id);
    return { user, before, sources };
  });
  const files = new Map(sources.map((s) => [s.display_name, s.id]));
  const facts = JSON.parse(
    fs.readFileSync(path.join(repo, "data/e2e/supplier-corpus/manifest.json")),
  ).documents;
  await script([
    { type: "slow", delay_ms: 12000, pieces: ["Captured supplier evidence."] },
  ]);
  const baselineCalls = (await providerState()).chat_calls;
  console.log("Armed: start the real research run through the native UI.");
  const deadline = Date.now() + 180000;
  let evidence;
  let responseStarted = false;
  while (Date.now() < deadline) {
    evidence = withLedger((db) => {
      const run = db
        .prepare(
          "SELECT id FROM research_runs WHERE account_id=? ORDER BY created_at DESC",
        )
        .all(user.id)
        .find((r) => !before.has(r.id));
      return run
        ? db
            .prepare(
              "SELECT id,source_id FROM research_evidence WHERE account_id=? AND run_id=? ORDER BY step_ordinal,id",
            )
            .all(user.id, run.id)
        : [];
    });
    const calls = (await providerState()).chat_calls;
    if (evidence.length >= 8 && calls > baselineCalls) {
      responseStarted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!responseStarted || !evidence || evidence.length < 8)
    throw new Error("NATIVE_RESEARCH_EVIDENCE_NOT_CAPTURED");
  const bySource = new Map();
  for (const row of evidence)
    if (!bySource.has(row.source_id)) bySource.set(row.source_id, row.id);
  const ref = (file) =>
    bySource.has(files.get(file)) ? [bySource.get(files.get(file))] : [];
  const supported = facts.filter(
    (doc) => files.has(doc.file) && doc.file !== "10_acme_scanned_invoice.pdf",
  );
  const tiers = {
    basic: "Basic",
    pro: "Pro",
    premium: "Premium",
    standard: "Standard",
    enterprise: "Enterprise",
  };
  const column = (field) => ({
    cells: supported.map((doc) => {
      let value =
        field === "price"
          ? doc.fields.price.value
          : field === "tier"
            ? tiers[doc.fields.tier]
            : doc.fields[field];
      if (field === "price" && doc.file === "09_everline_term_sheet.md")
        value = "15000";
      return {
        source_id: files.get(doc.file),
        value,
        evidence_ids: ref(doc.file),
        explanation:
          value === null
            ? "Not found in this selected document."
            : "Fact captured from the supplier document.",
      };
    }),
  });
  const summaries =
    action === "arm-memo"
      ? []
      : [
          text("Compared superseding statements and captured conflicts."),
          text(
            "Recorded renewal and date facts, with explicit missing information.",
          ),
        ];
  const outputs =
    action === "arm-rerun"
      ? [
          {
            cells: [
              {
                source_id: files.get("09_everline_term_sheet.md"),
                value: 15000,
                evidence_ids: ref("09_everline_term_sheet.md"),
                explanation: "Term sheet price 15000 USD, re-extracted.",
              },
            ],
          },
        ]
      : ["price", "effective_date", "renewal", "tier", "exceptions"].map(
          column,
        );
  if (action === "arm-memo") {
    const e01 = ref("01_acme_logistics_agreement.md")[0],
      e02 = ref("02_acme_renewal_quote.md")[0];
    if (!e01 || !e02) throw new Error("MEMO_PRICE_EVIDENCE_MISSING");
    await script([
      text({
        claims: [
          {
            text: "Acme Logistics prices its master agreement at 12000 USD for premium freight services.",
            classification: "supported",
            evidence_ids: [e01],
          },
          {
            text: "Acme price conflict: 12000 USD in the master agreement versus 13500 USD in the renewal quote; supersession remains open until countersignature.",
            classification: "conflicting",
            evidence_ids: [e01, e02],
          },
          {
            text: "Delta Paper renews at 4600 USD according to an unsupported renewal memo.",
            classification: "unsupported",
            evidence_ids: [],
          },
        ],
        gaps: [
          "BlueRiver change order exceptions are not found in selected evidence.",
          "No selected document states a Delta Paper renewal-memo price; not found in selected evidence.",
          "Scanned invoice has no supported price fields in selected evidence.",
        ],
      }),
    ]);
  } else await script([...summaries, ...outputs.map(text)]);
  console.log(
    action === "arm-memo"
      ? `Installed reviewed-memo synthesis using ${evidence.length} actual captured evidence references.`
      : `Installed ${outputs.length} typed synthetic column responses using ${evidence.length} actual captured evidence references.`,
  );
} else throw new Error("UNKNOWN_ACTION");
