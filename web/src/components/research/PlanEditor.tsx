import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  RESEARCH_PLAN_STEPS_MAX,
  RESEARCH_QUESTIONS_PER_STEP_MAX,
  RESEARCH_STEP_OBJECTIVE_MAX_CHARS,
  RESEARCH_STEP_QUESTION_MAX_CHARS,
  type ResearchPlan,
  type ResearchPlanStep,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function newStepId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Editable bounded research plan (M15 stage 4): at most 8 ordered steps, each
 * with one user-facing objective and 1–8 search questions. Steps can be
 * edited, reordered, and removed; ids are stable so a saved revision keeps
 * step identity across edits. Editing never starts execution — the plan is
 * durable only via the editor's CAS save.
 */
export function PlanEditor({
  plan,
  disabled,
  onChange,
}: {
  plan: ResearchPlan;
  disabled: boolean;
  onChange: (plan: ResearchPlan) => void;
}) {
  const steps = plan.steps;
  const totalQuestions = steps.reduce((sum, step) => sum + step.questions.length, 0);

  const patchStep = (index: number, patch: Partial<ResearchPlanStep>) => {
    onChange({
      steps: steps.map((step, at) => (at === index ? { ...step, ...patch } : step)),
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange({ steps: next });
  };

  return (
    <div className="space-y-3" aria-label="Research plan">
      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No plan yet. Generate a proposal or add steps manually, review the result, then save it as a revision before
          starting.
        </p>
      )}
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step.id} className="rounded-md border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Step {index + 1}</span>
              <div className="ml-auto flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move step ${index + 1} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move step ${index + 1} down`}
                  disabled={disabled || index === steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove step ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange({ steps: steps.filter((_, at) => at !== index) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <Textarea
              aria-label={`Objective for step ${index + 1}`}
              value={step.objective}
              maxLength={RESEARCH_STEP_OBJECTIVE_MAX_CHARS}
              disabled={disabled}
              className="mt-2 text-sm"
              placeholder="What this step should establish"
              onChange={(event) => patchStep(index, { objective: event.target.value })}
            />
            <ul className="mt-2 space-y-1.5">
              {step.questions.map((question, questionIndex) => (
                <li key={questionIndex} className="flex items-center gap-1.5">
                  <Input
                    aria-label={`Question ${questionIndex + 1} for step ${index + 1}`}
                    value={question}
                    maxLength={RESEARCH_STEP_QUESTION_MAX_CHARS}
                    disabled={disabled}
                    className="h-8 text-sm"
                    onChange={(event) =>
                      patchStep(index, {
                        questions: step.questions.map((entry, at) =>
                          at === questionIndex ? event.target.value : entry,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove question ${questionIndex + 1} from step ${index + 1}`}
                    disabled={disabled || step.questions.length <= 1}
                    onClick={() =>
                      patchStep(index, { questions: step.questions.filter((_, at) => at !== questionIndex) })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            {step.questions.length < RESEARCH_QUESTIONS_PER_STEP_MAX && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => patchStep(index, { questions: [...step.questions, ""] })}
              >
                <Plus className="h-3.5 w-3.5" /> Add question
              </Button>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || steps.length >= RESEARCH_PLAN_STEPS_MAX || totalQuestions >= 32}
          onClick={() =>
            onChange({
              steps: [...steps, { id: newStepId(), objective: "", questions: [""] }],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add step
        </Button>
        <span className="text-xs text-muted-foreground">
          {steps.length}/{RESEARCH_PLAN_STEPS_MAX} steps · {totalQuestions} search questions (a run performs at most 32)
        </span>
      </div>
    </div>
  );
}
