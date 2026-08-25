import { ChevronRight, Library } from "lucide-react";
import type { RetrievedEvidence as RetrievedEvidenceItem } from "@/lib/api";

interface EvidenceGroup {
  sourceId: string;
  source: string;
  passages: RetrievedEvidenceItem[];
}

function groupBySource(evidence: RetrievedEvidenceItem[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const bySource = new Map<string, EvidenceGroup>();

  for (const passage of evidence) {
    const existing = bySource.get(passage.source_id);
    if (existing) {
      existing.passages.push(passage);
      continue;
    }

    const group = {
      sourceId: passage.source_id,
      source: passage.source,
      passages: [passage],
    };
    bySource.set(passage.source_id, group);
    groups.push(group);
  }

  return groups;
}

export function RetrievedEvidence({ evidence }: { evidence: RetrievedEvidenceItem[] }) {
  if (evidence.length === 0) return null;

  const groups = groupBySource(evidence);

  return (
    <details className="group/evidence mt-3 overflow-hidden rounded-lg border bg-surface-subtle text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 font-medium text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
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
                {group.passages.map((passage) => (
                  <p
                    key={passage.chunk_id}
                    className="whitespace-pre-wrap break-words rounded-lg border bg-card px-3 py-2.5 text-xs leading-relaxed text-foreground/80"
                  >
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
