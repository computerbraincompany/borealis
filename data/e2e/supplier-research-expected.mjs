/**
 * Committed expected values for the M15 local-research milestone fixtures —
 * the deterministic synthetic three-supplier corpus used by
 * `scripts/e2e-local-research.mjs` and mirrored inline (same bytes, same
 * facts) in `server/src/tests/research.integration.test.ts`.
 *
 * This is the anti-tautology guard for the M15 end-to-end proof (same role
 * `scripts/e2e/fixtures/lib/finance-expected.mjs` plays for journey B): the
 * three document bodies below are the committed fixture bytes, the fact
 * table is the independently transcribed expectation, and
 * `verifyCommittedExpected()` reparses the raw bodies with plain regexes
 * (no product code path) and fails loudly if the fixture text and the
 * committed expectations ever drift apart. The milestone corpus is the
 * three-supplier subset of the shape pinned by
 * `data/e2e/supplier-corpus/manifest.json`: differing dates, amounts and
 * terms, one contradiction (the shared platform onboarding fee: 900 vs
 * 950 USD across Acme and BlueRiver), and one fact stated nowhere (the
 * termination notice period). BlueRiver's body is padded so its two renewal
 * statements land in different 900-character chunks, producing a real
 * cell-level conflict over two captured excerpts.
 */

/** Padding that pushes BlueRiver's renewal addendum out of chunk one. */
export const BLUE_FILLER = "Delivery cadence is weekly with a monthly steering call. ".repeat(12);

/** The committed fixture bytes, upload order significant. */
export const SUPPLIER_DOCS = Object.freeze([
  Object.freeze({
    name: "acme-proposal.md",
    supplier: "Acme Logistics",
    body: [
      "# Acme Logistics proposal",
      "Supplier: Acme Logistics",
      "Price: 12000 USD",
      "Effective: 2026-01-15",
      "Renewal: automatic on the anniversary date",
      "Tier: premium",
      "Exceptions: =volume discounts above 500 shipments per quarter",
      "The shared platform onboarding fee is 900 USD one time.",
      "Payment terms are net 30 days.",
      "Regional freight and last-mile delivery are covered.",
    ].join("\n"),
  }),
  Object.freeze({
    name: "blueriver-proposal.md",
    supplier: "BlueRiver Analytics",
    body: [
      "# BlueRiver Analytics proposal",
      "Supplier: BlueRiver Analytics",
      "Price: 8750 USD",
      "Effective: 2025-11-01",
      "Renewal: manual written approval",
      "Tier: standard",
      "Exceptions: none stated",
      "The shared platform onboarding fee is 950 USD one time.",
      "Payment terms are net 45 days.",
      BLUE_FILLER,
      "Renewal addendum: the renewal quote allows automatic renewal.",
      "Data feeds are provisioned within five business days.",
    ].join("\n"),
  }),
  Object.freeze({
    name: "cedarcloud-proposal.md",
    supplier: "CedarCloud Hosting",
    body: [
      "# CedarCloud Hosting proposal",
      "Supplier: CedarCloud Hosting",
      "Price: 21000 USD",
      "Effective: 2026-03-01",
      "Tier: enterprise",
      "Exceptions: EU data residency add-on excluded",
      "Payment terms are net 60 days.",
      "Compute and storage are metered monthly.",
    ].join("\n"),
  }),
]);

/** sha256 of each committed body; recomputed by verifyCommittedExpected(). */
export const COMMITTED_DOC_SHA256 = Object.freeze({
  "acme-proposal.md": "d778afb6b082399c0c8e2b4e21b39a711a8ead64494bda11cf134839e156e6c5",
  "blueriver-proposal.md": "70247e7784567139a1a19e9d2b6abe2df11fa9bb7552e6ac579a3549987fe36f",
  "cedarcloud-proposal.md": "5c7157c004b31e0c3566f6799829cc25c9671e278b1d383a7cddf1bf606f06d2",
});

/**
 * Independently transcribed fixture facts. `renewal: "conflict"` marks the
 * deliberate BlueRiver contradiction; `renewal: null` marks Cedar's honest
 * missing renewal fact. The onboarding-fee contradiction and the
 * never-stated termination notice period are the corpus-level facts.
 */
