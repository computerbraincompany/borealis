import type OpenAI from "openai";
import { chatOnce, ChatMessage, streamingChat } from "./llm.js";
import { TOOL_DEFS, executeTool } from "./tools.js";
import { q } from "./db.js";
import { py } from "./pythonClient.js";

export type AgentEvent =
  | { type: "step-start"; name: string; args: any }
  | { type: "step-end"; name: string; result: any }
  | { type: "delta"; text: string }
  | { type: "message"; roles: string[]; content: string; meta: any }
  | { type: "done" }
  | { type: "error"; message: string };

const MAX_ITERATIONS = 8;

/** Qwen-style models sometimes prefix answers with a "Thinking:" block. */
function cleanFinal(text: string): string {
  let t = text.trim();
  // Strip a leading "Thinking Process/Thought/Reasoning: ..." block up to the
  // first blank line (the first line may carry intro text after the colon).
  const first = t.split("\n")[0] || "";
  if (/^\s*(Thinking Process|Thinking|Thought Process|Thought|Reasoning)[:\-]?\s*/i.test(first)) {
    const nl = t.search(/\n\s*\n/);
    t = nl >= 0 ? t.slice(nl) : "";
  }
  // Repeatedly strip leading "Final Answer:" / "Answer:" labels (loop-safe).
  let prev: string;
  do {
    prev = t;
    const fa = t.match(/^\s*(Final Answer|Answer)[:\-]\s*/i);
    if (fa) t = t.slice(fa[0].length);
  } while (t !== prev);
  return t.trim();
}

async function buildSystemPrompt(accountId: string): Promise<string> {
  let catalog = "No tabular data sources connected yet.\n";
  try {
    const ds = await py.listDatasets(accountId);
    if (ds.length) {
      catalog = ds
        .map((d: any) => {
          const cols = (d.columns || [])
            .map((c: any) => `${c.name}:${c.type}`)
            .join(", ");
          return `- table "${d.table}" (display "${d.original_name}", ${d.rows} rows)\n    columns: ${cols}`;
        })
        .join("\n");
    }
  } catch (e) {
    catalog = "(catalog unavailable: " + String(e) + ")";
  }
  return `You are North, a grounded agentic assistant for an organization. You help people get answers and polished deliverables from their connected data.

## Behavior
- Think step by step, but never show raw chain-of-thought. Explain what you are doing in a short lead-in before tool calls.
- Solve quantitative questions with SQL via query_data. Use describe_data to understand schemas, then query. Prefer one well-designed SQL query over many small ones.
- Produce charts (render_chart) whenever data tells a visual story: trends, breakdowns, comparisons.
- Produce a professional report (create_report) whenever the user asks for a report, summary document, PDF or analysis — or when you have enough analysis for one.
- Answer from data; if data is missing be explicit about it. Cite document passages as [source] when using retrieve.
- Use markdown for the chat answer. Keep it structured: key numbers first, then interpretation.

## Tool usage rules (hard requirements)
- NEVER describe in prose a tool you are about to call. If you intend to use a tool — including at the very end of the turn — you MUST emit its function call instead of announcing it in text. Announces-without-calling are not allowed.
- When the user asks for a report, PDF, deliverable or "final document", you MUST call create_report with the title, sections (markdown, including the key numbers), the chart ids from render_chart in THIS conversation, and any data tables. Then briefly summarize the created report in your answer.

## Connected data sources (exact DuckDB catalog — quote table/column names exactly, SQL identifiers are case-insensitive via read of schema here)
${catalog}

## Data tips
- Dates: prefer strftime or date_trunc. DuckDB supports standard SQL.
- When generating charts use real numbers only — never fabricate.
- Report sections: write markdown with a clear structure (Executive summary, key metrics, analysis, recommendations). Keep prose tight and professional.`;
}

