import { v4 as uuid } from "uuid";
import fs from "node:fs/promises";
import { q } from "./db.js";
import { retrieve } from "./retrieve.js";
import { py } from "./pythonClient.js";
import { config } from "./config.js";

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
        "Search every connected document and data source (uploaded files) for passages relevant to a user question. Use before answering anything grounded in uploaded files, and re-use the returned passages in your answer.",
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
        "List every connected data source (uploaded tables and connector datasets) available for this account, including table names for SQL and their file names.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "query_data",
      description:
        "Run a DuckDB SQL query against the connected tabular data sources (see the catalog in your system prompt for exact table names and columns). Use aggregation, window functions and date filtering to answer quantitative questions precisely. SELECT/WITH only. Results limited to 500 rows.",
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
        "Return detailed statistics about a connected dataset's columns (ranges, averages, distinct values, top categories) to help plan analysis or charts.",
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
            description: "Chart ids previously returned by render_chart from THIS conversation",
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
        "Fetch the text content of a URL (web access). Useful when the user asks about current information or an external site. Returns readable text (plain HTML stripped).",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    },
  },
];

export async function executeTool(accountId: string, name: string, args: any, context: { chartIds: string[]; reportId?: string }): Promise<any> {
  switch (name) {
    case "retrieve": {
      const res = await retrieve(accountId, args.query || "", args.top_k || 6);
      return {
        passages: res.map((c) => ({ source: c.source_name, score: c.score, content: c.content })),
        instruction:
          "Answer using ONLY these passages as the factual basis. If they do not contain the answer, say so. Cite the source name after claims (e.g. [source]).",
      };
    }
    case "list_sources": {
      const ds = await py.listDatasets(accountId);
      const docs = await q(`SELECT id, display_name, kind, status FROM sources WHERE account_id=$1`, [accountId]);
      return { datasets: ds, documents: docs };
    }
    case "query_data":
      return await py.query(accountId, args.sql);
    case "describe_data":
      return await py.describe(accountId, args.table);
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
      const html = await py.buildReport(reportPayload);
      const pdfBuf = await py.pdf(reportPayload);
      const htmlName = `report_${reportPayload.title.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}_${Date.now()}.html`.replace(/^_+|_+$/g, "");
      const pdfName = htmlName.replace(/\.html$/, ".pdf");
      const htmlPath = config.reportDir + "/" + htmlName;
      const pdfPath = config.reportDir + "/" + pdfName;
      await fs.writeFile(htmlPath, html.html);
      await fs.writeFile(pdfPath, pdfBuf);
      const [rep] = await q(
        `INSERT INTO reports (id, account_id, title, subtitle, html_path, pdf_path, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id`,
        [uuid(), accountId, reportPayload.title, reportPayload.subtitle || "", htmlPath, pdfPath]
      );
      context.reportId = rep.id;
      return { report_id: rep.id, title: reportPayload.title, html: htmlName, pdf: pdfName };
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

async function makeReportPayload(accountId: string, args: any, context: { chartIds: string[]; reportId?: string }): Promise<any> {
  const title = args.title;
  const sections = (args.sections || []).map((s: any) => ({ heading: s.heading || "", markdown: s.markdown || "" }));
  const charts: any[] = [];
  const ids = args.charts || [];
  // resolve inline chart ids from this conversation (spec lookup)
  for (const cid of ids) {
    const [row] = await q(`SELECT spec FROM charts WHERE id=$1 AND account_id=$2`, [cid, accountId]);
    if (row) charts.push({ id: cid, spec: row.spec });
  }
  const tables = (args.tables || []).filter((t: any) => Array.isArray(t.columns) && Array.isArray(t.rows));
  return {
    title,
    subtitle: args.subtitle || "",
    sections,
    charts,
    tables,
  };
}
