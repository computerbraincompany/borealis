import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionDiscoveryInvalidError,
  ConnectionDiscoveryLimitError,
  ConnectionLimitError,
  ConnectionNotFoundError,
  ConnectionRevisionConflictError,
  ConnectionStore,
  ConnectionStatusError,
  DuplicateConnectionError,
  MAX_DISCOVERY_TOOLS,
  MAX_DISCOVERY_TOTAL_BYTES,
  MAX_TOOL_DESCRIPTOR_BYTES,
  type DiscoveredToolInput,
} from "../connections/store.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];

async function ledger(): Promise<TempSqliteLedger> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  return resource;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function insertUser(ledger: SqliteLedger, id: string = randomUUID()): Promise<string> {
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, `${id}@example.test`, "hash"]);
  return id;
}

const httpConfig = { url: "https://mcp.example.test/mcp" };
const stdioConfig = { command: "/usr/local/bin/mcp-fixture", args: ["--stdio"], cwd: "/tmp" };

function descriptor(name: string, padBytes = 0): DiscoveredToolInput {
  return {
    name,
    description: "",
    input_schema: padBytes > 0 ? { pad: "x".repeat(padBytes) } : { type: "object", properties: {} },
  };
}

function descriptorBytes(tool: DiscoveredToolInput): number {
  return Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, tool_input_schema: tool.input_schema }),
    "utf8"
  );
}

