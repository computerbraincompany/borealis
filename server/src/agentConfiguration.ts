import { createHash } from "node:crypto";
import type { SqliteTransaction } from "./db/types.js";
import { isMcpToolSchemaSupported } from "./mcp/client.js";

export const AGENT_ICONS = [
  "bot",
  "sparkles",
  "chart",
  "book",
  "search",
  "code",
  "pen",
  "shield",
  "briefcase",
  "globe",
  "calculator",
  "lightbulb",
] as const;
export const AGENT_COLORS = ["blue", "violet", "rose", "orange", "amber", "green", "teal", "slate"] as const;
export const AGENT_TOOLS = [
  "retrieve",
  "list_sources",
  "query_data",
  "describe_data",
  "render_chart",
  "create_report",
  "fetch_url",
] as const;

// ---------------------------------------------------------------------------
// Connected-agent (MCP) binding selection — Connected agents stage 4.
// `tools` keeps its exact legacy meaning (built-in selection) so old clients
// stay compatible; MCP tools live in the separate `mcp_tools` collection.
// ---------------------------------------------------------------------------

export const MAX_MCP_BINDINGS = 16;
export const MAX_MCP_TOOL_DESCRIPTION_PROMPT_CHARS = 1_024;
export const MAX_JOB_STARTER_PROMPTS = 5;
export const MAX_JOB_STARTER_PROMPT_CHARS = 2_000;
export const MAX_JOB_LIBRARIES = 10;
export const MAX_JOB_INSTRUCTION_TEMPLATE_CHARS = 8_000;
/** Durable budget for one run's frozen MCP snapshot; the v21 schema CHECK is wider. */
export const MAX_RUN_MCP_SNAPSHOT_CHARS = 400_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AgentMcpBindingSelection {
  readonly connection_id: string;
  readonly tool_id: string;
  readonly discovery_revision: number;
  /** Explicit operator acknowledgement for a write-oriented tool. */
  readonly allow_write: boolean;
}

/**
 * Discriminated output-template reference. Only the bounded instruction
 * variant ships now; when the M13 document-template catalog lands it adds a
 * `template_id` variant here and existing stored configurations keep
 * decoding unchanged.
 */
export type AgentOutputTemplate = { readonly kind: "instruction"; readonly instruction: string };

export interface AgentJobSetup {
  readonly starter_prompts: readonly string[];
  readonly output_template: AgentOutputTemplate | null;
  readonly library_ids: readonly string[];
}

/** One validated MCP binding with its deterministic model-facing alias. */
export interface AgentMcpToolBinding {
  readonly alias: string;
  readonly connection_id: string;
  readonly tool_id: string;
  readonly discovery_revision: number;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  /**
   * Non-secret custody identity reference captured at turn acceptance
   * (`connectionAuthorizationReference`), never a token. Empty before a run.
   */
  readonly authorization_reference: string;
}

export interface AgentConfiguration {
  description: string;
  icon: string;
  color: string;
  tools: string[];
  skill_ids: string[];
  mcp_tools: AgentMcpBindingSelection[];
  job_setup: AgentJobSetup;
}
export const DEFAULT_AGENT_CONFIGURATION: AgentConfiguration = {
  description: "",
  icon: "bot",
  color: "blue",
  tools: [...AGENT_TOOLS],
  skill_ids: [],
  mcp_tools: [],
  job_setup: { starter_prompts: [], output_template: null, library_ids: [] },
};
export class AgentConfigurationError extends Error {
  constructor(message = "Invalid agent configuration.") {
    super(message);
    this.name = "AgentConfigurationError";
  }
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || value.includes("\0")) {
    throw new AgentConfigurationError(`Invalid agent configuration: ${field}.`);
  }
  return value;
}

