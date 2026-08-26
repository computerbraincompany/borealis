import { Marked } from "marked";

import { ECHARTS_SOURCE, echartsOption, normalize, type CanonicalChartSpec } from "./charts.js";

/** Shared with the authenticated report HTML response route. */
export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHART_TOKEN_RE = /:::[A-Za-z0-9_-]+:[A-Za-z0-9_.-]+:::|!\[[^\]]*\]\(chart:[^)]*\)/g;
const ALLOWED_HREF_RE = /^(https?:|mailto:|#|$)/i;
const EXPLICIT_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_EMBEDDED_RESOURCE_URL_BYTES = 8 * 1024 * 1024;

const markdown = new Marked({ gfm: true, breaks: true, async: false });
// Keep bare URLs inside escaped raw markup as text rather than autolinking
// anchors. Keep GFM tables/fences while disabling Marked's bare URL/email rule.
markdown.use({
  renderer: {
    link(token) {
      const raw = token.raw.trim();
      const isBareAutoLink = raw === token.href || `mailto:${raw}` === token.href || `http://${raw}` === token.href;
      return isBareAutoLink ? escapeHtml(token.text) : false;
    },
  },
});

export type ReportCell = null | boolean | number | string;

export interface ReportSection {
  heading: string;
  markdown: string;
}

export interface ReportChart {
  id: string;
  spec: CanonicalChartSpec;
}

export interface ReportTable {
  columns: string[];
  rows: ReportCell[][];
}

export interface NormalizedReport {
  account_id?: string;
  title: string;
  subtitle: string;
  generated_at: string;
  sections: ReportSection[];
  charts: ReportChart[];
  tables: ReportTable[];
}

export interface BuildHtmlOptions {
  static?: boolean;
  chartImages?: ReadonlyMap<string, string>;
}

export class ReportValidationError extends Error {
  constructor() {
    super("invalid report request");
    this.name = "ReportValidationError";
  }
}

function invalid(): never {
  throw new ReportValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) invalid();
}

function boundedString(value: unknown, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value)) invalid();
  return value;
}

function utcTimestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function normalizeReport(reportValue: unknown, requireAccount = false): NormalizedReport {
  if (!isRecord(reportValue)) invalid();
  exactKeys(reportValue, ["account_id", "title", "subtitle", "generated_at", "sections", "charts", "tables"]);

  const accountValue = reportValue.account_id;
  let accountId: string | undefined;
  if (accountValue !== undefined) {
    if (typeof accountValue !== "string" || !ACCOUNT_RE.test(accountValue)) invalid();
    accountId = accountValue;
  } else if (requireAccount) {
    invalid();
  }

  const title = boundedString(reportValue.title, 200, true);
  const subtitleValue = reportValue.subtitle ?? "";
  const subtitle = boundedString(subtitleValue, 500);
  const generatedValue = reportValue.generated_at ?? utcTimestamp();
  const generatedAt = boundedString(generatedValue, 200);

  const sectionValues = reportValue.sections ?? [];
  if (!Array.isArray(sectionValues) || sectionValues.length > 20) invalid();
  const sections = sectionValues.map((section): ReportSection => {
    if (!isRecord(section)) invalid();
    exactKeys(section, ["heading", "markdown"]);
    return {
      heading: boundedString(section.heading ?? "", 200),
      markdown: boundedString(section.markdown, 50_000),
    };
  });

  const chartValues = reportValue.charts ?? [];
  if (!Array.isArray(chartValues) || chartValues.length > 20) invalid();
  const charts = chartValues.map((chart): ReportChart => {
    if (!isRecord(chart)) invalid();
    exactKeys(chart, ["id", "spec"]);
    return {
      id: boundedString(chart.id, 200, true),
      spec: normalize(chart.spec),
    };
  });

  const tableValues = reportValue.tables ?? [];
  if (!Array.isArray(tableValues) || tableValues.length > 8) invalid();
  const tables = tableValues.map((table): ReportTable => {
    if (!isRecord(table)) invalid();
    exactKeys(table, ["columns", "rows"]);
    if (!Array.isArray(table.columns) || table.columns.length > 32) invalid();
    const columns = table.columns.map((column) => boundedString(column, 200));
    if (!Array.isArray(table.rows) || table.rows.length > 60) invalid();
    const rows = table.rows.map((row): ReportCell[] => {
      if (!Array.isArray(row) || row.length > 32 || row.length !== columns.length) invalid();
      return row.map((cell) => {
        if (cell === null || typeof cell === "boolean") return cell;
        if (typeof cell === "string") return boundedString(cell, 500);
        if (typeof cell === "number" && Number.isFinite(cell) && String(cell).length <= 500) return cell;
        return invalid();
      });
    });
    return { columns, rows };
  });

  return {
    ...(accountId ? { account_id: accountId } : {}),
    title,
    subtitle,
    generated_at: generatedAt,
    sections,
    charts,
    tables,
  };
}