describe("connection store", () => {
  it("creates validated connections and enforces name, quota, and tenant rules", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const other = await insertUser(db);
    const store = new ConnectionStore(db);

    const created = await store.createConnection(account, { name: " Finance ", kind: "mcp_http", config: httpConfig });
    expect(created).toMatchObject({
      name: "Finance",
      kind: "mcp_http",
      revision: 1,
      discovery_revision: 0,
      enabled: true,
      status: "untested",
      status_code: null,
      config: { kind: "mcp_http", url: "https://mcp.example.test/mcp" },
    });
    const loopback = await store.createConnection(account, {
      name: "Dev",
      kind: "mcp_http",
      config: { url: "http://127.0.0.1:3123/mcp" },
    });
    expect(loopback.config.kind).toBe("mcp_http");
    await store.createConnection(account, { name: "Stdio", kind: "mcp_stdio", config: stdioConfig });
    await store.createConnection(other, { name: "Finance", kind: "mcp_http", config: httpConfig });

    await expect(
      store.createConnection(account, { name: "Finance", kind: "mcp_http", config: httpConfig })
    ).rejects.toBeInstanceOf(DuplicateConnectionError);
    for (const invalid of [
      { kind: "mcp_http", config: { url: "http://remote.example.com/mcp" } },
      { kind: "mcp_http", config: { url: "https://mcp.example.test/mcp?debug=1" } },
      { kind: "mcp_http", config: { url: "https://user:pw@mcp.example.test/mcp" } },
      { kind: "mcp_http", config: { url: "not a url" } },
      { kind: "mcp_http", config: { url: "https://mcp.example.test/mcp", extra: true } },
      { kind: "mcp_stdio", config: { command: "npx" } },
      { kind: "mcp_stdio", config: { command: "/usr/bin/true", args: Array.from({ length: 33 }, () => "a") } },
      { kind: "mcp_stdio", config: { command: "/usr/bin/true", args: ["x".repeat(201)] } },
      { kind: "mcp_stdio", config: { command: "/usr/bin/true", cwd: "relative" } },
      { kind: "webdav", config: {} },
    ] as const) {
      await expect(
        store.createConnection(account, { name: `Invalid ${JSON.stringify(invalid.kind)}`, ...invalid })
      ).rejects.toThrow();
    }

    for (let n = 4; n <= 20; n += 1) {
      await store.createConnection(account, { name: `Filler ${n}`, kind: "mcp_http", config: httpConfig });
    }
    await expect(
      store.createConnection(account, { name: "Twenty-first", kind: "mcp_http", config: httpConfig })
    ).rejects.toBeInstanceOf(ConnectionLimitError);
    // The quota is per account.
    await expect(
      store.createConnection(other, { name: "Twenty-first", kind: "mcp_http", config: httpConfig })
    ).resolves.toBeDefined();

    // Tenant scoping of reads.
    await expect(store.getConnection(other, created.id)).resolves.toBeUndefined();
    const page = await store.listConnections(account, { limit: 100, after: null });
    expect(page.items.length).toBe(20);
    expect(page.items.every((item) => item.kind === "mcp_http" || item.kind === "mcp_stdio")).toBe(true);
  });

  it("edits with optimistic revisions and keeps enabled toggles out of the configuration lineage", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const store = new ConnectionStore(db);
    const created = await store.createConnection(account, { name: "Edit", kind: "mcp_http", config: httpConfig });

    const renamed = await store.updateConnection(account, created.id, {
      expected_revision: 1,
      name: "Renamed",
    });
    expect(renamed).toMatchObject({ name: "Renamed", revision: 2 });

    const edited = await store.updateConnection(account, created.id, {
      expected_revision: 2,
      config: { url: "https://mcp2.example.test/mcp" },
    });
    expect(edited).toMatchObject({ revision: 3, status: "untested", config: { url: "https://mcp2.example.test/mcp" } });

    await expect(
      store.updateConnection(account, created.id, { expected_revision: 2, name: "Stale" })
    ).rejects.toBeInstanceOf(ConnectionRevisionConflictError);
    await expect(
      store.updateConnection(account, randomUUID(), { expected_revision: 1, name: "Ghost" })
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(
      store.updateConnection(account, created.id, { expected_revision: 3, enabled: false })
    ).resolves.toMatchObject({ enabled: false, revision: 3 });
    // A disabled connection keeps its revision lineage intact.
    const after = await store.updateConnection(account, created.id, {
      expected_revision: 3,
      enabled: true,
    });
    expect(after).toMatchObject({ enabled: true, revision: 3 });
  });

  it("publishes bounded discoveries with stable tool identities", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const other = await insertUser(db);
    const store = new ConnectionStore(db);
    const connection = await store.createConnection(account, {
      name: "Discover",
      kind: "mcp_http",
      config: httpConfig,
    });

    const first = await store.publishDiscovery(account, connection.id, [
      { name: "read_file", description: "Reads a file", input_schema: { type: "object" } },
      { name: "list_dir", description: "", input_schema: { type: "object" } },
    ]);
    expect(first.discovery_revision).toBe(1);
    expect(first.tools.map((tool) => tool.name)).toEqual(["read_file", "list_dir"]);
    expect(first.tools[0].tool_id).toMatch(/-/);

    const second = await store.publishDiscovery(account, connection.id, [
      {
        name: "list_dir",
        description: "Updated",
        input_schema: { type: "object", properties: { p: { type: "string" } } },
      },
      { name: "new_tool", description: "", input_schema: { type: "object" } },
    ]);
    expect(second.discovery_revision).toBe(2);
    const idsByName = new Map(first.tools.map((tool) => [tool.name, tool.tool_id]));
    expect(second.tools.find((tool) => tool.name === "list_dir")?.tool_id).toBe(idsByName.get("list_dir"));
    expect(second.tools.find((tool) => tool.name === "new_tool")?.tool_id).not.toBe(idsByName.get("read_file"));
    const tools = await store.listTools(account, connection.id);
    expect(tools.map((tool) => tool.name)).toEqual(["list_dir", "new_tool"]);
    // Only the current discovery survives in the ledger.
    await expect(
      db.all("SELECT 1 FROM connection_tool_snapshots WHERE connection_id=? AND discovery_revision=1", [connection.id])
    ).resolves.toEqual([]);
    const refreshed = await store.getConnection(account, connection.id);
    expect(refreshed).toMatchObject({ status: "ready", discovery_revision: 2 });
    await expect(store.listTools(other, connection.id)).resolves.toEqual([]);
  });

  it("reports explicit over-limit and invalid discovery without touching the previous snapshot", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const store = new ConnectionStore(db);
    const connection = await store.createConnection(account, { name: "Limits", kind: "mcp_http", config: httpConfig });
    const published = await store.publishDiscovery(account, connection.id, [
      { name: "keep", description: "", input_schema: { type: "object" } },
    ]);

    const overCount: DiscoveredToolInput[] = Array.from({ length: MAX_DISCOVERY_TOOLS + 1 }, (_, index) => ({
      name: `tool-${index}`,
      description: "",
      input_schema: { type: "object" },
    }));
    await expect(store.publishDiscovery(account, connection.id, overCount)).rejects.toBeInstanceOf(
      ConnectionDiscoveryLimitError
    );

    await expect(
      store.publishDiscovery(account, connection.id, [descriptor("huge", MAX_TOOL_DESCRIPTOR_BYTES)])
    ).rejects.toBeInstanceOf(ConnectionDiscoveryLimitError);

    // 33 descriptors of ~16.0 KiB each breach only the 512 KiB aggregate.
    const aggregate: DiscoveredToolInput[] = [];
    for (let index = 0; index < 33; index += 1) {
      const probe = descriptor(`pad-${index}`, 15_000);
      aggregate.push(probe);
    }
    const adjusted = aggregate.map((tool) => {
      let pad = 15_000;
      // Make each descriptor at least 16,000 and strictly under 16,384 bytes.
      while (descriptorBytes({ ...tool, input_schema: { pad: "x".repeat(pad) } }) < 16_000) pad += 1;
      const sized = { ...tool, input_schema: { pad: "x".repeat(pad) } };
      expect(descriptorBytes(sized)).toBeLessThan(MAX_TOOL_DESCRIPTOR_BYTES);
      return sized;
    });
    expect(adjusted.reduce((total, tool) => total + descriptorBytes(tool), 0)).toBeGreaterThan(
      MAX_DISCOVERY_TOTAL_BYTES
    );
    await expect(store.publishDiscovery(account, connection.id, adjusted)).rejects.toBeInstanceOf(
      ConnectionDiscoveryLimitError
    );

    await expect(
      store.publishDiscovery(account, connection.id, [
        { name: "dup", description: "", input_schema: { type: "object" } },
        { name: "dup", description: "", input_schema: { type: "object" } },
      ])
    ).rejects.toBeInstanceOf(ConnectionDiscoveryInvalidError);
    await expect(
      store.publishDiscovery(account, connection.id, [{ name: "bad", description: "", input_schema: [] as never }])
    ).rejects.toBeInstanceOf(ConnectionDiscoveryInvalidError);
    await expect(
      store.publishDiscovery(account, randomUUID(), [{ name: "x", description: "", input_schema: {} }])
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);

    // Nothing above mutated the published evidence.
    const tools = await store.listTools(account, connection.id);
    expect(tools.map((tool) => tool.tool_id)).toEqual(published.tools.map((tool) => tool.tool_id));
    const connectionAfter = await store.getConnection(account, connection.id);
    expect(connectionAfter).toMatchObject({ discovery_revision: 1, status: "ready" });
  });

  it("runs deletion cascade hooks inside the delete transaction and rolls them back on failure", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const store = new ConnectionStore(db);
    const connection = await store.createConnection(account, { name: "Cascade", kind: "mcp_http", config: httpConfig });
    await store.publishDiscovery(account, connection.id, [
      { name: "drop_me", description: "", input_schema: { type: "object" } },
    ]);

    const observed: boolean[] = [];
    let marks = 0;
    store.registerConnectionDeletionHook((transaction, accountId, connectionId) => {
      observed.push(transaction.get("SELECT id FROM connections WHERE id=?", [connectionId]) !== undefined);
      marks += 1;
      transaction.run("UPDATE users SET email=? WHERE id=?", [`marked-${marks}@example.test`, accountId]);
    });
    expect(await store.deleteConnection(account, connection.id)).toBe(true);
    expect(observed).toEqual([true]);
    await expect(db.get("SELECT email FROM users WHERE id=?", [account])).resolves.toEqual({
      email: "marked-1@example.test",
    });
    await expect(
      db.all("SELECT 1 FROM connection_tool_snapshots WHERE connection_id=?", [connection.id])
    ).resolves.toEqual([]);
    expect(await store.deleteConnection(account, connection.id)).toBe(false);

    const second = await store.createConnection(account, { name: "Rollback", kind: "mcp_http", config: httpConfig });
    store.registerConnectionDeletionHook(() => {
      throw new Error("binding migration failed");
    });
    await expect(store.deleteConnection(account, second.id)).rejects.toThrow("binding migration failed");
    await expect(store.getConnection(account, second.id)).resolves.toBeDefined();
    // The second attempt's hook write rolled back with the delete.
    await expect(db.get("SELECT email FROM users WHERE id=?", [account])).resolves.toMatchObject({
      email: "marked-1@example.test",
    });
  });

  it("records bounded status codes and refuses invalid state input", async () => {
    const { ledger: db } = await ledger();
    const account = await insertUser(db);
    const store = new ConnectionStore(db);
    const connection = await store.createConnection(account, { name: "Status", kind: "mcp_http", config: httpConfig });
    await store.recordStatus(account, connection.id, "error", "CONNECTION_HANDSHAKE_FAILED");
    await expect(store.getConnection(account, connection.id)).resolves.toMatchObject({
      status: "error",
      status_code: "CONNECTION_HANDSHAKE_FAILED",
      revision: 1,
    });
    await store.recordStatus(account, connection.id, "disconnected", null);
    await expect(store.getConnection(account, connection.id)).resolves.toMatchObject({
      status: "disconnected",
      status_code: null,
    });
    await expect(store.recordStatus(account, connection.id, "ready", "c".repeat(65))).rejects.toBeInstanceOf(
      ConnectionStatusError
    );
    // Cross-account status writes touch nothing.
    await store.recordStatus(randomUUID(), connection.id, "error", "X");
    await expect(store.getConnection(account, connection.id)).resolves.toMatchObject({ status: "disconnected" });
  });
});
