import { v4 as uuid } from "uuid";
import fs from "node:fs/promises";
import { q } from "./db.js";
import { retrieve } from "./retrieve.js";
import { py } from "./pythonClient.js";
import { config } from "./config.js";
import type { ResolvedSourceScope } from "./sourceScope.js";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

const chartTypes = `"line" | "bar" | "area" | "pie" | "donut" | "scatter"`;
const chartSpecExample = {
  type: "bar",
  title: "Monthly spending",
  subtitle: "CAD by category",
  categories: ["Jan", "Feb"],
  series: [{ name: "Groceries", data: [320, 410] }],
  x_label: "Month",
  y_label: "Amount (CAD)",
};
export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "retrieve",
      description:
        "Search the stored documents and data sources selected for this chat for passages relevant to a user question. Use before answering anything grounded in selected files, and re-use the returned passages in your answer.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query describing the information needed" },
          top_k: { type: "integer", description: "Number of passages to return (default 6)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sources",
      description:
        "List only the stored data sources selected for this chat, including attachment status and ready table names for SQL.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "query_data",
      description:
        "Run a DuckDB SQL query against the ready tabular data sources selected for this chat (see the catalog in your system prompt for exact table names and columns). Use aggregation, window functions and date filtering to answer quantitative questions precisely. SELECT/WITH only. Results limited to 500 rows.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "The SQL statement, referencing catalog tables only" } },
        required: ["sql"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_data",
      description:
        "Return detailed statistics about a ready dataset selected for this chat (ranges, averages, distinct values, top categories) to help plan analysis or charts.",
      parameters: {
        type: "object",
        properties: { table: { type: "string", description: "Name of the dataset table from the catalog" } },
        required: ["table"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_chart",
      description:
        "Create a chart from analyzed data. Provide a complete chart spec in the canonical format. The chart will be shown to the user in chat and can be embedded in a report. Use honest, exact numbers from query_data results.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description: "Canonical chart spec (see schema below). Charts render identically everywhere.",
            properties: {
              type: { type: "string", enum: ["line", "bar", "area", "pie", "donut", "scatter"], description: "Chart family" },
              title: { type: "string", description: "Concise chart title" },
              subtitle: { type: "string" },
              categories: { type: "array", items: { type: "string" }, description: "X-axis labels (line/bar/area/scatter)" },
              series: {
                type: "array",
                description: "Numeric series (line/bar/area/scatter)",
                items: { type: "object", properties: { name: { type: "string" }, data: { type: "array", items: { type: "number" } } }, required: ["name", "data"] },
              },
              items: { type: "array", description: "Slices for pie/donut", items: { type: "object", properties: { name: { type: "string" }, value: { type: "number" } }, required: ["name", "value"] } },
              x_label: { type: "string" },
              y_label: { type: "string" },
            },
            required: ["type", "title"],
          },
        },
        required: ["spec"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_report",
      description:
        "Assemble a beautiful standalone report (HTML + PDF). Provide a title and sections written in markdown; you may embed charts you already rendered (refer by id) and data tables from query_data. The backend renders the final HTML and PDF.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Report title" },
          subtitle: { type: "string" },
          sections: {
            type: "array",
            description: "Report body written in markdown, ordered",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                markdown: { type: "string", description: "Markdown content including KPIs, analysis and takeaways" },
              },
              required: ["markdown"],
            },
          },
          charts: {
            type: "array",
            description:
              "Exact chart id UUIDs returned by render_chart in THIS run — copy them precisely (e.g. a1111111-2222-3333-4444-555555555555). Do not invent or alter them.",
            items: { type: "string" },
          },
          tables: {
            type: "array",
            description: "Optional data tables (columns + rows) to include verbatim",
            items: {
              type: "object",
              properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array" } } },
            },
          },
        },
        required: ["title", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the text content of a URL using the separate web capability. This is independent of the chat's stored-source selection. Useful when the user asks about current information or an external site. Returns readable text (plain HTML stripped).",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    },
  },
];