export function escapeHtml(value: unknown, quote = false): string {
  let escaped = String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (quote) escaped = escaped.replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
  return escaped;
}

function decodeSchemeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    colon: ":",
    gt: ">",
    lt: "<",
    newline: "\n",
    quot: '"',
    tab: "\t",
  };
  let decoded = value;
  const codePoint = (digits: string, radix: number) => {
    const value = Number.parseInt(digits, radix);
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : "\uFFFD";
  };
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);?/gi, (_match, digits: string) => codePoint(digits, 16))
      .replace(/&#([0-9]+);?/g, (_match, digits: string) => codePoint(digits, 10))
      .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function safeHref(value: string): string {
  const decoded = decodeSchemeEntities(value).trim();
  const normalized = [...decoded]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && codePoint !== 0x7f;
    })
    .join("");
  if (ALLOWED_HREF_RE.test(normalized) || !EXPLICIT_SCHEME_RE.test(normalized)) return decoded;
  return "#";
}

export function neutralizeLinks(rendered: string): string {
  return rendered.replace(/(<a\b[^>]*\bhref=")([^"]*)(")/gi, (_match, before, href: string, after) => {
    return `${before}${escapeHtml(safeHref(href), true)}${after}`;
  });
}

export function renderMarkdown(markdownValue: string): string {
  return markdown.parse(markdownValue, { async: false }) as string;
}

export function cleanMarkdown(markdownValue: string): string {
  return (markdownValue || "").replace(CHART_TOKEN_RE, "");
}

export function renderSectionMarkdown(markdownValue: string): string {
  const escapedMarkup = cleanMarkdown(markdownValue).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const rendered = renderMarkdown(escapedMarkup).replace(/<img\b[^>]*>/gi, "");
  return neutralizeLinks(rendered);
}

export function renderTables(tables: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const candidate of tables) {
    if (!isRecord(candidate) || !Array.isArray(candidate.columns) || !Array.isArray(candidate.rows)) continue;
    const columns = candidate.columns;
    const rows = candidate.rows;
    if (!columns.length || !rows.length || !Array.isArray(rows[0]) || columns.length !== rows[0].length) continue;
    const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
    const body = rows
      .slice(0, 60)
      .map((row) => {
        if (!Array.isArray(row)) return "";
        return `<tr>${row.map((value) => `<td>${value === null ? "" : escapeHtml(value)}</td>`).join("")}</tr>`;
      })
      .join("");
    blocks.push(
      `<div class="data-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>` +
        `<tfoot><tr><td colspan='${columns.length}'>${rows.length} rows</td></tr></tfoot></table></div>`
    );
  }
  return blocks.join("");
}

function chartBlocks(report: NormalizedReport, options: BuildHtmlOptions): string {
  return report.charts
    .map((chart) => {
      if (options.static) {
        const png = options.chartImages?.get(chart.id);
        if (
          !png ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(png) ||
          Buffer.byteLength(`data:image/png;base64,${png}`, "utf8") > MAX_EMBEDDED_RESOURCE_URL_BYTES
        ) {
          throw new ReportValidationError();
        }
        return (
          '<div class="chart-block" style="height:auto">' +
          `<img src="data:image/png;base64,${png}" style="width:100%" alt="${escapeHtml(chart.spec.title || "Chart", true)}"/>` +
          "</div>"
        );
      }
      const option = escapeHtml(JSON.stringify(echartsOption(chart.spec)), true);
      return `<div class="chart-block" id="chart-${escapeHtml(chart.id, true)}" data-option="${option}" style="height:400px"></div>`;
    })
    .join("");
}

