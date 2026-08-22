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
  const rm = /^\s*(Thinking Process|Thinking|Thought|Reasoning)[:\-]?\s*$/im;
  if (rm.test(t.split("\n")[0])) {
    const nl = t.search(/\n\s*\n/);
    t = nl >= 0 ? t.slice(nl) : "";
  }
  const fa = t.match(/^\s*(Final Answer|Answer)[:\-]\s*/im);
  if (fa && fa.index === 0) t = t.slice(fa[0].length);
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
    const res = await chatOnce([system, ...messages], { maxTokens: 1400 });
    const msg = res.choices[0].message;
    const toolCalls = (msg.tool_calls as any[]) || [];
    if (!toolCalls.length) {
      // final answer — stream to the user
      const streamed = await streamingChat([system, ...messages], { maxTokens: 2400 }, (t) => emit({ type: "delta", text: t }));
      const final = cleanFinal(streamed.choices[0].message.content || "");
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
        result = await executeTool(accountId, name, parsedArgs, context);
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
  }
  // exhausted guard
  const msg2 = (await chatOnce([system, ...messages], { maxTokens: 1400 })).choices[0].message;
  const final = msg2.content || "I ran into too many steps — try again with a more specific request.";
  const meta = { charts: context.chartIds, report: context.reportId || null };
  await q(`INSERT INTO messages (chat_id, role, content, meta) VALUES ($1,'assistant',$2,$3)`, [chatId, final, JSON.stringify(meta)]);
  emit({ type: "delta", text: final });
  emit({ type: "message", roles: [], content: final, meta });
  emit({ type: "done" });
}
