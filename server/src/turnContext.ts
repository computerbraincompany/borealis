import { ActiveChatRunError, type AcceptChatTurnTestHooks } from "./db/stores/chatStore.js";
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
  }>;
  readonly created_at: string;
}

export interface AcceptedChatTurn {
  readonly chatId: string;
  readonly model: string;
  readonly sourceScope: ResolvedSourceScope;
  readonly userMessage: AcceptedUserMessage;
  readonly runId: string;
}

export type { AcceptChatTurnTestHooks };

/** Accept one user message and its immutable model/source provenance atomically. */
export async function acceptChatTurn(
  accountId: string,
  chatId: string,
  content: string,
  testHooks: AcceptChatTurnTestHooks = {}
): Promise<AcceptedChatTurn> {
  try {
    return await storageRuntime().chats.acceptChatTurn(accountId, chatId, content, testHooks);
  } catch (error) {
    if (error instanceof ActiveChatRunError) throw new SourceScopeError(409, error.message);
    throw publicSourceScopeError(error, "accept");
  }
}
