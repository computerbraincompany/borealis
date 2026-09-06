import { Plus, Trash2 } from "lucide-react";
import {
  RESEARCH_COLUMNS_MAX,
  RESEARCH_COLUMN_LABEL_MAX_CHARS,
  RESEARCH_COLUMN_QUESTION_MAX_CHARS,
  RESEARCH_COLUMN_UNIT_MAX_CHARS,
  RESEARCH_ENUM_CHOICES_MAX,
  RESEARCH_ENUM_CHOICE_MAX_CHARS,
  type ResearchColumnDeclaration,
  type ResearchColumnType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function newColumnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

const COLUMN_TYPES: readonly ResearchColumnType[] = ["text", "number", "date", "boolean", "enum"];

/**
 * Typed comparison column editor (M15 stage 4): up to 20 columns, each with a
 * stable id, label (≤80), question (≤500), type `text | number | date |
 * boolean | enum`, optional unit (≤40), and enum choices (≤20 unique members,
 * each ≤80). Bounds mirror `researchSchemas.ts`; the server remains the
 * authoritative validator. Column ids are stable so a rerun/revision diff
 * keeps column identity.
 */
export function ColumnEditor({
  columns,
  disabled,
  onChange,
}: {
  columns: ResearchColumnDeclaration[];
  disabled: boolean;
  onChange: (columns: ResearchColumnDeclaration[]) => void;
}) {
  const patch = (index: number, next: Partial<ResearchColumnDeclaration>) => {
    onChange(columns.map((column, at) => (at === index ? { ...column, ...next } : column)));
  };

  return (
    <div className="space-y-3" aria-label="Comparison columns">
      {columns.length === 0 && (
        <p className="text-sm text-muted-foreground">
          A comparison output needs at least one column: for example price (number + currency unit), effective date
          (date), renewal (boolean), tier (enum), or exceptions (text).
        </p>
      )}
      {columns.map((column, index) => (
        <div key={column.id} className="space-y-2 rounded-md border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Column {index + 1}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto"
              aria-label={`Remove column ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(columns.filter((_, at) => at !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label={`Label for column ${index + 1}`}
              value={column.label}
              maxLength={RESEARCH_COLUMN_LABEL_MAX_CHARS}
              disabled={disabled}
              placeholder="Label (e.g. Price)"
              onChange={(event) => patch(index, { label: event.target.value })}
            />
            <div className="flex gap-2">
              <select
                aria-label={`Type for column ${index + 1}`}
                value={column.type}
                disabled={disabled}
                className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                onChange={(event) =>
                  patch(index, {
                    type: event.target.value as ResearchColumnType,
                    choices: event.target.value === "enum" ? (column.choices ?? [""]) : null,
                  })
                }
              >
                {COLUMN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`Unit for column ${index + 1}`}
                value={column.unit ?? ""}
                maxLength={RESEARCH_COLUMN_UNIT_MAX_CHARS}
                disabled={disabled}
                placeholder="unit (optional)"
                className="flex-1"
                onChange={(event) => patch(index, { unit: event.target.value.trim() || null })}
              />
            </div>
          </div>
          <Input
            aria-label={`Question for column ${index + 1}`}
            value={column.question}
            maxLength={RESEARCH_COLUMN_QUESTION_MAX_CHARS}
            disabled={disabled}
            placeholder="What the run should extract for each row"
            onChange={(event) => patch(index, { question: event.target.value })}
          />
          {column.type === "enum" && (
            <div>
              <Label className="text-xs text-muted-foreground">
                Allowed choices (one per line, unique, ≤{RESEARCH_ENUM_CHOICES_MAX})
              </Label>
              <Textarea
                aria-label={`Enum choices for column ${index + 1}`}
                value={(column.choices ?? []).join("\n")}
                disabled={disabled}
                rows={3}
                className="mt-1 text-sm"
                onChange={(event) =>
                  patch(index, {
                    choices: event.target.value
                      .split("\n")
                      .map((choice) => choice.trim().slice(0, RESEARCH_ENUM_CHOICE_MAX_CHARS))
                      .filter((choice) => choice.length > 0)
                      .slice(0, RESEARCH_ENUM_CHOICES_MAX),
                  })
                }
              />
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || columns.length >= RESEARCH_COLUMNS_MAX}
          onClick={() =>
            onChange([
              ...columns,
              { id: newColumnId(), label: "", question: "", type: "text", unit: null, choices: null },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add column
        </Button>
        <span className="text-xs text-muted-foreground">
          {columns.length}/{RESEARCH_COLUMNS_MAX} columns
        </span>
      </div>
    </div>
  );
}
