import { useEffect, useRef } from "react";
import { ChevronRight, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RetrievedEvidence as RetrievedEvidenceItem } from "@/lib/api";

interface EvidencePassage {
  passage: RetrievedEvidenceItem;
  /** 1-based position in the evidence array; this is the citation number. */
  n: number;
}

interface EvidenceGroup {
  sourceId: string;
  source: string;
  passages: EvidencePassage[];
}

function groupBySource(evidence: RetrievedEvidenceItem[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const bySource = new Map<string, EvidenceGroup>();

  for (const [index, passage] of evidence.entries()) {
    const entry = { passage, n: index + 1 };
    const existing = bySource.get(passage.source_id);
    if (existing) {
      existing.passages.push(entry);
      continue;
    }

    const group = {
      sourceId: passage.source_id,
      source: passage.source,
      passages: [entry],
    };
    bySource.set(passage.source_id, group);
    groups.push(group);
  }

  return groups;
}

export function RetrievedEvidence({
  evidence,
  open,
  onOpenChange,
  highlightN = null,
}: {
  evidence: RetrievedEvidenceItem[];
  /** Controlled open state; omit (or omit onOpenChange) for native behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Citation number (1-based) receiving a brief emphasis ring. */
  highlightN?: number | null;
}) {
  const passageRefs = useRef(new Map<number, HTMLParagraphElement>());

  useEffect(() => {
    if (highlightN === null) return;
    passageRefs.current.get(highlightN)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightN, open]);

  if (evidence.length === 0) return null;

  const groups = groupBySource(evidence);

  return (
    <details open={open} className="group/evidence mt-3 overflow-hidden rounded-lg border bg-surface-subtle text-sm">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 font-medium text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          // While controlled, React owns the open attribute; stop the native
          // summary toggle so it cannot fight the state update.
          if (!onOpenChange) return;
          event.preventDefault();
          onOpenChange(!(open ?? false));
        }}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-card text-primary">
          <Library className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">Evidence · {groups.length} sources</span>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/evidence:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t px-3 pb-3 pt-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          These passages were retrieved for this answer. Verify that each claim matches the evidence.
        </p>
        <div className="mt-3 space-y-4">
          {groups.map((group) => (
            <section key={group.sourceId} aria-label={`Evidence from ${group.source}`}>
              <h4 className="break-words text-xs font-semibold text-foreground">{group.source}</h4>
              <div className="mt-1.5 space-y-2">
                {group.passages.map(({ passage, n }) => (
                  <p
                    key={passage.chunk_id}
                    ref={(node) => {
                      if (node) passageRefs.current.set(n, node);
                      else passageRefs.current.delete(n);
                    }}
                    className={cn(
                      "whitespace-pre-wrap break-words rounded-lg border bg-card px-3 py-2.5 text-xs leading-relaxed text-foreground/80 transition-shadow",
                      n === highlightN && "ring-2 ring-primary",
                    )}
                  >
                    <span className="mr-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 align-middle text-[10px] font-semibold leading-none text-primary">
                      {n}
                    </span>
                    {passage.excerpt}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </details>
  );
}
