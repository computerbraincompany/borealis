/**
 * Connected-agents stage 4 — agent configuration codec matrix for the new
 * `mcp_tools` and `job_setup` collections. Pure-codec behavior only (the
 * database-backed selection validation lives in `mcpAgentTurn.test.ts`):
 * legacy configurations decode unchanged, canonical ordering/normalization,
 * structural budgets, the deterministic opaque alias surface, the
 * read-oriented write classifier over the committed fixture inventory, and
 * the durable run-snapshot codec budgets.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_CONFIGURATION,
  MAX_MCP_BINDINGS,
  MAX_RUN_MCP_SNAPSHOT_CHARS,
  agentConfiguration,
  decodeAgentConfiguration,
  decodeRunMcpSnapshot,
  encodeRunMcpSnapshot,
  mcpToolAlias,
  mcpToolLooksWriteOriented,
  type AgentMcpToolBinding,
} from "../agentConfiguration.js";

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const TOOL_A = "22222222-2222-4222-8222-222222222222";
const TOOL_B = "33333333-3333-4333-8333-333333333333";

function binding(overrides: Record<string, unknown> = {}) {
  return { connection_id: CONNECTION, tool_id: TOOL_A, discovery_revision: 1, ...overrides };
}

describe("agent configuration codec — legacy compatibility", () => {
  it("decodes historical configurations with empty new collections", () => {
    const legacy = decodeAgentConfiguration(
      JSON.stringify({ description: "old", icon: "bot", color: "blue", tools: ["retrieve"], skill_ids: [] })
    );
    expect(legacy.mcp_tools).toEqual([]);
    expect(legacy.job_setup).toEqual({ starter_prompts: [], output_template: null, library_ids: [] });
  });

  it("keeps the built-in tools collection exactly as before", () => {
    const config = agentConfiguration({ tools: ["retrieve", "query_data"] });
    expect(config.tools).toEqual(["retrieve", "query_data"]);
    expect(config.mcp_tools).toEqual([]);
    // Over-limit or unknown built-ins still fail exactly as before.
    expect(() => agentConfiguration({ tools: [...DEFAULT_AGENT_CONFIGURATION.tools, "extra"] as string[] })).toThrow();
    expect(() => agentConfiguration({ tools: ["retrieve", "query_mcp"] })).toThrow();
  });
});

describe("agent configuration codec — mcp_tools", () => {
  it("canonicalizes ordering, case, and the default-deny write flag", () => {
    const config = agentConfiguration({
      mcp_tools: [
        binding({ tool_id: TOOL_B.toUpperCase(), allow_write: true }),
        binding({ connection_id: CONNECTION.toUpperCase(), tool_id: TOOL_A }),
      ],
    });
    expect(config.mcp_tools).toHaveLength(2);
    expect(config.mcp_tools.map((entry) => entry.tool_id)).toEqual([TOOL_A, TOOL_B]);
    expect(config.mcp_tools[0]).toMatchObject({ allow_write: false });
    expect(config.mcp_tools[1]).toMatchObject({ allow_write: true });
  });

  it("enforces the structural budgets", () => {
    expect(() =>
      agentConfiguration({ mcp_tools: Array.from({ length: MAX_MCP_BINDINGS + 1 }, () => binding()) })
    ).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding(), binding()] })).toThrow(); // duplicate pair
    expect(() => agentConfiguration({ mcp_tools: [binding({ connection_id: "not-a-uuid" })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding({ tool_id: 42 })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding({ discovery_revision: 0 })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding({ discovery_revision: 1.5 })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding({ allow_write: "yes" })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: [binding({ rogue: true })] })).toThrow();
    expect(() => agentConfiguration({ mcp_tools: "nope" })).toThrow();
    // At the cap with distinct pairs is accepted.
    const many = Array.from({ length: MAX_MCP_BINDINGS }, () => binding({ tool_id: randomUUID() }));
    expect(agentConfiguration({ mcp_tools: many }).mcp_tools).toHaveLength(MAX_MCP_BINDINGS);
  });
});

describe("agent configuration codec — job_setup", () => {
  it("accepts the shipped shapes", () => {
    const config = agentConfiguration({
      job_setup: {
        starter_prompts: ["one", "two"],
        output_template: { kind: "instruction", instruction: "Three sections." },
        library_ids: [CONNECTION],
      },
    });
    expect(config.job_setup.starter_prompts).toEqual(["one", "two"]);
    expect(config.job_setup.output_template).toEqual({ kind: "instruction", instruction: "Three sections." });
    expect(config.job_setup.library_ids).toEqual([CONNECTION]);
  });

  it("enforces the budgets and the discriminated template seam", () => {
    expect(() => agentConfiguration({ job_setup: { starter_prompts: ["a", "b", "c", "d", "e", "f"] } })).toThrow();
    expect(() => agentConfiguration({ job_setup: { starter_prompts: ["x".repeat(2_001)] } })).toThrow();
    expect(() => agentConfiguration({ job_setup: { starter_prompts: [""] } })).toThrow();
    expect(() =>
      agentConfiguration({ job_setup: { library_ids: Array.from({ length: 11 }, () => randomUUID()) } })
    ).toThrow();
    expect(() => agentConfiguration({ job_setup: { library_ids: ["nope"] } })).toThrow();
    expect(() => agentConfiguration({ job_setup: { starter_prompts: ["a", "a"] } })).not.toThrow(); // dupes allowed (prompts are free text)
    // Invalid identifiers and extra keys fail closed for document references.
    expect(() =>
      agentConfiguration({ job_setup: { output_template: { kind: "template_id", template_id: "t" } } })
    ).toThrow();
    expect(
      agentConfiguration({ job_setup: { output_template: { kind: "template_id", template_id: CONNECTION } } }).job_setup
        .output_template
    ).toEqual({ kind: "template_id", template_id: CONNECTION });
    expect(() =>
      agentConfiguration({
        job_setup: {
          output_template: {
            kind: "template_id",
            template_id: CONNECTION,
            instruction: "hidden override",
          },
        },
      })
    ).toThrow();
    expect(() =>
      agentConfiguration({ job_setup: { output_template: { kind: "instruction", instruction: "" } } })
    ).toThrow();
    expect(() =>
      agentConfiguration({ job_setup: { output_template: { kind: "instruction", instruction: "x".repeat(8_001) } } })
    ).toThrow();
    expect(() => agentConfiguration({ job_setup: { rogue: 1 } })).toThrow();
    expect(() => agentConfiguration({ job_setup: null })).toThrow();
  });
});

describe("mcpToolAlias", () => {
  it("is deterministic, opaque, provider-safe, and collision-free per binding", () => {
    const first = mcpToolAlias(CONNECTION, TOOL_A);
    expect(first).toBe(mcpToolAlias(CONNECTION, TOOL_A));
    expect(first).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(new Set([first, mcpToolAlias(CONNECTION, TOOL_B), mcpToolAlias(randomUUID(), TOOL_A)]).size).toBe(3);
  });
});

describe("mcpToolLooksWriteOriented (fixture inventory)", () => {
  it("flags the write tool and passes the read-only fixture tools", () => {
    // Mirrors scripts/e2e/fixtures/lib/mcp-tools.mjs.
    expect(mcpToolLooksWriteOriented("record_note", "Record a note; deliberately flagged as a writing tool.")).toBe(
      true
    );
    expect(mcpToolLooksWriteOriented("echo_query", "Echo the provided text back as the tool result.")).toBe(false);
    expect(mcpToolLooksWriteOriented("finance_sum", "Add two numbers and return the sum.")).toBe(false);
    expect(mcpToolLooksWriteOriented("big_result", "Return a text result larger than 64 KiB.")).toBe(false);
    expect(mcpToolLooksWriteOriented("weird_schema", "Advertises an unsupported input-schema shape.")).toBe(false);
    expect(mcpToolLooksWriteOriented("slow_snooze", "Sleep past the 30-second tool deadline.")).toBe(false);
  });

  it("flags mutation verbs at the name boundaries and in descriptions", () => {
    expect(mcpToolLooksWriteOriented("create_report_draft", "")).toBe(true);
    expect(mcpToolLooksWriteOriented("calendar_delete", "")).toBe(true);
    expect(mcpToolLooksWriteOriented("lookup", "Deletes the matching rows.")).toBe(true);
    expect(mcpToolLooksWriteOriented("target", "Lists targets.")).toBe(false);
  });
});

describe("run MCP snapshot codec", () => {
  function frozen(alias: string, overrides: Partial<AgentMcpToolBinding> = {}): AgentMcpToolBinding {
    return Object.freeze({
      alias,
      connection_id: CONNECTION,
      tool_id: TOOL_A,
      discovery_revision: 2,
      name: "echo_query",
      description: 'echo_query (connected tool via "Local") Echo text.',
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      authorization_reference: "secret:0123456789abcdef0123456789abcdef",
      ...overrides,
    });
  }

  it("round-trips the frozen mapping", () => {
    const bindings = [frozen("mcp_aaaa"), frozen("mcp_bbbb", { tool_id: TOOL_B })];
    const encoded = encodeRunMcpSnapshot(bindings);
    expect(typeof encoded).toBe("string");
    expect(decodeRunMcpSnapshot(encoded)).toEqual(bindings);
    expect(encodeRunMcpSnapshot([])).toBeNull();
    expect(decodeRunMcpSnapshot(null)).toEqual([]);
    expect(decodeRunMcpSnapshot(encoded)).toEqual(decodeRunMcpSnapshot(encoded));
  });

  it("refuses over-budget snapshots and damaged payloads", () => {
    const big = frozen("mcp_dddd", { input_schema: { giant: "x".repeat(MAX_RUN_MCP_SNAPSHOT_CHARS) } });
    expect(() => encodeRunMcpSnapshot([big])).toThrow();
    expect(() => decodeRunMcpSnapshot("not json")).toThrow();
    expect(() => decodeRunMcpSnapshot(JSON.stringify([{ alias: "x" }]))).toThrow();
    expect(() => decodeRunMcpSnapshot(JSON.stringify([{ ...frozen("mcp_eeee"), name: "evil\nname" }]))).toThrow();
    expect(() =>
      decodeRunMcpSnapshot(JSON.stringify([{ ...frozen("mcp_ffff"), authorization_reference: "t".repeat(200) }]))
    ).toThrow();
  });
});
