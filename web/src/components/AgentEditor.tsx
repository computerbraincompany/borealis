import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Upload } from "lucide-react";
import { agentsApi, agentSkillsApi, formatApiError, type AgentSummary, type AgentSkill } from "@/lib/api";
import { AgentIdentity, agentIcons, agentColors } from "./AgentIdentity";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { cn } from "@/lib/utils";

const toolCatalog = [
  ["retrieve", "Search documents", "Find relevant passages in the sources attached to this chat."],
  ["list_sources", "List sources", "See attached sources and their availability."],
  ["query_data", "Query data", "Answer questions with read-only SQL over attached datasets."],
  ["describe_data", "Explore datasets", "Inspect columns, statistics, and data distributions."],
  ["render_chart", "Create charts", "Turn query results into charts."],
  ["create_report", "Create reports", "Generate HTML and PDF reports from the conversation."],
  ["fetch_url", "Read shared links", "Read public URLs explicitly included in the current message."],
];
const textAreaClass =
  "w-full rounded-lg border bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
function initialDraft(agent?: AgentSummary) {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    icon: agent?.icon ?? "bot",
    color: agent?.color ?? "blue",
    tools: agent?.tools ?? toolCatalog.map(([id]) => id),
    skill_ids: agent?.skill_ids ?? [],
  };
}
export function AgentEditor({
  agent,
  onClose,
  onSaved,
}: {
  agent?: AgentSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(agent));
  const baseline = useRef(JSON.stringify(initialDraft(agent)));
  const [tab, setTab] = useState("general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<AgentSkill | null>(null);
  const [skillDraft, setSkillDraft] = useState<{
    id?: string;
    name: string;
    description: string;
    content: string;
  } | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [deleteSkill, setDeleteSkill] = useState<AgentSkill | null>(null);
  const importGeneration = useRef(0);
  const [skillError, setSkillError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    agentSkillsApi
      .list(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSkills(result.items);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setSkillsError(formatApiError(err, "Could not load skills"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSkillsLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);
  const change = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(draft) !== baseline.current || skillDraft !== null;
  const close = () => {
    if (busy || skillBusy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const totalChars =
    draft.instructions.length +
    skills
      .filter((skill) => draft.skill_ids.includes(skill.id))
      .reduce((sum, skill) => sum + skill.content.length + skill.name.length + 12, 0);
  const save = async () => {
    if (busy || skillBusy) return;
    if (!draft.name.trim() || !draft.instructions.trim()) {
      setTab("general");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (agent) await agentsApi.update(agent.id, draft);
      else
        await agentsApi.create(draft.name.trim(), draft.instructions, {
          description: draft.description,
          icon: draft.icon,
          color: draft.color,
          tools: draft.tools,
          skill_ids: draft.skill_ids,
        });
      if (mounted.current) onSaved();
    } catch (err) {
      if (mounted.current) setError(formatApiError(err, "Could not save the agent"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".md") || file.size > 40_000) {
      setSkillError("Choose a Markdown (.md) file of at most 40 KB.");
      return;
    }
    const generation = ++importGeneration.current;
    const text = await file.text();
    if (!mounted.current || generation !== importGeneration.current) return;
    let content = text;
    let name = file.name.replace(/\.md$/i, "");
    let description = "";
    const metadata = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (metadata) {
      content = text.slice(metadata[0].length);
      for (const line of metadata[1].split(/\r?\n/)) {
        const match = line.match(/^(name|description):\s*(.*?)\s*$/);
        if (match) {
          const value = match[2].replace(/^['"]|['"]$/g, "");
          if (match[1] === "name") name = value;
          else description = value;
        }
      }
    }
    setSkillDraft({ name, description, content });
    setSkillError(null);
  };
  const saveSkill = async () => {
    if (!skillDraft || skillBusy) return;
    setSkillBusy(true);
    setSkillError(null);
    try {
      const result = await agentSkillsApi.save(skillDraft, skillDraft.id);
      if (!mounted.current) return;
      setSkills((current) => [...current.filter((item) => item.id !== result.id), result]);
      setSkillDraft(null);
      setPreview(result);
    } catch (err) {
      if (mounted.current) setSkillError(formatApiError(err, "Could not save skill"));
    } finally {
      if (mounted.current) setSkillBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          className="flex h-[min(820px,90dvh)] max-w-5xl flex-col gap-0 overflow-hidden p-0"
          aria-busy={busy}
        >
          <header className="border-b px-6 py-5 pr-12">
            <DialogTitle>{agent ? "Edit agent" : "New agent"}</DialogTitle>
            <DialogDescription className="mt-1">
              Give your agent an identity and choose how it works. Changes apply to the next message.
            </DialogDescription>
          </header>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="flex shrink-0 items-center gap-4 border-b bg-muted/20 px-6 py-4 md:w-56 md:flex-col md:items-start md:border-b-0 md:border-r md:py-7">
              <AgentIdentity
                icon={draft.icon}
                color={draft.color}
                className="h-14 w-14 md:h-20 md:w-20 md:[&>svg]:h-9 md:[&>svg]:w-9"
              />
              <div className="min-w-0">
                <p className="break-words font-semibold">{draft.name.trim() || "Your agent"}</p>
                <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                  {draft.description || "A dedicated assistant for your work."}
                </p>
              </div>
              <div className="hidden space-y-2 text-xs text-muted-foreground md:block">
                <p>
                  {draft.skill_ids.length} {draft.skill_ids.length === 1 ? "skill" : "skills"}
                </p>
                <p>{draft.tools.length} built-in tools</p>
                <p className="border-t pt-4 leading-relaxed">Running messages keep their original configuration.</p>
              </div>
            </aside>
            <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="border-b px-5 py-3">
                <TabsList className="w-full justify-start" aria-label="Agent configuration">
                  <TabsTrigger value="general">General</TabsTrigger>
                  <TabsTrigger value="skills">Skills</TabsTrigger>
                  <TabsTrigger value="tools">Tools</TabsTrigger>
                </TabsList>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
                <TabsContent value="general" className="mt-0 space-y-5">
                  <label className="block space-y-2 text-sm font-medium">
                    Name
                    <Input
                      aria-label="Agent name"
                      value={draft.name}
                      onChange={(e) => change("name", e.target.value)}
                      maxLength={80}
                      placeholder="Finance analyst"
                      required
                    />
                  </label>
                  <label className="block space-y-2 text-sm font-medium">
                    Short description <span className="font-normal text-muted-foreground">(optional)</span>
                    <Input
                      value={draft.description}
                      onChange={(e) => change("description", e.target.value)}
                      maxLength={240}
                      placeholder="Turns financial data into clear answers"
                    />
                  </label>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">Icon</legend>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(agentIcons).map(([id, Icon]) => (
                        <button
                          key={id}
                          type="button"
                          aria-label={`${id} icon`}
                          aria-pressed={draft.icon === id}
                          onClick={() => change("icon", id)}
                          className={cn(
                            "flex h-10 w-10 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            draft.icon === id
                              ? "border-primary bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          <Icon className="h-5 w-5" />
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">Color</legend>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(agentColors).map(([id, tone]) => (
                        <button
                          key={id}
                          type="button"
                          aria-label={`${id} color`}
                          aria-pressed={draft.color === id}
                          onClick={() => change("color", id)}
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            draft.color === id ? "border-foreground" : "border-transparent",
                          )}
                          style={{ backgroundColor: tone }}
                        >
                          {draft.color === id && <Check className="h-4 w-4 text-slate-950" />}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="block space-y-2 text-sm font-medium">
                    <span className="flex justify-between gap-2">
                      System prompt
                      <span className="text-xs font-normal text-muted-foreground">
                        {draft.instructions.length.toLocaleString()} / 8,000
                      </span>
                    </span>
                    <textarea
                      aria-label="Agent instructions"
                      value={draft.instructions}
                      onChange={(e) => change("instructions", e.target.value)}
                      maxLength={8000}
                      rows={8}
                      className={textAreaClass}
                      placeholder="Describe the agent’s role, approach, tone, and important instructions."
                      required
                    />
                    <span className="block text-xs font-normal text-muted-foreground">
                      Borealis’s operating rules and data-access restrictions always apply.
                    </span>
                  </label>
                </TabsContent>
                <TabsContent value="tools" className="mt-0">
                  <h3 className="font-semibold">Built-in tools</h3>
                  <p className="mb-4 mt-1 text-sm text-muted-foreground">
                    Choose what this agent can do. Data tools use only this chat’s attached sources.
                  </p>
                  <div className="divide-y rounded-lg border">
                    {toolCatalog.map(([id, name, description]) => (
                      <label key={id} className="flex cursor-pointer items-start gap-3 p-4 hover:bg-muted/30">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-primary"
                          checked={draft.tools.includes(id)}
                          onChange={(e) =>
                            change(
                              "tools",
                              e.target.checked ? [...draft.tools, id] : draft.tools.filter((tool) => tool !== id),
                            )
                          }
                        />
                        <span>
                          <span className="block text-sm font-medium">{name}</span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {draft.tools.length === 0 && (
                    <p className="mt-3 text-sm text-muted-foreground">This agent will answer without built-in tools.</p>
                  )}
                </TabsContent>
                <TabsContent value="skills" className="mt-0 space-y-4">
                  <div>
                    <h3 className="font-semibold">Skills library</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Reusable Markdown instructions. Assign up to eight skills to this agent.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="min-w-40 flex-1"
                      aria-label="Search skills"
                      placeholder="Search skills…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSkillDraft({ name: "", description: "", content: "" });
                        setSkillError(null);
                      }}
                      disabled={skillBusy}
                    >
                      <Plus className="h-4 w-4" /> Create skill
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={skillBusy}>
                      <Upload className="h-4 w-4" /> Import Markdown
                    </Button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".md"
                      className="hidden"
                      onChange={(e) => {
                        void importFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </div>
                  {skillsLoading && <p className="text-sm text-muted-foreground">Loading skills…</p>}
                  {skillsError && (
                    <p role="alert" className="text-sm text-destructive">
                      {skillsError}
                    </p>
                  )}
                  {skillDraft ? (
                    <div className="space-y-3 rounded-lg border p-4">
                      <label className="block space-y-1 text-sm">
                        Skill name
                        <Input
                          value={skillDraft.name}
                          maxLength={80}
                          onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                          disabled={skillBusy}
                        />
                      </label>
                      <label className="block space-y-1 text-sm">
                        Description
                        <Input
                          value={skillDraft.description}
                          maxLength={240}
                          onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                          disabled={skillBusy}
                        />
                      </label>
                      <label className="block space-y-1 text-sm">
                        Markdown instructions
                        <textarea
                          rows={7}
                          className={textAreaClass}
                          value={skillDraft.content}
                          onChange={(e) => setSkillDraft({ ...skillDraft, content: e.target.value })}
                          disabled={skillBusy}
                        />
                      </label>
                      <p
                        className={cn(
                          "text-xs",
                          skillDraft.content.length > 8000 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {skillDraft.content.length.toLocaleString()} / 8,000 characters
                      </p>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" disabled={skillBusy} onClick={() => setSkillDraft(null)}>
                          Cancel skill
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            skillBusy ||
                            !skillDraft.name.trim() ||
                            !skillDraft.content.trim() ||
                            skillDraft.content.length > 8000
                          }
                          onClick={() => void saveSkill()}
                        >
                          {skillBusy ? "Saving…" : "Save skill"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y rounded-lg border">
                        {skills
                          .filter((skill) =>
                            `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map((skill) => (
                            <div key={skill.id} className="flex items-start gap-3 p-3">
                              <input
                                type="checkbox"
                                aria-label={`Assign ${skill.name}`}
                                className="mt-1 h-4 w-4 accent-primary"
                                checked={draft.skill_ids.includes(skill.id)}
                                disabled={!draft.skill_ids.includes(skill.id) && draft.skill_ids.length >= 8}
                                onChange={(e) =>
                                  change(
                                    "skill_ids",
                                    e.target.checked
                                      ? [...draft.skill_ids, skill.id]
                                      : draft.skill_ids.filter((id) => id !== skill.id),
                                  )
                                }
                              />
                              <button className="min-w-0 flex-1 text-left" onClick={() => setPreview(skill)}>
                                <span className="block text-sm font-medium">{skill.name}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {skill.description || `${skill.content.length.toLocaleString()} characters`}
                                </span>
                              </button>
                              <Button variant="ghost" size="sm" onClick={() => setSkillDraft(skill)}>
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Delete skill ${skill.name}`}
                                onClick={() => setDeleteSkill(skill)}
                              >
                                Delete
                              </Button>
                            </div>
                          ))}
                        {!skillsLoading && skills.length === 0 && (
                          <p className="p-6 text-center text-sm text-muted-foreground">
                            Create or import a skill to get started.
                          </p>
                        )}
                      </div>
                      {preview && (
                        <div className="rounded-lg border bg-muted/20 p-4">
                          <h4 className="text-sm font-medium">
                            {preview.name} · v{preview.version}
                          </h4>
                          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
                            {preview.content}
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                  {skillError && (
                    <p role="alert" className="text-sm text-destructive">
                      {skillError}
                    </p>
                  )}
                  <p className={cn("text-xs", totalChars > 32000 ? "text-destructive" : "text-muted-foreground")}>
                    {totalChars.toLocaleString()} / 32,000 combined characters. Library edits apply to the next message.
                  </p>
                </TabsContent>
              </div>
            </Tabs>
          </div>
          <footer className="shrink-0 border-t px-6 py-4">
            {error && (
              <p role="alert" className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {agent ? `Saves as version ${agent.current_version + 1}` : "Ready when you are"}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={close} disabled={busy || skillBusy}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void save()}
                  disabled={
                    busy ||
                    skillBusy ||
                    !draft.name.trim() ||
                    !draft.instructions.trim() ||
                    totalChars > 32000 ||
                    skillDraft !== null
                  }
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
                </Button>
              </div>
            </div>
          </footer>
        </DialogContent>
      </Dialog>
      {deleteSkill && (
        <ConfirmDialog
          title={`Delete skill “${deleteSkill.name}”?`}
          description="This removes the skill from your library. Other agents using it will need their skill selection updated before their next message."
          busy={skillBusy}
          onCancel={() => {
            if (!skillBusy) setDeleteSkill(null);
          }}
          onConfirm={() => {
            if (skillBusy) return;
            const target = deleteSkill;
            setSkillBusy(true);
            void agentSkillsApi
              .remove(target.id)
              .then(() => {
                if (!mounted.current) return;
                setSkills((current) => current.filter((skill) => skill.id !== target.id));
                setDraft((current) => ({ ...current, skill_ids: current.skill_ids.filter((id) => id !== target.id) }));
                setPreview((current) => (current?.id === target.id ? null : current));
                setDeleteSkill(null);
              })
              .catch((err) => {
                if (mounted.current) {
                  setError(formatApiError(err, "Could not delete skill"));
                  setDeleteSkill(null);
                }
              })
              .finally(() => {
                if (mounted.current) setSkillBusy(false);
              });
          }}
        />
      )}
      {confirmClose && (
        <ConfirmDialog
          title="Discard agent changes?"
          description="Your unsaved agent changes will be lost. Skills already saved to the library will remain."
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={onClose}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
