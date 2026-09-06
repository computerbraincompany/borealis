/**
 * Independently computed expected aggregates over the deterministic
 * personal-finance fixtures (`data/sample/`, produced by
 * `data/generate_sample.ts`) — committed expected values for journey B.
 *
 * This module is the anti-tautology guard demanded by the M12 acceptance
 * text: it recomputes the monthly category aggregates from the RAW CSV bytes
 * with plain JavaScript arithmetic (no DuckDB, no product code path), and it
 * commits a subset of the exact expected values so fixture drift or a helper
 * regression fails loudly instead of quietly re-deriving the product's own
 * output.
 *
 * Expected result rows mirror the journey B analysis SELECT exactly:
 *   month, category, tx_count, net_amount, formula_probe, quote_probe
 * grouped by (month, category), ordered by (month, category), with
 * `net_amount` = the 2-decimal rounding of the raw double sum. The probe
 * columns exist so export bytes can prove spreadsheet-formula guarding and
 * RFC-style quoting against known stored strings.
 */

/** One deterministic extra transaction used as the controlled input change. */
export const MARKER_ROW = {
  date: "2025-06-15",
  payee: "E2E Marker",
  category: "Groceries",
  amount: "-50",
  account: "Credit card",
  type: "expense",
};

/** Committed expected values (2026-09-06, seed-42 generator output). */
export const COMMITTED_EXPECTED = Object.freeze({
  transaction_rows: 697,
  income_total: 149669.89,
  expense_total_abs: 74398.64,
  month_category_keys: 142,
  june_keys: 14,
  may_keys: 12,
  june_groceries_tx_count: 6,
  june_groceries_net: -518.65,
  may_groceries_tx_count: 7,
  may_groceries_net: -468.01,
  june_salary_net: 12400,
  june_travel_net: -8324.35,
  june_interest_raw: 29.39397901842078,
  june_rent_tx_count: 23,
  // After appending MARKER_ROW to the June Groceries group:
  marker_delta_tx_count: 1,
  marker_delta_net: -50,
});

const COLUMNS = Object.freeze(["month", "category", "tx_count", "net_amount", "formula_probe", "quote_probe"]);

export function expectedColumns() {
  return COLUMNS;
}

/** Parse the generated transactions.csv bytes (unquoted CRLF CSV). */
export function parseTransactions(text) {
  const lines = text.split("\r\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("finance-expected: empty transactions text");
  const header = lines[0].split(",");
  const expectedHeader = ["date", "payee", "category", "amount", "account", "type"];
  if (header.join(",") !== expectedHeader.join(",")) {
    throw new Error("finance-expected: unexpected transactions header");
  }
  return lines.slice(1).map((line) => {
    const [date, payee, category, amount, account, type] = line.split(",");
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error("finance-expected: non-numeric amount row");
    return { date, payee, category, amount: value, account, type };
  });
}

/** Append the deterministic marker row to the CSV bytes (controlled change). */
export function withMarker(text) {
  const separator = text.endsWith("\r\n") ? "" : "\r\n";
  return `${text}${separator}${Object.values(MARKER_ROW).join(",")}\r\n`;
}

export function roundHalfAwayFromZero(value, digits = 2) {
  const factor = 10 ** digits;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * factor + Number.EPSILON * Math.max(1, Math.abs(value)))) / factor;
}

/** Raw per-(month, category) aggregates: Map key "month|category". */
export function monthCategoryAggregates(rows) {
  const map = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const key = `${month}|${row.category}`;
    const entry = map.get(key) ?? { month, category: row.category, count: 0, rawSum: 0 };
    entry.count += 1;
    entry.rawSum += row.amount;
    map.set(key, entry);
  }
  return map;
}

/** Expected totals used for the fixture-determinism assertions. */
export function financeTotals(rows) {
  let income = 0;
  let expense = 0;
  for (const row of rows) {
    if (row.type === "income") income += row.amount;
    else expense += -row.amount;
  }
  const aggregates = monthCategoryAggregates(rows);
  const months = new Set();
  for (const key of aggregates.keys()) months.add(key.split("|")[0]);
  return {
    rows: rows.length,
    income_total: roundHalfAwayFromZero(income),
    expense_total_abs: roundHalfAwayFromZero(expense),
    month_category_keys: aggregates.size,
    months: months.size,
  };
}

