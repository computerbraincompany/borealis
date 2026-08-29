import { randomUUID } from "node:crypto";
import { SqliteConstraintError, type SqliteLedger } from "./db/types.js";

export const AUTOMATION_NAME_MAX = 80;
export const AUTOMATION_PROMPT_MAX = 8_000;
export const AUTOMATION_MIN_SCHEDULE_MINUTES = 15;
export const AUTOMATION_MAX_SCHEDULE_MINUTES = 10_080;
export const AUTOMATION_MAX_FAILURES_BEFORE_PAUSE = 5;
export const AUTOMATION_RUN_DETAIL_MAX = 500;

export type AutomationKind = "connector_sync" | "agent_turn";
export type AutomationState = "active" | "paused";
export type AutomationRunOutcome = "succeeded" | "failed" | "skipped";

export interface Automation {
  readonly id: string;
  readonly name: string;
  readonly kind: AutomationKind;
  readonly target_id: string;
  readonly prompt: string | null;
  readonly schedule_minutes: number;
  readonly state: AutomationState;
  readonly consecutive_failures: number;
  readonly last_run_at: string | null;
  readonly next_run_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AutomationRun {
  readonly id: number;
  readonly outcome: AutomationRunOutcome;
  readonly detail: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationValidationError";
  }
}

