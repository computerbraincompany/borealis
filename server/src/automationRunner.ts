import { beginRun, completeRunWithAssistant, finishRunDurably } from "./chatRuns.js";
import { requireRemoteEgressConsent } from "./egressPolicy.js";
import { auditRemoteEgress } from "./egressAudit.js";
import { publicAgentFailureMessage } from "./routes/chats.js";
import { runAgent } from "./agent.js";
import { acceptChatTurn } from "./turnContext.js";
import { ActiveChatRunError } from "./db/stores/chatStore.js";
import { AutomationStore } from "./automationStore.js";
import { recordConnectorSync } from "./connectorSyncHistory.js";
import { storageRuntime } from "./storageRuntime.js";
import { SourceScopeError } from "./sourceScope.js";

const TICK_INTERVAL_MS = 60_000;
const MAX_DETAIL_CHARS = 500;

export interface AutomationRunnerDependencies {
  readonly store: AutomationStore;
  readonly syncConnector: (accountId: string, connectorId: string) => Promise<unknown>;
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
}

function safeDetail(error: unknown): string {
  // Run details are user-visible automation history: keep them generic.
  if (error instanceof SourceScopeError) return error.message.slice(0, MAX_DETAIL_CHARS);
  return "the automation could not complete this run";
}

export function createAutomationRunner(dependencies: AutomationRunnerDependencies) {
  const store = dependencies.store;
  const now = dependencies.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  async function executeConnectorSync(automationId: string, accountId: string, connectorId: string): Promise<void> {
    const startedAt = now().toISOString();
    const connector = await storageRuntime().sources.getConnector(accountId, connectorId);
    if (!connector) {
      await store.recordRun(automationId, accountId, "failed", "the bound connector no longer exists");
      // The v10 foreign key rejects history for a deleted connector; the write
      // is best effort and stays silent there.
      await recordConnectorSync({
        accountId,
        connectorId,
        trigger: "scheduled",
        outcome: "failed",
        detail: "the bound connector no longer exists",
        startedAt,
      });
      return;
    }
    if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
      await store.recordRun(automationId, accountId, "skipped", "a sync was already active");
      await recordConnectorSync({
        accountId,
        connectorId,
        trigger: "scheduled",
        outcome: "skipped",
        detail: "a sync was already active",
        startedAt,
      });
      return;
    }
    try {
      await dependencies.syncConnector(accountId, connectorId);
      await store.recordRun(automationId, accountId, "succeeded", null);
      await recordConnectorSync({ accountId, connectorId, trigger: "scheduled", outcome: "succeeded", startedAt });
    } catch (error) {
      const detail = safeDetail(error);
      await store.recordRun(automationId, accountId, "failed", detail);
      await recordConnectorSync({ accountId, connectorId, trigger: "scheduled", outcome: "failed", detail, startedAt });
    }
  }

  async function executeAgentTurn(
    automationId: string,
    accountId: string,
    chatId: string,
    prompt: string
  ): Promise<void> {
    try {
      await requireRemoteEgressConsent(accountId);
    } catch {
      await store.recordRun(automationId, accountId, "skipped", "remote egress consent is required");
      return;
    }
    void auditRemoteEgress("remote_turn", accountId);
    let turn;
    try {
      turn = await acceptChatTurn(accountId, chatId, prompt);
    } catch (error) {
      // The turn-acceptance boundary reports a busy chat as a 409 scope error.
      if (error instanceof ActiveChatRunError || (error instanceof SourceScopeError && error.statusCode === 409)) {
        await store.recordRun(automationId, accountId, "skipped", "the bound chat already has an active run");
        return;
      }
      await store.recordRun(automationId, accountId, "failed", "the bound chat could not accept this turn");
      return;
    }
    const controller = await beginRun(accountId, chatId, turn.runId);
    try {
      const completion = await runAgent({
        accountId,
        ...turn,
        agentInstructions: turn.agent?.instructions ?? null,
        content: turn.userMessage.content,
        emit: () => undefined,
        signal: controller.signal,
      });
      await completeRunWithAssistant(accountId, chatId, turn.runId, completion);
      await store.recordRun(automationId, accountId, "succeeded", null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        await finishRunDurably(accountId, chatId, turn.runId, "cancelled", "CANCELLED").catch(() => undefined);
        await store.recordRun(automationId, accountId, "skipped", "the run was cancelled");
        return;
      }
      await finishRunDurably(accountId, chatId, turn.runId, "failed", "AGENT_FAILED").catch(() => undefined);
      await store.recordRun(automationId, accountId, "failed", publicAgentFailureMessage());
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const claims = await store.claimDue(now());
      for (const claim of claims) {
        try {
          if (claim.kind === "connector_sync") {
            await executeConnectorSync(claim.id, claim.accountId, claim.targetId);
          } else {
            await executeAgentTurn(claim.id, claim.accountId, claim.targetId, claim.prompt ?? "");
          }
        } catch {
          // The executors record their own outcomes; this is the last resort.
          await store
            .recordRun(claim.id, claim.accountId, "failed", "the automation runner failed unexpectedly")
            .catch(() => undefined);
        }
      }
    } catch {
      // The tick is best-effort; the next interval retries.
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), dependencies.tickIntervalMs ?? TICK_INTERVAL_MS);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { start, stop, tick, isRunning: () => timer !== undefined };
}

export type AutomationRunner = ReturnType<typeof createAutomationRunner>;