/**
 * Expected stored result rows for the journey B analysis.
 * `month` (nullable) mirrors the optional `?` parameter; null = all months.
 * Rows are positional arrays matching `expectedColumns()` order.
 */
export function expectedAnalysisRows(transactionsText, month = null) {
  const rows = parseTransactions(transactionsText);
  const aggregates = monthCategoryAggregates(rows);
  const out = [...aggregates.values()]
    .filter((entry) => month === null || entry.month === month)
    .sort((left, right) => left.month.localeCompare(right.month) || left.category.localeCompare(right.category))
    .map((entry) => [
      entry.month,
      entry.category,
      entry.count,
      roundHalfAwayFromZero(entry.rawSum),
      `=${entry.month}|Borealis-E2E`,
      `"low, ${entry.month}"`,
    ]);
  return out;
}

/**
 * Compare one stored numeric cell against its independently computed raw
 * expectation. The stored value is the worker's 2-decimal rounding of the
 * double sum, so the tolerance is strictly sub-cent and the stored value
 * must itself be cent-granular.
 */
export function numericCellAgrees(stored, expectedRaw) {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return false;
  if (Math.abs(stored - expectedRaw) > 0.005) return false;
  return Math.abs(stored * 100 - Math.round(stored * 100)) < 1e-6;
}

/** Verify runtime-parsed aggregates against the committed expected values. */
export function verifyCommittedExpected(transactionsText) {
  const mismatches = [];
  const rows = parseTransactions(transactionsText);
  const totals = financeTotals(rows);
  const aggregates = monthCategoryAggregates(rows);
  const check = (name, actual, expected) => {
    if (actual !== expected) mismatches.push(`${name}: ${actual} !== ${expected}`);
  };
  check("transaction_rows", totals.rows, COMMITTED_EXPECTED.transaction_rows);
  check("income_total", totals.income_total, COMMITTED_EXPECTED.income_total);
  check("expense_total_abs", totals.expense_total_abs, COMMITTED_EXPECTED.expense_total_abs);
  check("month_category_keys", totals.month_category_keys, COMMITTED_EXPECTED.month_category_keys);
  const monthKeys = (prefix) => [...aggregates.keys()].filter((key) => key.startsWith(prefix)).length;
  check("june_keys", monthKeys("2025-06|"), COMMITTED_EXPECTED.june_keys);
  check("may_keys", monthKeys("2025-05|"), COMMITTED_EXPECTED.may_keys);
  const juneGroceries = aggregates.get("2025-06|Groceries");
  check("june_groceries_tx_count", juneGroceries.count, COMMITTED_EXPECTED.june_groceries_tx_count);
  check("june_groceries_net", roundHalfAwayFromZero(juneGroceries.rawSum), COMMITTED_EXPECTED.june_groceries_net);
  const mayGroceries = aggregates.get("2025-05|Groceries");
  check("may_groceries_tx_count", mayGroceries.count, COMMITTED_EXPECTED.may_groceries_tx_count);
  check("may_groceries_net", roundHalfAwayFromZero(mayGroceries.rawSum), COMMITTED_EXPECTED.may_groceries_net);
  check("june_salary_net", roundHalfAwayFromZero(aggregates.get("2025-06|Salary").rawSum), COMMITTED_EXPECTED.june_salary_net);
  check("june_travel_net", roundHalfAwayFromZero(aggregates.get("2025-06|Travel").rawSum), COMMITTED_EXPECTED.june_travel_net);
  check("june_interest_raw", aggregates.get("2025-06|Interest").rawSum, COMMITTED_EXPECTED.june_interest_raw);
  check("june_rent_tx_count", aggregates.get("2025-06|Rent").count, COMMITTED_EXPECTED.june_rent_tx_count);
  // The controlled-change delta must be exactly what the helper claims.
  const changed = withMarker(transactionsText);
  const changedJune = monthCategoryAggregates(parseTransactions(changed)).get("2025-06|Groceries");
  check("marker_delta_tx_count", changedJune.count - juneGroceries.count, COMMITTED_EXPECTED.marker_delta_tx_count);
  check(
    "marker_delta_net",
    roundHalfAwayFromZero(changedJune.rawSum) - roundHalfAwayFromZero(juneGroceries.rawSum),
    COMMITTED_EXPECTED.marker_delta_net
  );
  return mismatches;
}