export function buildHtml(reportValue: unknown, options: BuildHtmlOptions = {}): string {
  const report = normalizeReport(reportValue);
  const title = escapeHtml(report.title);
  const subtitle = escapeHtml(report.subtitle);
  const generatedAt = escapeHtml(report.generated_at, true);
  const sections = report.sections
    .map((section) => {
      const heading = escapeHtml(section.heading);
      const content = renderSectionMarkdown(section.markdown);
      return heading
        ? `<div class="section"><h2>${heading}</h2>${content}</div>`
        : `<div class="section">${content}</div>`;
    })
    .join("");
  const charts = chartBlocks(report, options);
  const tables = renderTables(report.tables);
  const echartsScript = options.static ? "" : `<script>${ECHARTS_SOURCE}</script>`;
  const initializer = options.static
    ? ""
    : `<script>
document.querySelectorAll('.chart-block').forEach(function(el){
  var opt = JSON.parse(el.getAttribute('data-option'));
  var chart = echarts.init(el);
  chart.setOption(opt);
  window.addEventListener('resize', function(){ chart.resize(); });
});
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg:#F8FAFC; --card:#FFFFFF; --ink:#0F172A; --muted:#64748B; --line:#E2E8F0;
  --brand:#6366F1; --brand-soft:#EEF2FF; --teal:#14B8A6; --radius:14px;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased; }
.page { max-width:960px; margin:0 auto; padding:40px 24px 80px; }
.masthead { background:linear-gradient(135deg,#312E81 0%,#6366F1 55%,#14B8A6 140%);
  border-radius:calc(var(--radius) + 6px); padding:36px 40px; color:#fff; margin-bottom:28px;
  box-shadow:0 18px 40px -18px rgba(49,46,129,.55); }
.masthead h1 { margin:0; font-size:30px; letter-spacing:-.02em; }
.masthead .sub { margin-top:8px; opacity:.85; font-size:15px; }
.meta { margin-top:18px; display:flex; gap:12px; flex-wrap:wrap; }
.pill { background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.28);
  padding:4px 12px; border-radius:999px; font-size:12px; font-weight:600; }
.section { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  padding:28px 32px; margin-bottom:20px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
.section h2 { margin:0 0 14px; font-size:20px; letter-spacing:-.01em; color:var(--ink);
  border-bottom:2px solid var(--brand-soft); padding-bottom:10px; }
.section p { line-height:1.7; color:#334155; margin:10px 0; font-size:15px; }
.section ul, .section ol { color:#334155; line-height:1.7; font-size:15px; }
.section h3 { margin:18px 0 6px; font-size:16px; color:#1E293B; }
.section strong { color:#0F172A; }
.chart-block { margin:18px 0; border:1px solid var(--line); border-radius:12px; overflow:hidden;
  background:#fff; }
.data-table { overflow-x:auto; margin:14px 0; }
.data-table table { border-collapse:collapse; width:100%; font-size:13.5px; }
.data-table th { background:var(--brand-soft); color:#312E81; text-align:left; padding:8px 10px;
  font-weight:600; border:1px solid var(--line); }
.data-table td { padding:7px 10px; border:1px solid var(--line); color:#334155; }
.data-table tfoot td { font-size:11px; color:var(--muted); background:#F8FAFC; }
pre, code { background:#F1F5F9; border-radius:6px; }
pre { padding:12px; overflow-x:auto; }
code { padding:2px 5px; }
blockquote { margin:10px 0; padding:2px 16px; border-left:3px solid var(--brand); color:#475569; }
</style>
${echartsScript}
</head>
<body>
<div class="page">
  <div class="masthead">
    <h1>${title}</h1>
    ${subtitle ? `<div class="sub">${subtitle}</div>` : ""}
    <div class="meta">
      <span class="pill">Generated by Borealis</span>
      <span class="pill">${generatedAt}</span>
      ${report.charts.length ? `<span class="pill">${report.charts.length} charts</span>` : ""}
      ${report.tables.length ? `<span class="pill">${report.tables.length} tables</span>` : ""}
    </div>
  </div>
  ${sections}
  ${charts}
  ${tables}
</div>
${initializer}
</body>
</html>`;
}