export interface ToolRunContext {
  chartIds: string[];
  evidence: RetrievedEvidence[];
  reportId?: string;
  chatId: string;
  model: string;
  sourceScope: ResolvedSourceScope;
  readySourceIds: readonly string[];
  readyTableNames: readonly string[];
}

export interface RetrievedEvidence {
  source_id: string;
  chunk_id: string;
  source: string;
  excerpt: string;
  score: number;
}

const MAX_EVIDENCE_PASSAGES = 8;
const MAX_EVIDENCE_SOURCE_LENGTH = 200;
const MAX_EVIDENCE_EXCERPT_LENGTH = 800;

/** Keep only the stable, bounded retrieval evidence safe to persist in message metadata. */
export function sanitizeRetrievedEvidence(passages: readonly unknown[]): RetrievedEvidence[] {
  const evidence: RetrievedEvidence[] = [];
  const seen = new Set<string>();

  for (const candidate of passages) {
    if (evidence.length >= MAX_EVIDENCE_PASSAGES) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const passage = candidate as Partial<RetrievedEvidence> & { content?: unknown };
    const content = typeof passage.content === "string" ? passage.content : passage.excerpt;
    if (
      typeof passage.source_id !== "string"
      || typeof passage.chunk_id !== "string"
      || typeof passage.source !== "string"
      || typeof content !== "string"
      || typeof passage.score !== "number"
      || !Number.isFinite(passage.score)
    ) {
      continue;
    }

    const sourceId = passage.source_id.trim();
    const chunkId = passage.chunk_id.trim();
    const excerpt = content.trim().slice(0, MAX_EVIDENCE_EXCERPT_LENGTH);
    if (!sourceId || !chunkId || !excerpt) continue;

    const key = `${sourceId}\u0000${chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      source_id: sourceId,
      chunk_id: chunkId,
      source: passage.source.trim().slice(0, MAX_EVIDENCE_SOURCE_LENGTH) || "Source",
      excerpt,
      score: passage.score,
    });
  }

  return evidence;
}

export async function executeTool(accountId: string, name: string, args: any, context: ToolRunContext): Promise<any> {
  switch (name) {
    case "retrieve": {
      const res = await retrieve(accountId, args.query || "", context.readySourceIds, args.top_k || 6);
      context.evidence = sanitizeRetrievedEvidence([...context.evidence, ...res]);
      return {
        passages: res.map((c) => ({ source: c.source, score: c.score, content: c.content })),
        instruction:
          "Answer using ONLY these passages as the factual basis. If they do not contain the answer, say so. Cite the source name after claims (e.g. [source]).",
      };
    }
    case "list_sources": {
      const allowedTables = new Set(context.readyTableNames);
      const ds = allowedTables.size ? await py.listDatasets(accountId) : [];
      const datasets = ds
        .filter((dataset: any) => allowedTables.has(String(dataset.table)))
        .map(sanitizeDatasetSummary);
      const sources = context.sourceScope.attached.map((source) => ({ ...source }));
      return { source_mode: context.sourceScope.mode, sources, datasets };
    }
    case "query_data":
      return await py.query(accountId, args.sql, context.readyTableNames);
    case "describe_data": {
      const table = typeof args.table === "string" ? args.table : "";
      if (!context.readyTableNames.includes(table)) {
        return { error: "that table is not selected and ready for this chat" };
      }
      return await py.describe(accountId, table, context.readyTableNames);
    }
    case "render_chart": {
      const spec = args.spec || {};
      const res = await py.chart(accountId, spec);
      const chartId = uuid();
      await q(`INSERT INTO charts (id, account_id, spec, echarts) VALUES ($1,$2,$3,$4)`, [
        chartId,
        accountId,
        JSON.stringify(res.spec),
        JSON.stringify(res.echarts),
      ]);
      context.chartIds.push(chartId);
      return { chart_id: chartId, title: res.spec.title, rendered: true, note: "confirm in your answer that a chart was created for the user." };
    }
    case "create_report": {
      const reportPayload = await makeReportPayload(accountId, args, context);
      if (!reportPayload.title || !reportPayload.sections.length)
        return {
          error:
            "create_report requires a title and at least one section with markdown content. Call it again with a proper title, complete markdown sections, and the chart ids from render_chart.",
        };
      const html = await py.buildReport(reportPayload);
      const pdfBuf = await py.pdf(reportPayload);
      const htmlName = `report_${reportPayload.title.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}_${Date.now()}.html`.replace(/^_+|_+$/g, "");
      const pdfName = htmlName.replace(/\.html$/, ".pdf");
      const htmlPath = config.reportDir + "/" + htmlName;
      const pdfPath = config.reportDir + "/" + pdfName;
      await fs.writeFile(htmlPath, html.html);
      await fs.writeFile(pdfPath, pdfBuf);
      const [rep] = await q(
        `INSERT INTO reports (id, account_id, chat_id, title, subtitle, html_path, pdf_path, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now()) RETURNING id`,
        [uuid(), accountId, context.chatId || null, reportPayload.title, reportPayload.subtitle || "", htmlPath, pdfPath]
      );
      context.reportId = rep.id;
      return {
        report_id: rep.id,
        title: reportPayload.title,
        html: htmlName,
        pdf: pdfName,
        ...(reportPayload.unresolved_chart_ids?.length
          ? { unresolved_chart_ids: reportPayload.unresolved_chart_ids }
          : {}),
      };
    }
    case "fetch_url": {
      const res = await fetch(args.url);
      const text = await res.text();
      // crude strip of tags/markup
      const readable = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { url: args.url, status: res.status, text: readable.slice(0, 12000) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

type ReportRunContext = Pick<ToolRunContext, "chartIds"> & Partial<Pick<ToolRunContext, "reportId" | "chatId">>;

export async function makeReportPayload(accountId: string, args: any, context: ReportRunContext): Promise<any> {
  const title = args.title;
  const sections = (args.sections || []).map((s: any) => ({ heading: s.heading || "", markdown: s.markdown || "" }));
  const charts: any[] = [];
  const requested: string[] = (args.charts || []).map((s: any) => String(s));
  const unresolved: string[] = [];
  // Resolve only chart ids created in this agent run. Historical account
  // charts are not an authorization source for a new report.
  for (const raw of requested) {
    try {
      const chartId = matchCurrentRunChartId(raw, context.chartIds);
      if (!chartId) {
        unresolved.push(raw);
        continue;
      }
      const [row] = await q(`SELECT spec FROM charts WHERE id::text=$1 AND account_id=$2`, [chartId, accountId]);
      if (!row) unresolved.push(raw);
      else charts.push({ id: chartId, spec: row.spec });
    } catch {
      unresolved.push(raw);
    }
  }
  const tables = (args.tables || []).filter((t: any) => Array.isArray(t.columns) && Array.isArray(t.rows));
  return {
    account_id: accountId,
    title,
    subtitle: args.subtitle || "",
    sections,
    charts,
    tables,
    ...(unresolved.length ? { unresolved_chart_ids: unresolved } : {}),
  };
}

function matchCurrentRunChartId(raw: string, chartIds: readonly string[]): string | undefined {
  const exact = chartIds.find((id) => id.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const prefix = raw.replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (prefix.length < 12) return undefined;
  const matches = chartIds.filter((id) => id.replace(/-/g, "").toLowerCase().startsWith(prefix.slice(0, 12)));
  return matches.length === 1 ? matches[0] : undefined;
}

function sanitizeDatasetSummary(dataset: any) {
  return {
    table: String(dataset.table || ""),
    original_name: String(dataset.original_name || ""),
    rows: Number(dataset.rows || 0),
    columns: Array.isArray(dataset.columns)
      ? dataset.columns.map((column: any) => ({ name: String(column.name || ""), type: String(column.type || "") }))
      : [],
    exists: Boolean(dataset.exists),
  };
}
