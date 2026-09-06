/**
 * One-shot handoff from a chat with selected sources to the Research page
 * (M15 stage 4): the chat offers "Research this", which stashes the chat's
 * concrete ready source ids (never `all`) plus an optional draft title for
 * the new research definition. The stash is bounded, session-scoped, and
 * consumed exactly once; a malformed payload is dropped, never trusted.
 */

const STASH_KEY = "borealis.research-handoff";
const MAX_STASH_SOURCE_IDS = 100;
const MAX_STASH_TITLE_CHARS = 120;
const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ResearchHandoff {
  source_ids: string[];
  title: string;
}

/** Returns false when the payload exceeds the durable definition bounds. */
export function stashResearchHandoff(input: { sourceIds: readonly string[]; title?: string }): boolean {
  const sourceIds = [...new Set(input.sourceIds.filter((id) => RESOURCE_ID_PATTERN.test(id)))].slice(
    0,
    MAX_STASH_SOURCE_IDS,
  );
  if (sourceIds.length < 1 || sourceIds.length !== new Set(input.sourceIds).size) return false;
  const title = (input.title ?? "").trim().slice(0, MAX_STASH_TITLE_CHARS);
  try {
    window.sessionStorage.setItem(
      STASH_KEY,
      JSON.stringify({ source_ids: sourceIds, title, stored_at: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Reads and clears the stash; malformed payloads are dropped, never trusted. */
export function takeResearchHandoff(): ResearchHandoff | null {
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
    if (!Array.isArray(parsed.source_ids)) return null;
    const sourceIds = parsed.source_ids.filter((id): id is string => typeof id === "string");
    if (sourceIds.length < 1 || sourceIds.length > MAX_STASH_SOURCE_IDS) return null;
    const title = typeof parsed.title === "string" ? parsed.title.slice(0, MAX_STASH_TITLE_CHARS) : "";
    return { source_ids: [...new Set(sourceIds)], title };
  } catch {
    return null;
  }
}
