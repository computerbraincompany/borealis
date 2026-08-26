/**
 * Stable Borealis model identities mapped to the model ids LM Studio expects.
 *
 * The former proxy configuration used `openai/` as a provider selector. That
 * prefix was consumed by the proxy and was never sent to LM Studio, so it is
 * not part of any target id below.
 */
export const LLM_MODEL_ALIASES = Object.freeze({
  "qwen-chat": "qwen/qwen3.6-35b-a3b",
  "qwen-27b": "qwen3.8-27b-obliterated",
  nemotron: "nvidia/nemotron-3-nano",
  "nomic-embed": "text-embedding-nomic-embed-text-v1.5",
} as const);

export type LlmModelAlias = keyof typeof LLM_MODEL_ALIASES;

const targetToAlias = new Map<string, LlmModelAlias>(
  Object.entries(LLM_MODEL_ALIASES).map(([alias, target]) => [target, alias as LlmModelAlias])
);

/** Resolve one public logical id for an outbound OpenAI-compatible request. */
export function resolveLlmModelId(model: string): string {
  return Object.prototype.hasOwnProperty.call(LLM_MODEL_ALIASES, model)
    ? LLM_MODEL_ALIASES[model as LlmModelAlias]
    : model;
}

/** Convert a known LM Studio target back to the stable public logical id. */
export function publicLlmModelId(model: string): string {
  return targetToAlias.get(model) ?? model;
}

/** Compare logical and physical forms without exposing either value in errors. */
export function sameLlmModel(left: string, right: string): boolean {
  return resolveLlmModelId(left) === resolveLlmModelId(right);
}