function jobSetup(value: unknown): AgentJobSetup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentConfigurationError();
  const input = value as { starter_prompts?: unknown; output_template?: unknown; library_ids?: unknown };
  if (Object.keys(input).some((key) => key !== "starter_prompts" && key !== "output_template" && key !== "library_ids")) {
    throw new AgentConfigurationError();
  }
  const promptsRaw = input.starter_prompts === undefined ? [] : input.starter_prompts;
  if (!Array.isArray(promptsRaw) || promptsRaw.length > MAX_JOB_STARTER_PROMPTS) throw new AgentConfigurationError();
  const starterPrompts = promptsRaw.map((prompt) => boundedText(prompt, "starter prompt", MAX_JOB_STARTER_PROMPT_CHARS));

  let outputTemplate: AgentOutputTemplate | null = null;
  if (input.output_template !== undefined && input.output_template !== null) {
    const template = input.output_template as { kind?: unknown; instruction?: unknown };
    if (
      typeof template !== "object" ||
      Array.isArray(template) ||
      Object.keys(template).some((key) => key !== "kind" && key !== "instruction") ||
      template.kind !== "instruction"
    ) {
      // A `template_id` (or any other) variant is the M13 seam and is
      // refused until its catalog migration ships; nothing decodes blindly.
      throw new AgentConfigurationError("Invalid agent configuration: output template.");
    }
    outputTemplate = Object.freeze({
      kind: "instruction",
      instruction: boundedText(template.instruction, "output template", MAX_JOB_INSTRUCTION_TEMPLATE_CHARS),
    });
  }

  const librariesRaw = input.library_ids === undefined ? [] : input.library_ids;
  if (
    !Array.isArray(librariesRaw) ||
    librariesRaw.length > MAX_JOB_LIBRARIES ||
    new Set(librariesRaw).size !== librariesRaw.length ||
    librariesRaw.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) {
    throw new AgentConfigurationError();
  }
  return Object.freeze({
    starter_prompts: Object.freeze(starterPrompts),
    output_template: outputTemplate,
    library_ids: Object.freeze((librariesRaw as string[]).map((id) => id.toLowerCase())),
  });
}

function mcpBindingSelections(value: unknown): AgentMcpBindingSelection[] {
  if (!Array.isArray(value) || value.length > MAX_MCP_BINDINGS) throw new AgentConfigurationError();
  const selections: AgentMcpBindingSelection[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new AgentConfigurationError();
    const input = candidate as {
      connection_id?: unknown;
      tool_id?: unknown;
      discovery_revision?: unknown;
      allow_write?: unknown;
    };
    if (
      Object.keys(input).some(
        (key) => key !== "connection_id" && key !== "tool_id" && key !== "discovery_revision" && key !== "allow_write"
      ) ||
      typeof input.connection_id !== "string" ||
      !UUID_PATTERN.test(input.connection_id) ||
      typeof input.tool_id !== "string" ||
      !UUID_PATTERN.test(input.tool_id) ||
      !Number.isSafeInteger(input.discovery_revision) ||
      (input.discovery_revision as number) < 1 ||
      (input.allow_write !== undefined && typeof input.allow_write !== "boolean")
    ) {
      throw new AgentConfigurationError();
    }
    const connectionId = input.connection_id.toLowerCase();
    const toolId = input.tool_id.toLowerCase();
    const pair = `${connectionId}:${toolId}`;
    if (seen.has(pair)) throw new AgentConfigurationError();
    seen.add(pair);
    selections.push(
      Object.freeze({
        connection_id: connectionId,
        tool_id: toolId,
        discovery_revision: input.discovery_revision as number,
        allow_write: input.allow_write === true,
      })
    );
  }
  selections.sort(
    (left, right) =>
      left.connection_id.localeCompare(right.connection_id) || left.tool_id.localeCompare(right.tool_id)
  );
  return selections;
}

