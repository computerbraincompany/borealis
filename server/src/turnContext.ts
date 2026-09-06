import { AgentConfigurationError, type AgentMcpToolBinding } from "./agentConfiguration.js";
import { connectionService } from "./connections/service.js";
import { ActiveChatRunError, type AcceptChatTurnTestHooks } from "./db/stores/chatStore.js";
import { embeddingMigrationCoordinator, EmbeddingMigrationError } from "./embeddingMigration.js";
import { publicSourceScopeError, SourceScopeError, type ResolvedSourceScope } from "./sourceScope.js";
import { storageRuntime } from "./storageRuntime.js";

export interface AcceptedUserMessage {
  readonly id: number;
  readonly role: "user";
  readonly content: string;
  readonly meta: Readonly<{
    model: string;
    source_mode: "all" | "selected";
    source_ids: readonly string[];
    agent?: Readonly<{ id: string; name: string; version: number }>;
  }>;
  readonly created_at: string;
}

export interface AcceptedChatTurn {
  readonly automaticTitleBaseline?: string;
  readonly chatId: string;
  readonly model: string;
  readonly sourceScope: ResolvedSourceScope;
  /** Snapshot of the chat's bound agent at accept time; null when unbound. */
  readonly agent: Readonly<{
    id: string;
    name: string;
    version: number;
    instructions: string;
    tools: readonly string[];
    /** Frozen MCP binding set for this run; empty when none are selected. */
    mcp: readonly AgentMcpToolBinding[];
  }> | null;
  readonly userMessage: AcceptedUserMessage;
  readonly runId: string;
}

export type { AcceptChatTurnTestHooks };

/**
 * Capture the non-secret custody authorization references for every MCP
 * connection the bound agent selects. File/keychain reads run strictly
 * before the SQLite acceptance transaction (and any network discovery stays
 * out entirely). A connection whose custody cannot be read yields the
 * `unavailable:*` reference, which the store fails closed with an actionable
 * 409 — never a silently skipped binding.
 */
async function captureMcpAuthorizationReferences(
  accountId: string,
  chatId: string
): Promise<Readonly<Record<string, string>> | undefined> {
  const connectionIds = await storageRuntime().chats.getChatAgentMcpConnectionIds(accountId, chatId);
  if (!connectionIds.length) return undefined;
  const references: Record<string, string> = {};
  for (const connectionId of connectionIds) {
    references[connectionId] = await connectionService().authorizationReference(accountId, connectionId);
  }
  return references;
}

/** Accept one user message and its immutable model/source provenance atomically. */
export async function acceptChatTurn(
  accountId: string,
  chatId: string,
  content: string,
  testHooks: AcceptChatTurnTestHooks = {}
): Promise<AcceptedChatTurn> {
  try {
    const mcpAuthorizationReferences = await captureMcpAuthorizationReferences(accountId, chatId);
    return await embeddingMigrationCoordinator().runChatTurnAdmission(() =>
      storageRuntime().chats.acceptChatTurn(accountId, chatId, content, testHooks, {
        mcpAuthorizationReferences,
      })
    );
  } catch (error) {
    if (error instanceof AgentConfigurationError) throw new SourceScopeError(409, error.message);
    if (error instanceof ActiveChatRunError) throw new SourceScopeError(409, error.message);
    if (error instanceof EmbeddingMigrationError) {
      throw new SourceScopeError(409, "chat turns are paused while an embedding migration is applying");
    }
    throw publicSourceScopeError(error, "accept");
  }
}
