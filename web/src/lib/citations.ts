const CITE_SCHEME = "cite://";

/**
 * Parse a `cite://n` href into its 1-based citation number. Returns null for
 * anything that is not exactly the scheme plus one or two digits (the server's
 * `\[\d{1,2}\]` marker contract), including `cite://0` and longer numbers.
 */
export function parseCiteHref(href: string): number | null {
  const match = /^cite:\/\/(\d{1,2})$/.exec(href);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return n >= 1 ? n : null;
}

/**
 * Only markers that are not escaped (`\[1]`), not image alts (`![1]`), and not
 * already part of link syntax — inline links (`[2](url)`), reference links
 * (`[2][ref]`), or reference definitions (`[2]: url`) — are eligible.
 */
const CITATION_MARKER = /(?<![\\!])\[(\d{1,2})\](?![(:[])/g;

/**
 * Rewrite `[n]` markers whose n is in validN into `[n](cite://n)` links so the
 * renderer can turn them into clickable chips. Unknown or invalid markers stay
 * literal text (fail-closed: only resolvable numbers become chips).
 */
function linkifyMarkers(text: string, validN: ReadonlySet<number>): string {
  return text.replace(CITATION_MARKER, (marker, digits: string) => {
    const n = Number.parseInt(digits, 10);
    if (!validN.has(n)) return marker;
    return `${marker}(${CITE_SCHEME}${n})`;
  });
}

function backtickRunAt(line: string, index: number): number {
  let end = index;
  while (end < line.length && line[end] === "`") end += 1;
  return end - index;
}

/** Index of a closing backtick run of exactly `length`, or -1 when absent. */
function findClosingRun(line: string, from: number, length: number): number {
  let index = line.indexOf("`", from);
  while (index >= 0) {
    const run = backtickRunAt(line, index);
    if (run === length) return index;
    index = line.indexOf("`", index + run);
  }
  return -1;
}

/**
 * Linkify one line while keeping inline code spans verbatim. Unmatched
 * backtick runs are literal markdown, so markers after them remain eligible.
 * Code spans are matched within a single line only; fenced blocks below cover
 * the multi-line cases this simplification skips.
 */
function linkifyLine(line: string, validN: ReadonlySet<number>): string {
  let result = "";
  let searchFrom = 0;
  let emittedTo = 0;
  while (searchFrom < line.length) {
    const open = line.indexOf("`", searchFrom);
    if (open < 0) break;
    const run = backtickRunAt(line, open);
    const close = findClosingRun(line, open + run, run);
    if (close < 0) {
      searchFrom = open + run;
      continue;
    }
    result += linkifyMarkers(line.slice(emittedTo, open), validN);
    const spanEnd = close + run;
    result += line.slice(open, spanEnd);
    emittedTo = spanEnd;
    searchFrom = spanEnd;
  }
  return result + linkifyMarkers(line.slice(emittedTo), validN);
}

interface FenceState {
  char: string;
  length: number;
}

/** A fence opening line: up to three leading spaces, then 3+ backticks or tildes. */
function fenceOpener(line: string): FenceState | null {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const char = line[index];
  if (char !== "`" && char !== "~") return null;
  let run = 0;
  while (line[index + run] === char) run += 1;
  return run >= 3 ? { char, length: run } : null;
}

/** A closing fence: same character, a run at least as long, nothing else. */
function isFenceClose(line: string, fence: FenceState): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  if (line[index] !== fence.char) return false;
  let run = 0;
  while (line[index + run] === fence.char) run += 1;
  return run >= fence.length && line.slice(index + run).trim() === "";
}

/**
 * Rewrite citation markers in chat markdown into `cite://` links. Only
 * markers whose number is in validN are rewritten; fenced code blocks and
 * inline code are left untouched so displayed code never grows links.
 */
export function citeLinkify(markdown: string, validN: ReadonlySet<number>): string {
  if (validN.size === 0) return markdown;

  let fence: FenceState | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      if (fence) {
        if (isFenceClose(line, fence)) fence = null;
        return line;
      }
      const opener = fenceOpener(line);
      if (opener) {
        fence = opener;
        return line;
      }
      return linkifyLine(line, validN);
    })
    .join("\n");
}
