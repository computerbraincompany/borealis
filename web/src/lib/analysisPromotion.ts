/**
 * One-shot handoff from a legacy chat query receipt to the Analyses editor
 * (M12). Legacy receipts have no verified full-query capture, so promotion is
 * an explicit editor path requiring the complete SQL; the sliced receipt text
 * is only a starting draft. The stash is bounded and consumed exactly once.
 */

const STASH_KEY = "borealis.analysis-promotion";
const MAX_STASH_SQL_CHARS = 20_000;

export interface PromotionStash {
  sql: string;
  stored_at: string;
}

/** Returns false when the SQL exceeds the durable definition ceiling. */
export function stashPromotionSql(sql: string): boolean {
  if (typeof sql !== "string" || sql.length < 1 || sql.length > MAX_STASH_SQL_CHARS) return false;
  try {
    window.sessionStorage.setItem(STASH_KEY, JSON.stringify({ sql, stored_at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/** Reads and clears the stash; malformed payloads are dropped, never trusted. */
export function takePromotionStash(): PromotionStash | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STASH_KEY);
    window.sessionStorage.removeItem(STASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.sql !== "string" || parsed.sql.length < 1 || parsed.sql.length > MAX_STASH_SQL_CHARS) return null;
    return { sql: parsed.sql, stored_at: typeof parsed.stored_at === "string" ? parsed.stored_at : "" };
  } catch {
    return null;
  }
}
