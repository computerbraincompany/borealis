import { randomUUID } from "node:crypto";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import { SqliteConstraintError, type SqliteLedger } from "../types.js";

export const MAX_AGENT_NAME_CHARS = 80;
export const MAX_AGENT_INSTRUCTION_CHARS = 8_000;
export const MAX_AGENT_INSTRUCTION_PROMPT_CHARS = 8_000;

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly current_version: number;
  readonly instructions: string;
  readonly instructions_chars: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AgentRevision {
  readonly version: number;
  readonly instructions: string;
  readonly created_at: string;
}

export interface AgentDetail extends AgentSummary {
  readonly revisions: readonly AgentRevision[];
}

export class DuplicateAgentError extends Error {
  constructor() {
    super("an agent with this name already exists");
    this.name = "DuplicateAgentError";
  }
}

export class AgentNotFoundError extends Error {
  constructor() {
    super("agent not found");
    this.name = "AgentNotFoundError";
  }
}

interface AgentRow {
  id?: unknown;
  name?: unknown;
  current_version?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  instructions?: unknown;
}

interface RevisionRow {
  version?: unknown;
  instructions?: unknown;
  created_at?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError(`${field} violates the agent store input contract`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function agentName(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > MAX_AGENT_NAME_CHARS || trimmed.includes("\0")) {
    throw new TypeError("agent name violates the agent store input contract");
  }
  return trimmed;
}

function agentInstructions(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > MAX_AGENT_INSTRUCTION_CHARS ||
    value.includes("\0")
  ) {
    throw new TypeError("agent instructions violate the agent store input contract");
  }
  return value;
}

