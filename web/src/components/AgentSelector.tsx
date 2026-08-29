import { Bot, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

interface AgentSelectorProps {
  /** Bound agent for an existing chat; selection is write-once at creation. */
  bound: { id: string; name: string } | null;
  agents: AgentSummary[];
  selection: string | null;
  loading: boolean;
  /** True for existing chats: the chip displays the binding read-only. */
  locked: boolean;
  onSelect: (agentId: string | null) => void;
}

export function AgentSelector({ bound, agents, selection, loading, locked, onSelect }: AgentSelectorProps) {
  if (locked) {
    return (
      <span
        className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-secondary/50 px-2.5 text-xs font-medium text-muted-foreground"
        title="The agent binding was chosen when this chat was created and cannot change."
      >
        <Bot className="h-3.5 w-3.5" aria-hidden />
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
          <Bot className={cn("h-3.5 w-3.5", selection && "text-primary")} aria-hidden />
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
                {agent.name} · v{agent.current_version}
              </DropdownMenuRadioItem>
            ))
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
