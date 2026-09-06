import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Loader2, Search, X } from "lucide-react";
import {
  formatApiError,
  isRemoteEgressConsentError,
  librariesApi,
  sourcesApi,
  type LibrarySearchHit,
  type LibrarySearchResult,
  type Source,
  type SourceLocator,
  type SourcePassage,
} from "@/lib/api";
import { EGRESS_PAYLOAD_CLASSES } from "@/lib/egressDisclosure";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Library-scoped inspectable search (M14 stage 4): Keyword is the default
 * and makes no model request; Semantic is an explicit opt-in subject to the
 * remote-egress consent gate, disclosed with the canonical payload-class
 * wording. Filters validate against library membership — they never widen
 * the scope. Each hit shows its typed locator (or the honest absence) and
 * opens the passage panel with bounded neighboring text; passages pruned by
 * a refresh render honestly, and pre-locator chunks render as
 * location-unavailable until an explicit reingest.
 */

function locatorCopy(locator: SourceLocator): string {
  switch (locator.kind) {
    case "pdf_page":
      return `PDF page ${locator.page}${locator.ocr ? " (OCR)" : ""}, chars ${locator.char_start}–${locator.char_start + locator.char_len}`;
    case "text_span":
      return `text chars ${locator.char_start}–${locator.char_start + locator.char_len}${locator.heading ? ` · ${locator.heading}` : ""}`;
    case "tabular_rows":
      return `${locator.table} rows ${locator.row_start}–${locator.row_end}`;
    default:
      return "location unavailable";
  }
}

/** Escape-bounded case-insensitive excerpt highlight for the raw query. */
export function HighlightedExcerpt({ text, query }: { text: string; query: string }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);
  if (!terms.length) return <span>{text}</span>;
  const lower = text.toLowerCase();
  const marks: number[] = [];
  for (const term of terms) {
    let cursor = 0;
    for (;;) {
      const at = lower.indexOf(term, cursor);
      if (at < 0 || marks.length > 64) break;
      marks.push(at);
      cursor = at + term.length;
    }
  }
  if (!marks.length) return <span>{text}</span>;
  marks.sort((a, b) => a - b);
  const nodes: { key: string; node: React.ReactNode }[] = [];
  let position = 0;
  for (const mark of marks) {
    if (mark < position) continue;
    if (mark > position) nodes.push({ key: `t${position}`, node: text.slice(position, mark) });
    const termLength = Math.max(...terms.map((term) => (lower.startsWith(term, mark) ? term.length : 0)));
    if (termLength < 1) continue;
    nodes.push({
      key: `h${mark}`,
      node: <mark className="rounded-sm bg-warning/25 text-foreground">{text.slice(mark, mark + termLength)}</mark>,
    });
    position = mark + termLength;
  }
  if (position < text.length) nodes.push({ key: `t${position}`, node: text.slice(position) });
  return (
    <span>
      {nodes.map(({ key, node }) => (
        <span key={key}>{node}</span>
      ))}
    </span>
  );
}