function decodeTimestamp(row: AgentRow | RevisionRow, field: "created_at" | "updated_at"): string {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function decodeSummary(row: AgentRow): AgentSummary {
  const instructions = row.instructions as string;
  return Object.freeze({
    id: requiredId(row.id as string, "agent id"),
    name: row.name as string,
    current_version: Number(row.current_version),
    instructions,
    instructions_chars: instructions.length,
    created_at: decodeTimestamp(row, "created_at"),
    updated_at: decodeTimestamp(row, "updated_at"),
  });
}

export class AgentStore {
  constructor(private readonly ledger: SqliteLedger) {}

  async listAgents(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<AgentSummary>> {
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [requiredId(accountIdValue, "account id")];
    const after = page.after ? " AND (a.created_at,a.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<AgentRow>(
      `SELECT a.id,a.name,a.current_version,a.created_at,a.updated_at,
              (SELECT r.instructions FROM agent_revisions r
               WHERE r.agent_id=a.id AND r.version=a.current_version AND r.account_id=a.account_id) AS instructions
       FROM agents a
       WHERE a.account_id=?${after}
       ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodeSummary), page, (agent) => ({
      timestamp: agent.created_at,
      id: agent.id,
    }));
  }

  async createAgent(accountIdValue: string, nameValue: string, instructionsValue: string): Promise<AgentSummary> {
    const accountId = requiredId(accountIdValue, "account id");
    const name = agentName(nameValue);
    const instructions = agentInstructions(instructionsValue);
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      await this.ledger.withImmediateTransaction((transaction) => {
        transaction.run(
          "INSERT INTO agents (id,account_id,name,current_version,created_at,updated_at) VALUES (?,?,?,1,?,?)",
          [id, accountId, name, timestamp, timestamp]
        );
        transaction.run(
          "INSERT INTO agent_revisions (agent_id,version,account_id,instructions,created_at) VALUES (?,1,?,?,?)",
          [id, accountId, instructions, timestamp]
        );
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateAgentError();
      throw error;
    }
    const row = await this.ledger.get<AgentRow>(
      `SELECT a.id,a.name,a.current_version,a.created_at,a.updated_at,r.instructions
       FROM agents a JOIN agent_revisions r ON r.agent_id=a.id AND r.version=a.current_version AND r.account_id=a.account_id
       WHERE a.id=? AND a.account_id=?`,
      [id, accountId]
    );
    if (!row) throw new AgentNotFoundError();
    return decodeSummary(row);
  }

  async getAgentDetail(accountIdValue: string, agentIdValue: string): Promise<AgentDetail | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const agentId = requiredId(agentIdValue, "agent id");
    const row = await this.ledger.get<AgentRow>(
      `SELECT a.id,a.name,a.current_version,a.created_at,a.updated_at,r.instructions
       FROM agents a JOIN agent_revisions r ON r.agent_id=a.id AND r.version=a.current_version AND r.account_id=a.account_id
       WHERE a.id=? AND a.account_id=?`,
      [agentId, accountId]
    );
    if (!row) return undefined;
    const revisions = await this.ledger.all<RevisionRow>(
      "SELECT version,instructions,created_at FROM agent_revisions WHERE agent_id=? AND account_id=? ORDER BY version DESC",
      [agentId, accountId]
    );
    return Object.freeze({
      ...decodeSummary(row),
      revisions: revisions.map((revision) =>
        Object.freeze({
          version: Number(revision.version),
          instructions: revision.instructions as string,
          created_at: decodeTimestamp(revision, "created_at"),
        })
      ),
    });
  }

  async renameAgent(
    accountIdValue: string,
    agentIdValue: string,
    nameValue: string
  ): Promise<AgentSummary | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const agentId = requiredId(agentIdValue, "agent id");
    const name = agentName(nameValue);
    try {
      const updated = await this.ledger.run(
        "UPDATE agents SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND account_id=?",
        [name, agentId, accountId]
      );
      if (updated.changes !== 1) return undefined;
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateAgentError();
      throw error;
    }
    return this.getAgentSummary(accountId, agentId);
  }

  /** A new instruction set becomes the next immutable revision. */
  async reviseAgent(
    accountIdValue: string,
    agentIdValue: string,
    instructionsValue: string
  ): Promise<AgentSummary | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const agentId = requiredId(agentIdValue, "agent id");
    const instructions = agentInstructions(instructionsValue);
    // The summary read happens after the transaction closes; reading through
    // the ledger inside the open immediate transaction would self-deadlock.
    const revised = await this.ledger.withImmediateTransaction(async (transaction) => {
      const agent = transaction.get<{ current_version?: unknown }>(
        "SELECT current_version FROM agents WHERE id=? AND account_id=?",
        [agentId, accountId]
      );
      if (!agent) return false;
      const nextVersion = Number(agent.current_version) + 1;
      transaction.run(
        "INSERT INTO agent_revisions (agent_id,version,account_id,instructions,created_at) VALUES (?,?,?,?,?)",
        [agentId, nextVersion, accountId, instructions, new Date().toISOString()]
      );
      transaction.run(
        "UPDATE agents SET current_version=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND account_id=?",
        [nextVersion, agentId, accountId]
      );
      return true;
    });
    return revised ? this.getAgentSummary(accountId, agentId) : undefined;
  }

  async deleteAgent(accountIdValue: string, agentIdValue: string): Promise<boolean> {
    const updated = await this.ledger.run("DELETE FROM agents WHERE id=? AND account_id=?", [
      requiredId(agentIdValue, "agent id"),
      requiredId(accountIdValue, "account id"),
    ]);
    return updated.changes === 1;
  }

  private async getAgentSummary(accountId: string, agentId: string): Promise<AgentSummary | undefined> {
    const row = await this.ledger.get<AgentRow>(
      `SELECT a.id,a.name,a.current_version,a.created_at,a.updated_at,r.instructions
       FROM agents a JOIN agent_revisions r ON r.agent_id=a.id AND r.version=a.current_version AND r.account_id=a.account_id
       WHERE a.id=? AND a.account_id=?`,
      [agentId, accountId]
    );
    return row ? decodeSummary(row) : undefined;
  }
}