export function agentConfiguration(value: unknown): AgentConfiguration {
  const input = value as Partial<AgentConfiguration>;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentConfigurationError();
  const result = { ...DEFAULT_AGENT_CONFIGURATION, ...input };
  if (
    typeof result.description !== "string" ||
    result.description.length > 240 ||
    result.description.includes("\0") ||
    !AGENT_ICONS.includes(result.icon as (typeof AGENT_ICONS)[number]) ||
    !AGENT_COLORS.includes(result.color as (typeof AGENT_COLORS)[number])
  )
    throw new AgentConfigurationError();
  if (
    !Array.isArray(result.tools) ||
    result.tools.length > 7 ||
    new Set(result.tools).size !== result.tools.length ||
    result.tools.some((tool) => !AGENT_TOOLS.includes(tool as (typeof AGENT_TOOLS)[number]))
  )
    throw new AgentConfigurationError();
  if (
    !Array.isArray(result.skill_ids) ||
    result.skill_ids.length > 8 ||
    new Set(result.skill_ids).size !== result.skill_ids.length ||
    result.skill_ids.some((id) => typeof id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))
  )
    throw new AgentConfigurationError();
  return {
    description: result.description,
    icon: result.icon,
    color: result.color,
    tools: [...result.tools],
    skill_ids: [...result.skill_ids],
    mcp_tools: mcpBindingSelections(result.mcp_tools),
    job_setup: jobSetup(result.job_setup),
  };
}
export function decodeAgentConfiguration(raw: unknown): AgentConfiguration {
  return agentConfiguration(typeof raw === "string" ? JSON.parse(raw) : {});
}
export function resolveAgentSkills(
  transaction: SqliteTransaction,
  accountId: string,
  config: AgentConfiguration,
  instructions: string
): string {
  const parts = [instructions];
  for (const id of config.skill_ids) {
    const skill = transaction.get<{ name: string; content: string }>(
      "SELECT name,content FROM agent_skills WHERE id=? AND account_id=?",
      [id, accountId]
    );
    if (!skill)
      throw new AgentConfigurationError(
        "An assigned skill is unavailable. Edit this agent’s skills before continuing."
      );
    parts.push(`\n\n## Skill: ${skill.name}\n${skill.content}`);
  }
  const combined = parts.join("");
  if (combined.length > 32_000)
    throw new AgentConfigurationError(
      "The system prompt and selected skills exceed 32,000 characters. Remove a skill or shorten the prompt."
    );
  return combined;
}

// ---------------------------------------------------------------------------
// MCP binding resolution (selection-time validation and accept-time freeze).
// ---------------------------------------------------------------------------

/**
 * Deterministic opaque model-facing alias for one connection/tool pair: the
 * same binding always yields the same alias regardless of selection order,
 * it carries no connection identity in recoverable form, and it satisfies
 * provider tool-name character rules within the 64-character ceiling.
 */