function locatorBadges(locators: SourceLocator[] | undefined): React.ReactNode {
  if (!locators || locators.length === 0) {
    return (
      <span className="text-xs text-muted-foreground italic">
        Location unavailable for this chunk — legacy ingestion; an explicit reingest adds page/section anchors.
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {locators.slice(0, 3).map((locator, index) => (
        <Badge key={`${locator.kind}-${index}`} variant="outline" className="font-normal">
          {locatorCopy(locator)}
        </Badge>
      ))}
    </span>
  );
}

interface Props {
  libraryId: string;
  members: Source[];
  /** Present when opened from the library manager; closes the panel. */
  onClose?: () => void;
}

export function LibrarySearchPanel({ libraryId, members, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [kindFilter, setKindFilter] = useState<"all" | "document" | "tabular">("all");
  const [sourceFilter, setSourceFilter] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<LibrarySearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentRequired, setConsentRequired] = useState(false);
  const [openPassage, setOpenPassage] = useState<{ sourceId: string; chunkId: string; label: string } | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  /** A newer search aborts the in-flight one; only the latest target may settle. */
  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setSearching(true);
    setError(null);
    setConsentRequired(false);
    setResult(null);
    setOpenPassage(null);
    try {
      const selectedSourceIds = Object.entries(sourceFilter)
        .filter(([, checked]) => checked)
        .map(([id]) => id);
      const page = await librariesApi.search(
        libraryId,
        {
          query: trimmed,
          mode,
          ...(selectedSourceIds.length ? { source_ids: selectedSourceIds } : {}),
          ...(kindFilter === "all" ? {} : { kind: kindFilter }),
        },
        abort.signal,
      );
      if (!mountedRef.current || requestId !== requestRef.current || abort.signal.aborted) return;
      setResult(page);
    } catch (caught: unknown) {
      if (!mountedRef.current || requestId !== requestRef.current || abort.signal.aborted) return;
      if (isRemoteEgressConsentError(caught)) {
        setConsentRequired(true);
      } else {
        setError(formatApiError(caught, "Search failed"));
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current && !abort.signal.aborted) setSearching(false);
    }
  }, [query, mode, kindFilter, sourceFilter, libraryId]);

  const changedScope = (result?.captured_scope ?? []).filter((entry) => entry.status !== "ready");

  return (
    <div className="space-y-3">
      {onClose && (
        <div className="flex justify-end">
          <Button variant="ghost" size="icon" aria-label="Close search" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={1_000}
            aria-label="Search query"
            placeholder="Search this library…"
          />
          <Button type="submit" size="sm" disabled={!query.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="search-mode" checked={mode === "keyword"} onChange={() => setMode("keyword")} />
            Keyword (on-device, no model request)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="search-mode" checked={mode === "semantic"} onChange={() => setMode("semantic")} />
            Semantic
          </label>
          <select
            aria-label="Filter by type"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">All types</option>
            <option value="document">Documents</option>
            <option value="tabular">Tables</option>
          </select>
        </div>
        {mode === "semantic" && (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
            Semantic search sends your query to the configured model provider and requires remote egress acknowledgment.
            Remember: {EGRESS_PAYLOAD_CLASSES} can leave the machine under that provider's policy.
          </p>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Filter sources ({members.length} in library)
          </summary>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
            {members.map((member) => (
              <label key={member.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!sourceFilter[member.id]}
                  onChange={(event) =>
                    setSourceFilter((current) => ({ ...current, [member.id]: event.target.checked }))
                  }
                />
                <span className="truncate">{member.display_name || member.name}</span>
              </label>
            ))}
          </div>
        </details>
      </form>

      {consentRequired && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <p>Remote model-provider consent is required before a semantic search query may leave this machine.</p>
          <Button variant="outline" size="sm" className="mt-2" asChild>
            <a href="#/settings">
              <ExternalLink className="h-4 w-4" /> Open Settings to acknowledge
            </a>
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-2" aria-label="Search results">
          <p className="text-xs text-muted-foreground" role="status">
            {result.hits.length} hit{result.hits.length === 1 ? "" : "s"}
            {result.query_truncated ? " (query was truncated)" : ""}
            {result.truncated ? " (result page truncated)" : ""}
            {result.ignored_source_ids.length > 0
              ? ` · ${result.ignored_source_ids.length} filter id(s) outside the library were ignored`
              : ""}
          </p>
          {changedScope.length > 0 && (
            <p className="text-xs text-warning">
              {changedScope.length} captured source generation(s) changed or were unavailable during the search; newer
              content was not searched.
            </p>
          )}
          <ul className="space-y-2">
            {result.hits.map((hit) => (
              <HitRow
                key={`${hit.source_id}-${hit.chunk_id}`}
                hit={hit}
                query={query}
                onOpen={() => setOpenPassage({ sourceId: hit.source_id, chunkId: hit.chunk_id, label: hit.label })}
              />
            ))}
            {result.hits.length === 0 && (
              <li className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No indexed passages matched.
              </li>
            )}
          </ul>
        </div>
      )}

      {openPassage && (
        <PassagePanel
          sourceId={openPassage.sourceId}
          chunkId={openPassage.chunkId}
          label={openPassage.label}
          query={query}
          onClose={() => setOpenPassage(null)}
        />
      )}
    </div>
  );
}

function HitRow({ hit, query, onOpen }: { hit: LibrarySearchHit; query: string; onOpen: () => void }) {
  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
        >
          #{hit.rank} {hit.label}
        </button>
        <Badge variant="outline" className="shrink-0">
          {hit.score.toFixed(3)}
        </Badge>
      </div>
      <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
        <HighlightedExcerpt text={hit.excerpt} query={query} />
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        {locatorBadges(hit.locators)}
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open passage
        </Button>
      </div>
    </li>
  );
}

export function PassagePanel({
  sourceId,
  chunkId,
  label,
  query,
  onClose,
}: {
  sourceId: string;
  chunkId: string;
  label: string;
  query: string;
  onClose: () => void;
}) {
  const [passage, setPassage] = useState<SourcePassage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++requestRef.current;
    const abort = new AbortController();
    setState("loading");
    void sourcesApi
      .passage(sourceId, chunkId, abort.signal)
      .then((loaded) => {
        if (mountedRef.current && requestId === requestRef.current && !abort.signal.aborted) {
          setPassage(loaded);
          setState("ready");
        }
      })
      .catch((caught: unknown) => {
        if (!mountedRef.current || requestId !== requestRef.current || abort.signal.aborted) return;
        const status = (caught as { status?: number }).status;
        if (status === 410) {
          setState("unavailable");
          setMessage("This passage is no longer available for the source's current generation.");
        } else if (status === 404) {
          setState("unavailable");
          setMessage("The source or passage no longer exists in this account.");
        } else {
          setState("error");
          setMessage(formatApiError(caught, "Could not load the passage"));
        }
      });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abort.abort();
    };
  }, [sourceId, chunkId]);

  return (
    <section className="rounded-lg border bg-muted/30 p-3" aria-label={`Passage in ${label}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-muted-foreground" /> Passage — {label}
        </h3>
        <Button variant="ghost" size="icon" aria-label="Close passage" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {state === "loading" && (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading passage…
        </p>
      )}
      {(state === "unavailable" || state === "error") && (
        <p
          role={state === "error" ? "alert" : "status"}
          className={cn("py-3 text-sm", state === "error" ? "text-destructive" : "text-muted-foreground")}
        >
          {message}
        </p>
      )}
      {state === "ready" && passage && (
        <div className="mt-2 space-y-2">
          {passage.neighbors.before && (
            <p className="line-clamp-2 text-xs text-muted-foreground italic">{passage.neighbors.before.content}</p>
          )}
          <p className="rounded-md border bg-background px-3 py-2 text-sm">
            <HighlightedExcerpt text={passage.chunk.content} query={query} />
          </p>
          {passage.neighbors.after && (
            <p className="line-clamp-2 text-xs text-muted-foreground italic">{passage.neighbors.after.content}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {passage.source.ready_generation === passage.chunk.generation ? (
              <span>generation {passage.chunk.generation}</span>
            ) : (
              <span>
                captured generation {passage.chunk.generation} — source now indexes generation{" "}
                {passage.source.ready_generation ?? "none"}
              </span>
            )}
            {locatorBadges(passage.chunk.locators)}
          </div>
        </div>
      )}
    </section>
  );
}