export async function runAgent(opts: {
  accountId: string;
  chatId: string;
  content: string;
  emit: (event: AgentEvent) => Promise<void> | void;
}): Promise<void> {
  const { accountId, chatId, content, emit } = opts;
  // load conversation
  const prior = await q(
    `SELECT role, content, meta FROM messages WHERE chat_id=$1 ORDER BY id`,
    [chatId]
  );
  const messages: ChatMessage[] = [];
  for (const m of prior) {
    if (!m.content) continue;
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: m.content });
  }
  if (messages.length === 0) {
    await q(`UPDATE chats SET title=$2 WHERE id=$1`, [chatId, content.slice(0, 80)]);
  }
  messages.push({ role: "user", content });

  const system: ChatMessage = { role: "system", content: await buildSystemPrompt(accountId) };
  const context: { chartIds: string[]; reportId?: string } = { chartIds: [] };

  let guard = 0;
  while (guard++ < MAX_ITERATIONS) {
    const res = await chatOnce([system, ...messages], { maxTokens: 2400, tools: TOOL_DEFS });
    const msg = res.choices[0].message;
    let toolCalls = (msg.tool_calls as any[]) || [];
    if (!toolCalls.length) {
      // final answer — stream to the user; a tool call may still arrive in the stream
      const streamed = await streamingChat([system, ...messages], { maxTokens: 2400, tools: TOOL_DEFS }, (t) => emit({ type: "delta", text: t }));
      const smsg = streamed.choices[0].message;
      toolCalls = (smsg.tool_calls as any[]) || [];
      if (toolCalls.length) {
        // the "final answer" was actually a tool round — run it like one
        const roundMsg = { ...smsg, content: smsg.content || "" };
        messages.push(roundMsg as any);
        for (const tc of toolCalls) {
          await runToolRound(accountId, chatId, tc, messages, context, emit);
        }
        continue;
      }
      const final = cleanFinal(smsg.content || "");
      const meta = {
        charts: context.chartIds,
        report: context.reportId || null,
      };
      await q(`INSERT INTO messages (chat_id, role, content, meta) VALUES ($1,'assistant',$2,$3)`, [
        chatId,
        final,
        JSON.stringify(meta),
      ]);
      emit({ type: "message", roles: [], content: final, meta });
      emit({ type: "done" });
      return;
    }

    // tool round
    messages.push(msg as any);
    for (const tc of toolCalls) {
      await runToolRound(accountId, chatId, tc, messages, context, emit);
    }
  }
  // exhausted guard
  const msg2 = (
    await chatOnce([system, ...messages], { maxTokens: 2400, tools: TOOL_DEFS })
  ).choices[0].message;
  const final = msg2.content || "I ran into too many steps — try again with a more specific request.";
  const meta = { charts: context.chartIds, report: context.reportId || null };
  await q(`INSERT INTO messages (chat_id, role, content, meta) VALUES ($1,'assistant',$2,$3)`, [chatId, final, JSON.stringify(meta)]);
  emit({ type: "delta", text: final });
  emit({ type: "message", roles: [], content: final, meta });
  emit({ type: "done" });
}

async function runToolRound(
  accountId: string,
  chatId: string,
  tc: any,
  messages: ChatMessage[],
  context: { chartIds: string[]; reportId?: string },
  emit: (event: AgentEvent) => void,
  maxMs = 120000
): Promise<void> {
  const name = tc.function.name;
  let parsedArgs: any = {};
  try {
    parsedArgs = JSON.parse(tc.function.arguments || "{}");
  } catch {
    parsedArgs = {};
  }
  emit({ type: "step-start", name, args: parsedArgs });
  let result: any;
  try {
    result = await Promise.race([
      executeTool(accountId, name, parsedArgs, context),
      new Promise((_, rej) => setTimeout(() => rej(new Error("tool timed out")), maxMs)),
    ]);
  } catch (e: any) {
    result = { error: String(e?.message || e) };
  }
  emit({ type: "step-end", name, result });
  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content: JSON.stringify(result).slice(0, 12000),
  } as any);
}
