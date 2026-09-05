import { AgentIdentity } from "./AgentIdentity";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentSummary } from "@/lib/api";

interface AgentSelectorProps {
  /** Bound agent for an existing chat; selection is write-once at creation. */
  bound: { id: string; name: string; icon?: string; color?: string } | null;
  agents: AgentSummary[];
  selection: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /** True for existing chats: the chip displays the binding read-only. */
  locked: boolean;
  /** Catalog load failure surfaced inside the picker with a retry affordance. */
  error?: string | null;
  onRetry?: () => void;
  onSelect: (agentId: string | null) => void;
  onLoadMore: () => void | Promise<void>;
}

export function AgentSelector({
  bound,
  agents,
  selection,
  loading,
  hasMore,
  loadingMore,
  locked,
  error = null,
  onRetry,
  onSelect,
  onLoadMore,
}: AgentSelectorProps) {
  const selected = agents.find((agent) => agent.id === (bound?.id ?? selection));
  if (locked) {
    return (
      <span
        className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-secondary/50 px-2.5 text-xs font-medium text-muted-foreground"
        title="The agent binding was chosen when this chat was created and cannot change."
      >
        <AgentIdentity
          icon={bound?.icon ?? selected?.icon}
          color={bound?.color ?? selected?.color}
          className="h-5 w-5 [&>svg]:h-3.5 [&>svg]:w-3.5"
        />
        {bound ? `Agent: ${bound.name}` : "No agent"}
      </span>
    );
  }

  const selectedName = bound?.name ?? agents.find((agent) => agent.id === selection)?.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          title="Bind an agent to this chat. The binding applies to every turn and cannot change afterwards."
        >
          <AgentIdentity
            icon={bound?.icon ?? selected?.icon}
            color={bound?.color ?? selected?.color}
            className="h-5 w-5 [&>svg]:h-3.5 [&>svg]:w-3.5"
          />
          {selectedName ? `Agent: ${selectedName}` : "Agent: None"}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
        <DropdownMenuLabel>Bind at creation</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selection ?? ""}
          onValueChange={(value) => onSelect(value === "" ? null : value)}
        >
          <DropdownMenuRadioItem value="">No agent</DropdownMenuRadioItem>
          {loading ? (
            <DropdownMenuRadioItem value="__loading" disabled>
              Loading agents…
            </DropdownMenuRadioItem>
          ) : (
            agents.map((agent) => (
              <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                <AgentIdentity icon={agent.icon} color={agent.color} className="h-6 w-6 [&>svg]:h-4 [&>svg]:w-4" />{" "}
                {agent.name} · v{agent.current_version}
              </DropdownMenuRadioItem>
            ))
          )}
        </DropdownMenuRadioGroup>
        {error && !loading && (
          <DropdownMenuItem
            className="text-destructive"
            disabled={!onRetry}
            onSelect={(event) => {
              event.preventDefault();
              onRetry?.();
            }}
          >
            {error}
            {onRetry ? " — Retry" : ""}
          </DropdownMenuItem>
        )}
        {hasMore && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={loading || loadingMore}
              onSelect={(event) => {
                event.preventDefault();
                void onLoadMore();
              }}
            >
              {loadingMore && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {loadingMore ? "Loading more agents…" : "Load more agents"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
