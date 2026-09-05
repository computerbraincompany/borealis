import type { SqliteTransaction } from "./db/types.js";

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
export interface AgentConfiguration {
  description: string;
  icon: string;
  color: string;
  tools: string[];
  skill_ids: string[];
}
export const DEFAULT_AGENT_CONFIGURATION: AgentConfiguration = {
  description: "",
  icon: "bot",
  color: "blue",
  tools: [...AGENT_TOOLS],
  skill_ids: [],
};
export class AgentConfigurationError extends Error {
  constructor(message = "Invalid agent configuration.") {
    super(message);
    this.name = "AgentConfigurationError";
  }
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