export function mcpToolAlias(connectionId: string, toolId: string): string {
  return `mcp_${createHash("sha256")
    .update(`borealis-mcp-alias:v1|${connectionId}|${toolId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

const WRITE_NAME_TOKENS: ReadonlySet<string> = new Set([
  "create",
  "insert",
  "update",
  "delete",
  "drop",
  "remove",
  "write",
  "put",
  "post",
  "patch",
  "set",
  "send",
  "submit",
  "add",
  "append",
  "execute",
  "exec",
  "run",
  "invoke",
  "cancel",
  "reset",
  "purge",
  "truncate",
  "alter",
  "modify",
  "replace",
  "store",
  "save",
  "upload",
  "publish",
  "schedule",
  "spawn",
  "kill",
  "shutdown",
  "move",
  "rename",
  "record",
  "commit",
  "merge",
  "push",
  "deploy",
  "provision",
  "register",
  "grant",
  "revoke",
  "enable",
  "disable",
  "start",
  "stop",
  "restart",
  "pay",
  "charge",
  "transfer",
  "book",
  "order",
  "reserve",
]);
const WRITE_DESCRIPTION_PATTERN =
  /\b(delet\w*|drop\w*|writ(?:e|es|ing|ten)|insert\w*|updat\w*|overwrit\w*|remov\w*|purg\w*|truncat\w*|creat\w*|record\w*|send\w*|submi\w*|sav\w*|modif\w*|replac\w*)\b/i;

/**
 * Conservative, documented write-orientedness classifier over the frozen
 * descriptor text (a heuristic label, never a proof — the server never trusts
 * a remote `readOnlyHint` annotation as evidence either): the first or last
 * word of the tool name is a mutation verb, or the description uses one. A
 * tool the classifier flags as writing requires the explicit per-binding
 * `allow_write` operator acknowledgement; everything else is selectable by
 * default under the read-oriented policy of this wave.
 */
export function mcpToolLooksWriteOriented(name: string, description: string): boolean {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.length && (WRITE_NAME_TOKENS.has(words[0]) || WRITE_NAME_TOKENS.has(words[words.length - 1]))) return true;
  return WRITE_DESCRIPTION_PATTERN.test(description);
}

function sanitizedBindingDescription(toolName: string, connectionName: string, description: string): string {
  const collapsed = `${toolName} (connected tool via "${connectionName}") ${description}`
    .replace(/[\0\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.slice(0, MAX_MCP_TOOL_DESCRIPTION_PROMPT_CHARS);
}

/**
 * Validates every MCP binding of a configuration inside the caller's SQLite
 * transaction (network discovery never runs here): the connection must exist
 * for this account and be enabled, the tool must be present in the current
 * published discovery snapshot, its captured schema must be one this client
 * executes, and a write-classified tool needs the explicit allowance. When
 * `authorizationReferences` is supplied (turn acceptance), each binding also
 * requires its non-secret custody reference from before the transaction
 * opened, and the result is the frozen per-run descriptor set. Selection
 * validation (agent create/edit) omits references.
 */
export function resolveAgentMcpToolBindings(
  transaction: SqliteTransaction,
  accountId: string,
  config: AgentConfiguration,
  authorizationReferences?: Readonly<Record<string, string>>
): readonly AgentMcpToolBinding[] {
  if (!config.mcp_tools.length) return Object.freeze([]);
  const bindings: AgentMcpToolBinding[] = [];
  const seenAliases = new Set<string>();
  for (const selection of config.mcp_tools) {
    const connection = transaction.get<{ name: string; enabled: number | bigint; discovery_revision: number | bigint }>(
      "SELECT name,enabled,discovery_revision FROM connections WHERE id=? AND account_id=?",
      [selection.connection_id, accountId]
    );
    if (!connection) {
      throw new AgentConfigurationError(
        "A connected tool selected for this agent references a connection that no longer exists. Edit this agent's connected tools before continuing."
      );
    }
    if (Number(connection.enabled) !== 1) {
      throw new AgentConfigurationError(
        `The connection "${connection.name}" is disabled. Re-enable it or edit this agent's connected tools before continuing.`
      );
    }
    const discoveryRevision = Number(connection.discovery_revision);
    const tool = transaction.get<{ name: string; description: string; input_schema: string }>(
      `SELECT name,description,input_schema FROM connection_tool_snapshots
       WHERE connection_id=? AND account_id=? AND discovery_revision=? AND tool_id=?`,
      [selection.connection_id, accountId, discoveryRevision, selection.tool_id]
    );
    if (!tool) {
      throw new AgentConfigurationError(
        "A connected tool selected for this agent is no longer published by its connection. Re-discover and re-select its connected tools before continuing."
      );
    }
    let inputSchema: unknown;
    try {
      inputSchema = JSON.parse(tool.input_schema);
    } catch {
      throw new AgentConfigurationError(
        "A connected tool selected for this agent has an unreadable schema. Re-discover its tools before continuing."
      );
    }
    if (!isMcpToolSchemaSupported(inputSchema)) {
      throw new AgentConfigurationError(
        `The connected tool "${tool.name}" uses a schema this workspace refuses to execute. It cannot be selected.`
      );
    }
    if (mcpToolLooksWriteOriented(tool.name, tool.description) && !selection.allow_write) {
      throw new AgentConfigurationError(
        `The connected tool "${tool.name}" looks write-oriented and requires the explicit writing allowance on its binding. This workspace defaults to read-oriented integrations.`
      );
    }
    const alias = mcpToolAlias(selection.connection_id, selection.tool_id);
    if (seenAliases.has(alias)) throw new AgentConfigurationError("Connected tool aliases collided; re-select them.");
    seenAliases.add(alias);
    let authorizationReference = "";
    if (authorizationReferences) {
      const reference = authorizationReferences[selection.connection_id];
      if (typeof reference !== "string" || reference.length < 1) {
        throw new AgentConfigurationError(
          "The authorization state of a selected connected tool changed while this turn was starting. Try again."
        );
      }
      if (reference.startsWith("unavailable:")) {
        throw new AgentConfigurationError(
          `The stored credentials for connection "${connection.name}" are unavailable. Restore the connection before continuing this chat.`
        );
      }
      authorizationReference = reference;
    }
    bindings.push(
      Object.freeze({
        alias,
        connection_id: selection.connection_id,
        tool_id: selection.tool_id,
        discovery_revision: discoveryRevision,
        name: tool.name,
        description: sanitizedBindingDescription(tool.name, connection.name, tool.description),
        input_schema: Object.freeze({ ...(inputSchema as Record<string, unknown>) }),
        authorization_reference: authorizationReference,
      })
    );
  }
  return Object.freeze(bindings);
}

// ---------------------------------------------------------------------------
// Durable per-run snapshot codec (chat_runs.agent_mcp, schema v21).
// ---------------------------------------------------------------------------

/** Serializes the frozen run mapping for `chat_runs.agent_mcp`. */
export function encodeRunMcpSnapshot(bindings: readonly AgentMcpToolBinding[]): string | null {
  if (!bindings.length) return null;
  const serialized = JSON.stringify(
    bindings.map((binding) => ({
      alias: binding.alias,
      connection_id: binding.connection_id,
      tool_id: binding.tool_id,
      discovery_revision: binding.discovery_revision,
      name: binding.name,
      description: binding.description,
      input_schema: binding.input_schema,
      authorization_reference: binding.authorization_reference,
    }))
  );
  if (typeof serialized !== "string" || serialized.length > MAX_RUN_MCP_SNAPSHOT_CHARS) {
    throw new AgentConfigurationError(
      "The frozen connected-tool snapshot exceeds the supported size. Remove a connected tool before continuing."
    );
  }
  return serialized;
}

/** Strict decoder for the durable run snapshot; damaged payloads fail closed. */
export function decodeRunMcpSnapshot(raw: unknown): readonly AgentMcpToolBinding[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  if (typeof raw !== "string") throw new AgentConfigurationError();
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_MCP_BINDINGS) throw new AgentConfigurationError();
  const bindings: AgentMcpToolBinding[] = [];
  for (const candidate of parsed) {
    const entry = candidate as Record<string, unknown>;
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.alias !== "string" ||
      entry.alias.length < 1 ||
      entry.alias.length > 64 ||
      typeof entry.connection_id !== "string" ||
      !UUID_PATTERN.test(entry.connection_id) ||
      typeof entry.tool_id !== "string" ||
      !UUID_PATTERN.test(entry.tool_id) ||
      !Number.isSafeInteger(entry.discovery_revision) ||
      (entry.discovery_revision as number) < 1 ||
      typeof entry.name !== "string" ||
      entry.name.length < 1 ||
      entry.name.length > 128 ||
      /[\0\r\n]/.test(entry.name) ||
      typeof entry.description !== "string" ||
      entry.description.length > MAX_MCP_TOOL_DESCRIPTION_PROMPT_CHARS ||
      typeof entry.authorization_reference !== "string" ||
      entry.authorization_reference.length > 80 ||
      !entry.input_schema ||
      typeof entry.input_schema !== "object" ||
      Array.isArray(entry.input_schema)
    ) {
      throw new AgentConfigurationError();
    }
    bindings.push(
      Object.freeze({
        alias: entry.alias,
        connection_id: entry.connection_id,
        tool_id: entry.tool_id,
        discovery_revision: entry.discovery_revision as number,
        name: entry.name,
        description: entry.description,
        input_schema: Object.freeze({ ...(entry.input_schema as Record<string, unknown>) }),
        authorization_reference: entry.authorization_reference,
      })
    );
  }
  return Object.freeze(bindings);
}
