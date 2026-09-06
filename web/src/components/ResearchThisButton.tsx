import { ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stashResearchHandoff } from "@/lib/researchHandoff";

/**
 * Chat-to-research action (M15 stage 4): added to the chat header while the
 * chat holds concrete ready selected sources. It stashes the explicit ready
 * source ids (selected scope only — never `all`) and opens a new research
 * draft with that scope pre-filled. Nothing starts: the user reviews the
 * question, plan, and scope in the Research page first.
 */
export function ResearchThisButton({
  sourceIds,
  title,
}: {
  sourceIds: readonly string[];
  title: string | null | undefined;
}) {
  if (sourceIds.length === 0) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Research these sources"
      onClick={() => {
        // Bounds are enforced by the stash itself; an over-cap or failed
        // stash simply opens the blank new-draft surface instead.
        stashResearchHandoff({ sourceIds, title: title ?? undefined });
        window.location.hash = "#/research/new";
      }}
    >
      <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
      Research this
    </Button>
  );
}