interface AutomationRow {
  [column: string]: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError(`${field} violates the automation store input contract`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

export class AutomationStore {
  constructor(private readonly ledger: SqliteLedger) {}

  private decode(row: AutomationRow): Automation {
    return Object.freeze({
      id: String(row.id),
      name: String(row.name),
      kind: row.kind as AutomationKind,
      target_id: String(row.target_id),
      prompt: row.prompt === null || row.prompt === undefined ? null : String(row.prompt),
      schedule_minutes: Number(row.schedule_minutes),
      state: row.state as AutomationState,
      consecutive_failures: Number(row.consecutive_failures ?? 0),
      last_run_at: row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
      next_run_at: String(row.next_run_at),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    });
  }

  async create(input: {
    accountId: string;
    name: unknown;
    kind: unknown;
    targetId: unknown;
    prompt?: unknown;
    scheduleMinutes: unknown;
    now?: Date;
  }): Promise<Automation> {
    const accountId = requiredId(input.accountId, "account id");
    const name =
      typeof input.name === "string" && input.name.trim().length >= 1 && input.name.trim().length <= AUTOMATION_NAME_MAX
        ? input.name.trim()
        : (() => {
            throw new AutomationValidationError("name must contain between 1 and 80 characters");
          })();
    const kind = input.kind === "connector_sync" || input.kind === "agent_turn" ? input.kind : null;
    if (!kind) throw new AutomationValidationError("kind must be connector_sync or agent_turn");
    const targetId = requiredId(typeof input.targetId === "string" ? input.targetId : "", "target id");
    const schedule =
      typeof input.scheduleMinutes === "number" &&
      Number.isInteger(input.scheduleMinutes) &&
      input.scheduleMinutes >= AUTOMATION_MIN_SCHEDULE_MINUTES &&
      input.scheduleMinutes <= AUTOMATION_MAX_SCHEDULE_MINUTES
        ? input.scheduleMinutes
        : (() => {
            throw new AutomationValidationError(
              `schedule_minutes must be between ${AUTOMATION_MIN_SCHEDULE_MINUTES} and ${AUTOMATION_MAX_SCHEDULE_MINUTES}`
            );
          })();
    let prompt: string | null = null;
    if (kind === "agent_turn") {
      prompt =
        typeof input.prompt === "string" &&
        input.prompt.trim().length >= 1 &&
        input.prompt.length <= AUTOMATION_PROMPT_MAX
          ? input.prompt
          : (() => {
              throw new AutomationValidationError("agent_turn automations need a prompt of at most 8,000 characters");
            })();
    }

    const id = randomUUID();
    const at = (input.now ?? new Date()).toISOString();
    const nextRun = new Date((input.now ?? new Date()).getTime() + schedule * 60_000).toISOString();
    try {
      await this.ledger.withImmediateTransaction(async (transaction) => {
        transaction.run(
          `INSERT INTO automations (id,account_id,name,kind,target_id,prompt,schedule_minutes,next_run_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, accountId, name, kind, targetId, prompt, schedule, nextRun, at, at]
        );
        if (kind === "connector_sync") {
          const owned = transaction.get("SELECT 1 FROM connectors WHERE id=? AND account_id=?", [targetId, accountId]);
          if (!owned) throw new AutomationValidationError("target_id must reference a connector of this account");
        } else {
          const owned = transaction.get("SELECT 1 FROM chats WHERE id=? AND account_id=?", [targetId, accountId]);
          if (!owned) throw new AutomationValidationError("target_id must reference a chat of this account");
        }
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") {
        throw new AutomationValidationError("an automation with this name already exists");
      }
      throw error;
    }
    const row = await this.ledger.get<AutomationRow>("SELECT * FROM automations WHERE id=? AND account_id=?", [
      id,
      accountId,
    ]);
    if (!row) throw new AutomationValidationError("automation insert did not persist");
    return this.decode(row);
  }

  async list(accountIdValue: string): Promise<Automation[]> {
    const rows = await this.ledger.all<AutomationRow>(
      "SELECT * FROM automations WHERE account_id=? ORDER BY created_at DESC,id DESC",
      [requiredId(accountIdValue, "account id")]
    );
    return rows.map((row) => this.decode(row));
  }

  async get(accountIdValue: string, automationIdValue: string): Promise<Automation | undefined> {
    const row = await this.ledger.get<AutomationRow>("SELECT * FROM automations WHERE id=? AND account_id=?", [
      requiredId(automationIdValue, "automation id"),
      requiredId(accountIdValue, "account id"),
    ]);
    return row ? this.decode(row) : undefined;
  }

  async update(
    accountIdValue: string,
    automationIdValue: string,
    patch: { name?: unknown; state?: unknown; scheduleMinutes?: unknown }
  ): Promise<Automation | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const automationId = requiredId(automationIdValue, "automation id");
    const assignments: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) {
      const name =
        typeof patch.name === "string" &&
        patch.name.trim().length >= 1 &&
        patch.name.trim().length <= AUTOMATION_NAME_MAX
          ? patch.name.trim()
          : (() => {
              throw new AutomationValidationError("name must contain between 1 and 80 characters");
            })();
      assignments.push("name=?");
      values.push(name);
    }
    if (patch.state !== undefined) {
      if (patch.state !== "active" && patch.state !== "paused") {
        throw new AutomationValidationError("state must be active or paused");
      }
      assignments.push("state=?");
      values.push(patch.state);
    }
    if (patch.scheduleMinutes !== undefined) {
      if (
        typeof patch.scheduleMinutes !== "number" ||
        !Number.isInteger(patch.scheduleMinutes) ||
        patch.scheduleMinutes < AUTOMATION_MIN_SCHEDULE_MINUTES ||
        patch.scheduleMinutes > AUTOMATION_MAX_SCHEDULE_MINUTES
      ) {
        throw new AutomationValidationError(
          `schedule_minutes must be between ${AUTOMATION_MIN_SCHEDULE_MINUTES} and ${AUTOMATION_MAX_SCHEDULE_MINUTES}`
        );
      }
      assignments.push("schedule_minutes=?");
      values.push(patch.scheduleMinutes);
    }
    if (!assignments.length) return this.get(accountId, automationId);
    assignments.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    try {
      const updated = await this.ledger.run(
        `UPDATE automations SET ${assignments.join(",")} WHERE id=? AND account_id=?`,
        [...values, automationId, accountId]
      );
      if (updated.changes !== 1) return undefined;
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") {
        throw new AutomationValidationError("an automation with this name already exists");
      }
      throw error;
    }
    return this.get(accountId, automationId);
  }

  async delete(accountIdValue: string, automationIdValue: string): Promise<boolean> {
    const updated = await this.ledger.run("DELETE FROM automations WHERE id=? AND account_id=?", [
      requiredId(automationIdValue, "automation id"),
      requiredId(accountIdValue, "account id"),
    ]);
    return updated.changes === 1;
  }

  async listRuns(accountIdValue: string, automationIdValue: string, limitValue: number): Promise<AutomationRun[]> {
    const limit = Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 50 ? limitValue : 20;
    const rows = await this.ledger.all<AutomationRow>(
      `SELECT ar.id,ar.outcome,ar.detail,ar.started_at,ar.finished_at
       FROM automation_runs ar
       JOIN automations a ON a.id=ar.automation_id AND a.account_id=ar.account_id
       WHERE ar.automation_id=? AND ar.account_id=?
       ORDER BY ar.started_at DESC,ar.id DESC LIMIT ?`,
      [requiredId(automationIdValue, "automation id"), requiredId(accountIdValue, "account id"), limit]
    );
    return rows.map((row) =>
      Object.freeze({
        id: Number(row.id),
        outcome: row.outcome as AutomationRunOutcome,
        detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
        started_at: String(row.started_at),
        finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
      })
    );
  }

  /**
   * Atomically claims the due, active automations and reschedules them. At
   * least once: a crash after claim simply skips to the next interval.
   */
  async claimDue(
    now: Date
  ): Promise<
    ReadonlyArray<{ id: string; accountId: string; kind: AutomationKind; targetId: string; prompt: string | null }>
  > {
    return this.ledger.withImmediateTransaction((transaction) => {
      const rows = transaction.all<AutomationRow>(
        `SELECT * FROM automations WHERE state='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 20`,
        [now.toISOString()]
      );
      const claims: Array<{
        id: string;
        accountId: string;
        kind: AutomationKind;
        targetId: string;
        prompt: string | null;
      }> = [];
      for (const row of rows) {
        const schedule = Number(row.schedule_minutes);
        const nextRun = new Date(now.getTime() + schedule * 60_000).toISOString();
        transaction.run("UPDATE automations SET last_run_at=?,next_run_at=? WHERE id=?", [
          now.toISOString(),
          nextRun,
          String(row.id),
        ]);
        claims.push({
          id: String(row.id),
          accountId: String(row.account_id),
          kind: row.kind as AutomationKind,
          targetId: String(row.target_id),
          prompt: row.prompt === null || row.prompt === undefined ? null : String(row.prompt),
        });
      }
      return claims;
    });
  }

  async recordRun(
    automationIdValue: string,
    accountIdValue: string,
    outcome: AutomationRunOutcome,
    detail: string | null
  ): Promise<void> {
    const automationId = requiredId(automationIdValue, "automation id");
    const accountId = requiredId(accountIdValue, "account id");
    const finished = new Date().toISOString();
    await this.ledger.withImmediateTransaction(async (transaction) => {
      transaction.run(
        "INSERT INTO automation_runs (automation_id,account_id,outcome,detail,finished_at) VALUES (?,?,?,?,?)",
        [
          automationId,
          accountId,
          outcome,
          detail === null ? null : detail.slice(0, AUTOMATION_RUN_DETAIL_MAX),
          finished,
        ]
      );
      if (outcome === "failed") {
        transaction.run(
          `UPDATE automations SET
             consecutive_failures=consecutive_failures+1,
             state=CASE WHEN consecutive_failures+1>=? THEN 'paused' ELSE state END,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND account_id=?`,
          [AUTOMATION_MAX_FAILURES_BEFORE_PAUSE, automationId, accountId]
        );
      } else if (outcome === "succeeded") {
        transaction.run(
          "UPDATE automations SET consecutive_failures=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND account_id=?",
          [automationId, accountId]
        );
      }
    });
  }
}
