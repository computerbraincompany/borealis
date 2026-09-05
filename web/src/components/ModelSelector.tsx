import { ChevronDown, LoaderCircle, RefreshCw, X } from "lucide-react";
import { type ChatModelOption } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ModelSelectorProps {
  model: string;
  models: ChatModelOption[];
  discovery: "live" | "unavailable" | null;
  loading: boolean;
  pending: boolean;
  streaming: boolean;
  error: string | null;
  onChange: (model: string) => void;
  onRetry: () => void;
  onDismissError: () => void;
}

export function ModelSelector({
  model,
  models,
  discovery,
  loading,
  pending,
  streaming,
  error,
  onChange,
  onRetry,
  onDismissError,
}: ModelSelectorProps) {
  const advertised = models.some((option) => option.id === model);
  const savedOption = models.find((option) => option.id === model) ?? { id: model };
  const options = models;
  const unavailable = discovery === "unavailable";
  const unadvertised = discovery === "live" && !advertised;
  const disabled = pending || streaming;

  const status = pending
    ? "Saving…"
    : streaming
      ? "In use for this turn"
      : loading
        ? "Checking endpoint…"
        : unavailable
          ? "Catalog unavailable"
          : unadvertised
            ? "Not advertised"
            : null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-8 max-w-full justify-start px-2.5"
            aria-label={`Chat model: ${savedOption.display_name ?? (model || "Choose a model")}`}
            title={savedOption.display_name ?? (model || "Choose a model")}
          >
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Model
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-foreground">
              {savedOption.display_name ?? (model || "Choose a model")}
            </span>
            {status && <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">· {status}</span>}
            {pending ? (
              <LoaderCircle data-icon="inline-end" className="ml-auto animate-spin" />
            ) : (
              <ChevronDown data-icon="inline-end" className="ml-auto" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Chat model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={model}
              onValueChange={(next) => {
                if (next !== model) onChange(next);
              }}
            >
              {options.map((option) => {
                const isSavedUnadvertised = option.id === model && unadvertised;
                return (
                  <DropdownMenuRadioItem key={option.id} value={option.id} disabled={disabled}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-mono text-xs text-foreground" title={option.id}>
                        {option.display_name ?? option.id}
                      </span>
                      {(option.owned_by || isSavedUnadvertised) && (
                        <span className="text-[11px] text-muted-foreground">
                          {isSavedUnadvertised ? "Not advertised by endpoint" : `Owned by ${option.owned_by}`}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>

          {(loading || unavailable) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={loading || disabled} onSelect={onRetry}>
                  {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                  {loading ? "Checking endpoint…" : "Retry discovery"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {error && (
        <div className="flex max-w-md items-start gap-2 text-xs text-destructive" role="alert">
          <span className="pt-1">Model unchanged: {error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={onDismissError}
            aria-label="Dismiss model error"
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}