export const COMMITTED_EXPECTED = Object.freeze({
  suppliers: Object.freeze({
    "Acme Logistics": Object.freeze({
      price: 12000,
      currency: "USD",
      effective_date: "2026-01-15",
      renewal: true,
      renewal_statement: "Renewal: automatic on the anniversary date",
      tier: "premium",
      exceptions: "=volume discounts above 500 shipments per quarter",
      onboarding_fee_usd: 900,
      payment_terms_days: 30,
    }),
    "BlueRiver Analytics": Object.freeze({
      price: 8750,
      currency: "USD",
      effective_date: "2025-11-01",
      renewal: "conflict",
      renewal_statement: "Renewal: manual written approval",
      renewal_addendum: "Renewal addendum: the renewal quote allows automatic renewal.",
      tier: "standard",
      exceptions: "none stated",
      onboarding_fee_usd: 950,
      payment_terms_days: 45,
    }),
    "CedarCloud Hosting": Object.freeze({
      price: 21000,
      currency: "USD",
      effective_date: "2026-03-01",
      renewal: null,
      renewal_statement: null,
      tier: "enterprise",
      exceptions: "EU data residency add-on excluded",
      onboarding_fee_usd: null,
      payment_terms_days: 60,
    }),
  }),
  conflict: Object.freeze({
    fact: "shared platform onboarding fee",
    values: Object.freeze([900, 950]),
    currency: "USD",
    excerpt_fragment: "USD one time",
    suppliers: Object.freeze(["Acme Logistics", "BlueRiver Analytics"]),
  }),
  missing_fact: Object.freeze({
    name: "termination notice period",
    gap_phrase: "not found in selected evidence",
  }),
  columns: Object.freeze(
    [
      Object.freeze({
        label: "Price",
        question: "What is the annual price?",
        type: "number",
        unit: "USD",
        choices: null,
      }),
      Object.freeze({
        label: "Effective",
        question: "What is the effective date?",
        type: "date",
        unit: null,
        choices: null,
      }),
      Object.freeze({
        label: "Renewal",
        question: "Is renewal automatic?",
        type: "boolean",
        unit: null,
        choices: null,
      }),
      Object.freeze({
        label: "Tier",
        question: "Which service tier is offered?",
        type: "enum",
        unit: null,
        choices: Object.freeze(["standard", "premium", "enterprise"]),
      }),
      Object.freeze({
        label: "Exceptions",
        question: "Which exceptions apply?",
        type: "text",
        unit: null,
        choices: null,
      }),
    ]
  ),
  comparison: Object.freeze({
    machine_cells: 15,
    invalid_cells: 2,
    conflicting_cells: 1,
    not_found_cells: 1,
    invalid_number_verbatim: "12000 dollars",
    invalid_text_verbatim: 42,
  }),
  review: Object.freeze({
    correction_acme_price: 12000,
    correction_explanation: "Verified against the signed order form.",
    rerun_blue_price: 9000,
    rerun_explanation: "Refreshed quote supersedes the prior rate.",
  }),
  memo_plan_steps: Object.freeze([
    Object.freeze({ objective: "Find the shared onboarding fee statements", questions: Object.freeze(["onboarding"]) }),
    Object.freeze({ objective: "Establish the termination notice period", questions: Object.freeze(["termination"]) }),
  ]),
  comparison_plan_steps: Object.freeze([
    Object.freeze({ objective: "Establish which suppliers renew and how", questions: Object.freeze(["renewal"]) }),
    Object.freeze({ objective: "Capture the priced terms for every supplier", questions: Object.freeze(["payment"]) }),
  ]),
  export: Object.freeze({
    csv_bom: Object.freeze([0xef, 0xbb, 0xbf]),
    formula_guarded: "'=volume discounts above 500 shipments per quarter",
    invalid_verbatim_row: "12000 dollars,invalid,",
    correction_row: ",correction,12000,supported,",
    manifest_artifact: "research_run_export_manifest",
  }),
});

/** Re-parse the committed bodies with plain regexes (no product code path). */
export function parseSupplierDoc(body) {
  const line = (prefix) => {
    const match = new RegExp(`^${prefix}: (.*)$`, "m").exec(body);
    return match ? match[1] : null;
  };
  const price = line("Price");
  const priceMatch = price === null ? null : /^(\d+) ([A-Z]{3})$/.exec(price);
  const feeMatch = /onboarding fee is (\d+) USD one time/.exec(body);
  const termsMatch = /net (\d+) days/.exec(body);
  const effective = line("Effective");
  const renewal = line("Renewal");
  return {
    price: priceMatch ? Number(priceMatch[1]) : null,
    currency: priceMatch ? priceMatch[2] : null,
    effective_date:
      effective !== null && /^\d{4}-\d{2}-\d{2}$/.test(effective) ? effective : null,
    renewal: renewal === null ? null : /^automatic/.test(renewal) ? true : false,
    renewal_count: (body.match(/^Renewal/gm) ?? []).length,
    tier: line("Tier"),
    exceptions: line("Exceptions"),
    onboarding_fee_usd: feeMatch ? Number(feeMatch[1]) : null,
    payment_terms_days: termsMatch ? Number(termsMatch[1]) : null,
  };
}

/**
 * Verify the committed fixture bytes against the committed expectation table.
 * Returns an empty array when consistent, otherwise human-readable
 * mismatches; callers must treat a non-empty result as fatal.
 */
export function verifyCommittedExpected(hashes = {}) {
  const mismatches = [];
  const check = (name, actual, expected) => {
    if (actual !== expected) mismatches.push(`${name}: ${actual} !== ${expected}`);
  };
  if (SUPPLIER_DOCS.length !== 3) mismatches.push("expected exactly three supplier docs");
  for (const doc of SUPPLIER_DOCS) {
    const committedHash = COMMITTED_DOC_SHA256[doc.name];
    if (typeof committedHash === "string" && typeof hashes[doc.name] === "string") {
      check(`sha256(${doc.name})`, hashes[doc.name], committedHash);
    }
    const parsed = parseSupplierDoc(doc.body);
    const expected = COMMITTED_EXPECTED.suppliers[doc.supplier];
    if (!expected) {
      mismatches.push(`no committed facts for ${doc.supplier}`);
      continue;
    }
    for (const field of ["price", "currency", "effective_date", "tier", "exceptions", "payment_terms_days"]) {
      check(`${doc.supplier}.${field}`, parsed[field], expected[field]);
    }
    check(`${doc.supplier}.onboarding_fee_usd`, parsed.onboarding_fee_usd, expected.onboarding_fee_usd);
    if (expected.renewal === "conflict") {
      check(`${doc.supplier}.renewal_conflict_lines`, parsed.renewal_count >= 2, true);
    } else {
      check(`${doc.supplier}.renewal`, parsed.renewal, expected.renewal);
      check(`${doc.supplier}.renewal_lines`, parsed.renewal_count, expected.renewal === null ? 0 : 1);
    }
    check(`${doc.supplier}.heading`, new RegExp(`^# ${doc.supplier} proposal$`, "m").test(doc.body), true);
  }
  const fees = COMMITTED_EXPECTED.conflict.values;
  check(
    "conflict fees distinct",
    COMMITTED_EXPECTED.suppliers["Acme Logistics"].onboarding_fee_usd !==
      COMMITTED_EXPECTED.suppliers["BlueRiver Analytics"].onboarding_fee_usd,
    true
  );
  check("conflict fee acme", COMMITTED_EXPECTED.suppliers["Acme Logistics"].onboarding_fee_usd, fees[0]);
  check("conflict fee blueriver", COMMITTED_EXPECTED.suppliers["BlueRiver Analytics"].onboarding_fee_usd, fees[1]);
  // The termination notice period must appear nowhere in the corpus.
  check(
    "missing fact absent from corpus",
    SUPPLIER_DOCS.some((doc) => /termination/i.test(doc.body)),
    false
  );
  return mismatches;
}
