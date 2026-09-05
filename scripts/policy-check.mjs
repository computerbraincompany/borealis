import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverDirectory = path.join(repositoryDirectory, "server");
const serverBin = path.join(serverDirectory, "node_modules", ".bin");
const policyCheckPath = fileURLToPath(import.meta.url);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${serverBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(
      `${command} ${args.join(" ")} failed${result.status == null ? "" : ` (exit ${result.status})`}.`,
    );
    process.exit(result.status ?? 1);
  }
  return result;
}

function fileContainsQuotedXlsx(filePath) {
  return /"xlsx"/.test(readFileSync(filePath, "utf8"));
}

function listedGitFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryDirectory, encoding: "buffer" },
  );
  if (result.status !== 0) {
    fail("git ls-files failed.");
    process.exit(result.status ?? 1);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(repositoryDirectory, relative));
}

function posixRelative(filePath) {
  return path.relative(repositoryDirectory, filePath).split(path.sep).join("/");
}

function searchFiles(files, pattern, flags = "") {
  const regex = new RegExp(pattern, flags);
  const matches = [];
  for (const filePath of files) {
    let contents;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) {
        matches.push(
          `${posixRelative(filePath)}:${index + 1}:${lines[index]}`,
        );
      }
      regex.lastIndex = 0;
    }
  }
  return matches;
}

const serverPackageJson = path.join(serverDirectory, "package.json");
const lockfile = path.join(repositoryDirectory, "pnpm-lock.yaml");
if (
  fileContainsQuotedXlsx(serverPackageJson) ||
  fileContainsQuotedXlsx(lockfile)
) {
  fail("SheetJS is forbidden; use the bounded ExcelJS reader.");
  process.exit(1);
}

run(
  "tsc",
  [
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--types",
    "node",
    "../data/generate_sample.ts",
  ],
  { cwd: serverDirectory },
);
run("prettier", ["--check", "../data/generate_sample.ts"], {
  cwd: serverDirectory,
});

const sampleCheckDirectory = mkdtempSync(
  path.join(os.tmpdir(), "borealis-sample-check."),
);
try {
  const isolatedDataDirectory = path.join(sampleCheckDirectory, "data");
  mkdirSync(isolatedDataDirectory, { recursive: true });
  const generateSample = path.join(
    repositoryDirectory,
    "data",
    "generate_sample.ts",
  );
  cpSync(generateSample, path.join(isolatedDataDirectory, "generate_sample.ts"));
  run("tsx", [path.join(isolatedDataDirectory, "generate_sample.ts")], {
    cwd: serverDirectory,
    stdio: "ignore",
  });
  for (const fixture of [
    "accounts.csv",
    "budget.csv",
    "networth.csv",
    "transactions.csv",
  ]) {
    const generated = path.join(isolatedDataDirectory, "sample", fixture);
    const tracked = path.join(repositoryDirectory, "data", "sample", fixture);
    run("cmp", [generated, tracked]);
  }
} finally {
  rmSync(sampleCheckDirectory, { recursive: true, force: true });
}

const gitFiles = listedGitFiles();
const localOcrHelper = path.join(
  serverDirectory,
  "src",
  "data",
  "assets",
  "pdf-ocr.jxa",
);
const localOcrSource = readFileSync(localOcrHelper, "utf8");
if (
  !localOcrSource.includes('ObjC.import("Vision")') ||
  /https?:|fetch\(|curl|XMLHttpRequest/.test(localOcrSource)
) {
  fail("The fixed local OCR helper must use macOS Vision without network access.");
  process.exit(1);
}
const remnantFiles = gitFiles.filter((filePath) => {
  const relative = posixRelative(filePath);
  return (
    filePath !== policyCheckPath &&
    path.basename(filePath) !== "pnpm-lock.yaml" &&
    !relative.startsWith("plans/") &&
    relative !== "plans" &&
    !relative.startsWith("docs/cohere-north/")
  );
});
const remnantMatches = searchFiles(
  remnantFiles,
  "uvicor[n]|weasyprin[t]|openpyx[l]|lite[l]lm|PYTHON_SERVIC[E]_|BOREALIS_SERVICE_TOKE[N]|from openpyx[l]|uv ru[n]|LiteL[L]M gateway|Python data servic[e]",
);
if (remnantMatches.length > 0) {
  process.stderr.write(`${remnantMatches.join("\n")}\n`);
  fail("Removed runtime or service references remain outside historical plans.");
  process.exit(1);
}

const databaseFiles = gitFiles.filter((filePath) => {
  const relative = posixRelative(filePath);
  return (
    filePath !== policyCheckPath &&
    path.basename(filePath) !== "pnpm-lock.yaml" &&
    !relative.includes("/data/assets/") &&
    (relative.startsWith("server/") ||
      relative.startsWith("web/") ||
      relative.startsWith("scripts/") ||
      relative.startsWith(".github/"))
  );
});
const databaseMatches = searchFiles(
  databaseFiles,
  "postgre(s|sql)|\\bpg\\b|DATABASE_URL|TEST_DATABASE_URL|pgvector|SKIP LOCKED|FOR UPDATE|::(uuid|jsonb|vector|timestamptz)|jsonb_",
  "i",
);
if (databaseMatches.length > 0) {
  process.stderr.write(`${databaseMatches.join("\n")}\n`);
  fail(
    "Removed database runtime or test references remain in the embedded-storage path.",
  );
  process.exit(1);
}

const documentationFiles = gitFiles.filter((filePath) => {
  const relative = posixRelative(filePath);
  return (
    relative === "README.md" ||
    relative === "AGENTS.md" ||
    relative === "server/.env.example" ||
    relative === "desktop/README.md" ||
    relative.startsWith("milestones/") ||
    (relative.startsWith("docs/") && !relative.startsWith("docs/cohere-north/"))
  );
});
const documentationMatches = searchFiles(
  documentationFiles,
  "postgre(s|sql)|pgvector|docker[- ]compose|TEST_DATABASE_URL|LiteLLM (proxy|gateway|service|runtime)|Python (data|report) service",
  "i",
);
if (documentationMatches.length > 0) {
  process.stderr.write(`${documentationMatches.join("\n")}\n`);
  fail(
    "Stale external-service documentation remains outside historical plans.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shell egress gate. The production UI shell must never name a remote
// resource in a declarative browser-fetching position: opening the shell may
// not perform DNS/TLS requests to third-party origins. The runtime
// Content-Security-Policy in server/src/serverApp.ts is the production
// backstop; this development-time gate inspects the tracked shell HTML, every
// tracked web CSS source, and every non-test production web/src TS/TSX file
// before Vite can serve them without that header. Ordinary anchor navigation
// is a user-initiated navigation, not a shell subresource, and stays allowed.
// Diagnostics name only the file and rule, never the matched URL.
// ---------------------------------------------------------------------------

// TypeScript is resolved through the web workspace manifest, never the root
// (which declares none) and never by traversing the pnpm store.
const workspaceRequire = createRequire(
  new URL("../web/package.json", import.meta.url),
);
let ts;
try {
  ts = workspaceRequire("typescript");
} catch {
  fail("The shell egress gate requires the web workspace TypeScript.");
  process.exit(1);
}
for (const required of [
  "createSourceFile",
  "forEachChild",
  "isJsxAttribute",
  "isJsxElement",
  "isJsxExpression",
  "isJsxNamespacedName",
  "isJsxOpeningElement",
  "isJsxSelfClosingElement",
  "isObjectLiteralExpression",
  "isPropertyAssignment",
  "isStringLiteral",
]) {
  if (typeof ts?.[required] !== "function") {
    fail(`The web workspace TypeScript is missing the ${required} API.`);
    process.exit(1);
  }
}
for (const enumName of ["ScriptKind", "ScriptTarget", "SyntaxKind"]) {
  if (typeof ts?.[enumName] !== "object") {
    fail(`The web workspace TypeScript is missing the ${enumName} enum.`);
    process.exit(1);
  }
}
if (
  ts.ScriptKind.TSX == null ||
  ts.SyntaxKind.StringLiteral == null ||
  ts.SyntaxKind.NoSubstitutionTemplateLiteral == null ||
  ts.SyntaxKind.TemplateExpression == null
) {
  fail("The web workspace TypeScript compiler API is incomplete.");
  process.exit(1);
}

// WHATWG resolution against this fixed synthetic local origin gives
// browser-equivalent special-scheme normalization (protocol-relative URLs,
// backslashes in special schemes, etc.) without a literal `://` scan.
const SHELL_BASE_ORIGIN = "http://shell.invalid:8/";
const SHELL_BASE = new URL(SHELL_BASE_ORIGIN);
// Conservative: any syntactically plausible HTML character reference (named,
// numeric, with or without the terminating semicolon) is rejected in a
// browser-fetching HTML/JSX value instead of decoding with an incomplete table.
const HTML_CHARACTER_REFERENCE = /&#|&[a-zA-Z][a-zA-Z0-9]*/;
const SRCDOC_MAX_NESTING = 2;
const SRCDOC_MAX_BYTES = 32_768;

class ShellEgressViolation extends Error {
  constructor(rule) {
    super(rule);
    this.rule = rule;
  }
}

function violate(rule) {
  throw new ShellEgressViolation(rule);
}

function classifyResourceUrl(
  value,
  rule,
  { allowData = false, allowAbout = false, rejectReferences = true } = {},
) {
  if (typeof value !== "string") return;
  if (rejectReferences && HTML_CHARACTER_REFERENCE.test(value)) {
    violate(`${rule}-character-reference`);
  }
  const trimmed = value.replace(/^[\0-\x20]+|[\0-\x20]+$/g, "");
  if (trimmed === "") return;
  let parsed;
  try {
    parsed = new URL(trimmed, SHELL_BASE_ORIGIN);
  } catch {
    violate(`${rule}-unparseable-url`);
  }
  if (parsed.protocol === "http:" && parsed.origin === SHELL_BASE.origin) {
    return;
  }
  if (parsed.protocol === "data:") {
    if (allowData) return;
    violate(`${rule}-data-url`);
  }
  if (parsed.protocol === "about:") {
    if (allowAbout) return;
    violate(`${rule}-about-url`);
  }
  violate(`${rule}-remote-url`);
}

// HTML spec srcset splitting: the URL candidate runs to the first whitespace
// (so commas inside data: URLs survive) and descriptors run to the next
// top-level comma. Every candidate is classified, not only the first.
function parseSrcset(value) {
  const candidates = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position])) {
      position += 1;
    }
    if (position >= value.length) break;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) {
      position += 1;
    }
    const url = value.slice(start, position);
    while (position < value.length) {
      const character = value[position];
      if (character === ",") {
        position += 1;
        break;
      }
      if (character === '"' || character === "'") {
        position += 1;
        while (position < value.length && value[position] !== character) {
          position += 1;
        }
        position += 1;
        continue;
      }
      position += 1;
    }
    if (url) candidates.push(url);
  }
  return candidates;
}

function stripCssComments(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      out += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      out += character;
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        if (inner === "\\") {
          out += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === character || inner === "\n") break;
      }
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

// Complete CSS escape grammar: one-to-six hex digits with one optional
// terminator whitespace character, and escaped non-newline characters.
// A backslash before a newline is malformed in a resource position and a
// trailing backslash decodes to U+FFFD like the CSS tokenizer.
function decodeCssEscapes(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\\") {
      out += character;
      continue;
    }
    let cursor = index + 1;
    if (cursor >= text.length) {
      out += "�";
      break;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(cursor));
    if (hex) {
      cursor += hex[0].length;
      const terminator = text[cursor];
      if (terminator === "\r" && text[cursor + 1] === "\n") cursor += 2;
      else if (/[\t\n\f\r ]/.test(terminator ?? "")) cursor += 1;
      const code = Number.parseInt(hex[0], 16);
      if (
        code === 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        out += "�";
      } else {
        out += String.fromCodePoint(code);
      }
      index = cursor - 1;
      continue;
    }
    const next = text[cursor];
    if (next === "\n" || next === "\r" || next === "\f") {
      violate("css-malformed-escape");
    }
    out += next;
    index = cursor;
  }
  return out;
}

function readCssString(css, start) {
  const quote = css[start];
  let out = "";
  let index = start + 1;
  while (index < css.length) {
    const character = css[index];
    if (character === quote) return { value: out, end: index + 1 };
    if (character === "\n") violate("css-malformed-string");
    out += character;
    index += 1;
  }
  violate("css-malformed-string");
}

function readUrlTarget(css, start) {
  let index = start;
  while (/\s/.test(css[index] ?? "")) index += 1;
  const character = css[index];
  if (character === '"' || character === "'") {
    return readCssString(css, index).value.trim();
  }
  const end = css.indexOf(")", index);
  if (end < 0) violate("css-malformed-url");
  return css.slice(index, end).trim();
}

function readImportTarget(css, start) {
  let index = start;
  while (/\s/.test(css[index] ?? "")) index += 1;
  const character = css[index];
  if (character === '"' || character === "'") {
    return readCssString(css, index).value.trim();
  }
  if (/^url\s*\(/i.test(css.slice(index, index + 8))) {
    const paren = css.indexOf("(", index);
    return readUrlTarget(css, paren + 1);
  }
  violate("css-malformed-import");
}

function readImageSetTargets(css, start) {
  let depth = 1;
  let index = start;
  let raw = "";
  while (index < css.length && depth > 0) {
    const character = css[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    raw += character;
    index += 1;
  }
  if (depth !== 0) violate("css-malformed-image-set");
  const candidates = [];
  let current = "";
  let quote = null;
  let depthInside = 0;
  for (const character of raw) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depthInside += 1;
    if (character === ")") depthInside -= 1;
    if (character === "," && depthInside === 0) {
      candidates.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  candidates.push(current);
  const targets = [];
  for (let candidate of candidates) {
    candidate = candidate.trim();
    if (candidate === "") continue;
    if (/^url\s*\(/i.test(candidate)) {
      targets.push(readUrlTarget(candidate, candidate.indexOf("(") + 1));
    } else if (candidate[0] === '"' || candidate[0] === "'") {
      targets.push(readCssString(candidate, 0).value.trim());
    } else {
      const token = candidate.split(/\s+/)[0];
      if (token) targets.push(token);
    }
  }
  return targets;
}

function extractCssTargets(css) {
  const targets = [];
  const imports = /@import\b/gi;
  let match;
  while ((match = imports.exec(css)) !== null) {
    targets.push({
      kind: "css-import",
      value: readImportTarget(css, match.index + match[0].length),
    });
  }
  const urls = /(^|[^\w-])url\s*\(/gi;
  while ((match = urls.exec(css)) !== null) {
    targets.push({
      kind: "css-url",
      value: readUrlTarget(css, match.index + match[0].length),
    });
  }
  const imageSets = /(^|[^\w-])(?:-webkit-)?image-set\s*\(/gi;
  while ((match = imageSets.exec(css)) !== null) {
    for (const value of readImageSetTargets(
      css,
      match.index + match[0].length,
    )) {
      targets.push({ kind: "css-image-set", value });
    }
  }
  return targets;
}

function scanCss(cssText) {
  const css = decodeCssEscapes(stripCssComments(cssText));
  for (const target of extractCssTargets(css)) {
    // CSS resolves through escapes, not HTML references. A url() may be an
    // image (img-src allows data:) or a font/import target, so @import keeps
    // the strict style-src context and url()/image-set keep the image one.
    classifyResourceUrl(target.value, target.kind, {
      allowData: target.kind !== "css-import",
      rejectReferences: false,
    });
  }
}

const RESOURCE_ATTRIBUTES = new Map([
  ["script|src", { rule: "html-script-src" }],
  ["img|src", { rule: "html-img-src", allowData: true }],
  ["audio|src", { rule: "html-media-src" }],
  ["video|src", { rule: "html-media-src" }],
  ["source|src", { rule: "html-media-src" }],
  ["track|src", { rule: "html-media-src" }],
  ["embed|src", { rule: "html-plugin-src" }],
  ["iframe|src", { rule: "html-iframe-src", allowAbout: true }],
  ["input|src", { rule: "html-img-src", allowData: true, imageInput: true }],
  ["img|srcset", { rule: "html-srcset", srcset: true }],
  ["source|srcset", { rule: "html-srcset", srcset: true }],
  ["video|poster", { rule: "html-video-poster", allowData: true }],
  ["object|data", { rule: "html-object-src" }],
  ["link|href", { rule: "html-link-href" }],
  ["base|href", { rule: "html-base-href" }],
  ["image|href", { rule: "html-svg-href" }],
  ["image|xlink:href", { rule: "html-svg-href" }],
  ["image|xlinkhref", { rule: "html-svg-href" }],
  ["use|href", { rule: "html-svg-href" }],
  ["use|xlink:href", { rule: "html-svg-href" }],
  ["use|xlinkhref", { rule: "html-svg-href" }],
  ["feimage|href", { rule: "html-svg-href" }],
  ["feimage|xlink:href", { rule: "html-svg-href" }],
  ["feimage|xlinkhref", { rule: "html-svg-href" }],
]);

// Shared by HTML tags and JSX elements. `getAttribute` returns the static
// attribute value (already unquoted; never decoded for HTML entities) or
// undefined. Every fetch-bearing context fails closed.
function classifyElement(tag, getAttribute, depth) {
  if (tag === "meta") {
    const httpEquiv = (getAttribute("http-equiv") ?? "")
      .trim()
      .toLowerCase();
    if (httpEquiv === "refresh") {
      const content = getAttribute("content");
      if (content !== undefined) {
        if (HTML_CHARACTER_REFERENCE.test(content)) {
          violate("html-meta-refresh-character-reference");
        }
        const urlMatch = /;\s*url\s*=/i.exec(content);
        if (urlMatch) {
          classifyResourceUrl(
            content.slice(urlMatch.index + urlMatch[0].length).trim(),
            "html-meta-refresh",
            { rejectReferences: false },
          );
        }
      }
    }
  }
  if (tag === "iframe") {
    const srcdoc = getAttribute("srcdoc");
    if (srcdoc !== undefined) {
      if (depth + 1 > SRCDOC_MAX_NESTING) violate("html-srcdoc-depth");
      if (srcdoc.length > SRCDOC_MAX_BYTES) violate("html-srcdoc-size");
      // Static srcdoc is parsed as a document by the browser; rejecting any
      // character reference beats maintaining an incomplete decoder.
      if (HTML_CHARACTER_REFERENCE.test(srcdoc)) {
        violate("html-srcdoc-character-reference");
      }
      scanHtmlMarkup(srcdoc, depth + 1);
    }
  }
  const styleValue = getAttribute("style");
  if (styleValue !== undefined) {
    if (HTML_CHARACTER_REFERENCE.test(styleValue)) {
      violate("html-style-attribute-character-reference");
    }
    scanCss(styleValue);
  }
  for (const [key, spec] of RESOURCE_ATTRIBUTES) {
    const separator = key.indexOf("|");
    if (key.slice(0, separator) !== tag) continue;
    const value = getAttribute(key.slice(separator + 1));
    if (value === undefined) continue;
    if (
      spec.imageInput &&
      (getAttribute("type") ?? "").trim().toLowerCase() !== "image"
    ) {
      continue;
    }
    if (spec.srcset) {
      if (HTML_CHARACTER_REFERENCE.test(value)) {
        violate(`${spec.rule}-character-reference`);
      }
      for (const candidate of parseSrcset(value)) {
        classifyResourceUrl(candidate, spec.rule, {
          allowData: true,
          rejectReferences: false,
        });
      }
      continue;
    }
    classifyResourceUrl(value, spec.rule, {
      allowData: Boolean(spec.allowData),
      allowAbout: Boolean(spec.allowAbout),
    });
  }
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
}

// Minimal tag tokenizer: case-insensitive names, quoted and unquoted values,
// first-wins duplicates (matching the browser), raw-text skipping for
// script/textarea/title/iframe, and raw <style> capture for CSS scanning.
function parseHtmlTags(text) {
  const tags = [];
  let index = 0;
  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (
      text.startsWith("<!", lt) ||
      text.startsWith("<?", lt) ||
      text.startsWith("</", lt)
    ) {
      const end = text.indexOf(">", lt);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(text.slice(lt));
    if (!nameMatch) {
      index = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    let cursor = lt + nameMatch[0].length;
    const attributes = new Map();
    let selfClosing = false;
    for (;;) {
      while (cursor < text.length && /[\s/]/.test(text[cursor])) cursor += 1;
      if (cursor >= text.length) break;
      if (text[cursor] === ">") {
        selfClosing = text[cursor - 1] === "/";
        cursor += 1;
        break;
      }
      const attrMatch = /^[^\s/>=]+/.exec(text.slice(cursor));
      if (!attrMatch) {
        cursor += 1;
        continue;
      }
      const attributeName = attrMatch[0].toLowerCase();
      cursor += attrMatch[0].length;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === "=") {
        cursor += 1;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
        const quote = text[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const end = text.indexOf(quote, cursor);
          const value = end < 0 ? text.slice(cursor) : text.slice(cursor, end);
          if (!attributes.has(attributeName)) {
            attributes.set(attributeName, value);
          }
          cursor = end < 0 ? text.length : end + 1;
        } else {
          let end = cursor;
          while (end < text.length && !/[\s>]/.test(text[end])) end += 1;
          if (!attributes.has(attributeName)) {
            attributes.set(attributeName, text.slice(cursor, end));
          }
          cursor = end;
        }
      } else if (!attributes.has(attributeName)) {
        attributes.set(attributeName, "");
      }
    }
    const tag = { name, attributes, content: undefined };
    tags.push(tag);
    if (
      !selfClosing &&
      ["style", "script", "textarea", "title", "iframe"].includes(name)
    ) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const closeMatch = new RegExp(`</${escaped}[\\s/>]`, "i").exec(
        text.slice(cursor),
      );
      if (closeMatch) {
        tag.content = text.slice(cursor, cursor + closeMatch.index);
        const gt = text.indexOf(">", cursor + closeMatch.index);
        cursor = gt < 0 ? text.length : gt + 1;
      }
    }
    index = cursor;
  }
  return tags;
}

function scanHtmlMarkup(text, depth) {
  const stripped = stripHtmlComments(text);
  for (const tag of parseHtmlTags(stripped)) {
    if (tag.name === "style" && tag.content !== undefined) scanCss(tag.content);
    classifyElement(
      tag.name,
      (attribute) => tag.attributes.get(attribute),
      depth,
    );
  }
}

function staticJsxValue(initializer) {
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer)) {
    const expression = initializer.expression;
    if (!expression) return undefined;
    if (ts.isStringLiteral(expression)) return expression.text;
    if (expression.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      return expression.text;
    }
    if (
      expression.kind === ts.SyntaxKind.TemplateExpression &&
      expression.templateSpans.length === 0
    ) {
      return expression.head.text;
    }
    return undefined;
  }
  return undefined;
}

function jsxAttributeName(name) {
  if (ts.isJsxNamespacedName(name)) {
    return `${name.namespace.getText()}:${name.name.getText()}`;
  }
  return name.getText();
}

function scanTsxSource(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (ts.isJsxAttribute(node)) {
      const owner = node.parent?.parent;
      if (
        owner &&
        (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
      ) {
        const tag = owner.tagName.getText().toLowerCase();
        const attributeName = jsxAttributeName(node.name).toLowerCase();
        const staticValueOf = (wanted) => {
          for (const property of owner.attributes.properties) {
            if (
              ts.isJsxAttribute(property) &&
              jsxAttributeName(property.name).toLowerCase() === wanted
            ) {
              return staticJsxValue(property.initializer);
            }
          }
          return undefined;
        };
        if (attributeName === "style") {
          const styleValue = staticJsxValue(node.initializer);
          if (typeof styleValue === "string") {
            if (HTML_CHARACTER_REFERENCE.test(styleValue)) {
              violate("html-style-attribute-character-reference");
            }
            scanCss(styleValue);
          } else if (
            ts.isJsxExpression(node.initializer) &&
            node.initializer.expression &&
            ts.isObjectLiteralExpression(node.initializer.expression)
          ) {
            for (const property of node.initializer.expression.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const initializer = property.initializer;
              const value =
                ts.isStringLiteral(initializer) ||
                initializer.kind ===
                  ts.SyntaxKind.NoSubstitutionTemplateLiteral
                  ? initializer.text
                  : undefined;
              if (typeof value === "string") scanCss(value);
            }
          }
        } else {
          const value = staticJsxValue(node.initializer);
          if (value !== undefined) {
            classifyElement(tag, (wanted) =>
              wanted === attributeName ? value : staticValueOf(wanted),
            0);
          }
        }
      }
    }
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText().toLowerCase() === "style"
    ) {
      for (const child of node.children) {
        if (child.kind === ts.SyntaxKind.JsxText) {
          if (child.text.trim() !== "") scanCss(child.text);
        } else if (ts.isJsxExpression(child) && child.expression) {
          const expression = child.expression;
          const value =
            ts.isStringLiteral(expression) ||
            expression.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
              ? expression.text
              : undefined;
          if (typeof value === "string") scanCss(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

// --- table-driven canaries (run before the repository scan) -----------------

const shellEgressCanaries = [
  // Positive: every enumerated fetch-bearing HTML/JSX surface.
  { label: "img double-quoted", kind: "html", expect: "remote", text: '<img src="https://cdn.example.invalid/x.png">' },
  { label: "script single-quoted", kind: "html", expect: "remote", text: "<script src='https://cdn.example.invalid/x.js'></script>" },
  { label: "img unquoted", kind: "html", expect: "remote", text: "<img src=https://cdn.example.invalid/x.png alt=x>" },
  { label: "mixed case", kind: "html", expect: "remote", text: '<IMG SRC="HTTPS://CDN.Example.Invalid/x.PNG">' },
  { label: "multiline", kind: "html", expect: "remote", text: '<img\n  src="https://cdn.example.invalid/x.png"\n  loading="lazy"\n/>' },
  { label: "iframe src", kind: "html", expect: "remote", text: '<iframe src="https://cdn.example.invalid/"></iframe>' },
  { label: "audio src", kind: "html", expect: "remote", text: '<audio src="https://cdn.example.invalid/a.mp3"></audio>' },
  { label: "video src", kind: "html", expect: "remote", text: '<video src="https://cdn.example.invalid/v.mp4"></video>' },
  { label: "source src", kind: "html", expect: "remote", text: '<picture><source src="https://cdn.example.invalid/x.webp"></picture>' },
  { label: "embed src", kind: "html", expect: "remote", text: '<embed src="https://cdn.example.invalid/x.swf">' },
  { label: "track src", kind: "html", expect: "remote", text: '<video><track src="https://cdn.example.invalid/x.vtt"></video>' },
  { label: "input image src", kind: "html", expect: "remote", text: '<input type="image" src="https://cdn.example.invalid/x.png">' },
  { label: "link href", kind: "html", expect: "remote", text: '<link rel="stylesheet" href="https://fonts.example.invalid/css">' },
  { label: "svg image href", kind: "html", expect: "remote", text: '<svg><image href="https://cdn.example.invalid/x.png"/></svg>' },
  { label: "svg use xlink:href", kind: "html", expect: "remote", text: '<svg><use xlink:href="https://cdn.example.invalid/s.svg#a"/></svg>' },
  { label: "feImage href", kind: "html", expect: "remote", text: '<svg><filter><feImage href="https://cdn.example.invalid/x.png"/></filter></svg>' },
  { label: "srcset remote second candidate", kind: "html", expect: "remote", text: '<img srcset="/local.png 1x, https://cdn.example.invalid/x.png 2x">' },
  { label: "video poster", kind: "html", expect: "remote", text: '<video poster="https://cdn.example.invalid/p.jpg"></video>' },
  { label: "object data", kind: "html", expect: "remote", text: '<object data="https://cdn.example.invalid/x.pdf"></object>' },
  { label: "remote base", kind: "html", expect: "remote", text: '<base href="https://cdn.example.invalid/"><img src="rel.png">' },
  { label: "meta refresh", kind: "html", expect: "remote", text: '<meta http-equiv="refresh" content="0; URL=https://cdn.example.invalid/x">' },
  { label: "inline style url", kind: "html", expect: "remote", text: '<div style="background: url(&quot;https://cdn.example.invalid/x.png&quot;)">' },
  { label: "style block import", kind: "html", expect: "remote", text: "<style>@import \"https://cdn.example.invalid/x.css\";</style>" },
  { label: "style block url", kind: "html", expect: "remote", text: "<style>.a { background: url(https://cdn.example.invalid/x.png); }</style>" },
  { label: "srcdoc nested remote image", kind: "html", expect: "remote", text: '<iframe srcdoc="<img src=\'https://cdn.example.invalid/leak.png\'>"></iframe>' },
  { label: "srcdoc bounded nesting", kind: "html", expect: "remote", text: '<iframe srcdoc="<iframe srcdoc=\'<iframe srcdoc=deep></iframe>\'>"></iframe>' },
  // Positive: browser-equivalent URL normalization and obfuscation.
  { label: "special scheme without slashes", kind: "html", expect: "remote", text: '<img src="https:example.invalid/a">' },
  { label: "backslash normalization", kind: "html", expect: "remote", text: '<img src="https:\\\\example.invalid/a">' },
  { label: "protocol relative", kind: "html", expect: "remote", text: '<img src="//cdn.example.invalid/x.png">' },
  { label: "numeric reference", kind: "html", expect: "remote", text: '<img src="&#104;ttps://cdn.example.invalid/x.png">' },
  { label: "named reference", kind: "html", expect: "remote", text: '<img src="https&colon;//cdn.example.invalid/x.png">' },
  { label: "style attribute reference", kind: "html", expect: "remote", text: '<div style="background:url(&#104;ttps://cdn.example.invalid/x.png)"></div>' },
  // Positive: CSS resource syntax.
  { label: "import quoted", kind: "css", expect: "remote", text: '@import "https://cdn.example.invalid/x.css";' },
  { label: "import protocol relative", kind: "css", expect: "remote", text: "@import url(//cdn.example.invalid/x.css);" },
  { label: "url quoted", kind: "css", expect: "remote", text: '.a { background: url("https://cdn.example.invalid/x.png"); }' },
  { label: "url unquoted", kind: "css", expect: "remote", text: ".a { background: url(https://cdn.example.invalid/x.png); }" },
  { label: "escaped url token", kind: "css", expect: "remote", text: ".a { background: u\\72 l(https://cdn.example.invalid/x.png); }" },
  { label: "escaped scheme", kind: "css", expect: "remote", text: ".a { background: url(https\\3a \\2f\\2fcdn.example.invalid/x.png); }" },
  { label: "image-set quoted remote second", kind: "css", expect: "remote", text: '.a { background-image: image-set("/local.png" 1x, "https://cdn.example.invalid/x.png" 2x); }' },
  { label: "image-set url remote second", kind: "css", expect: "remote", text: ".a { background-image: -webkit-image-set(url(/local.png) 1x, url(https://cdn.example.invalid/x.png) 2x); }" },
  // Positive: static JSX surfaces.
  { label: "jsx attribute", kind: "tsx", expect: "remote", text: 'export const v = <img src="https://cdn.example.invalid/x.png" />;' },
  { label: "jsx expression string", kind: "tsx", expect: "remote", text: 'export const v = <img src={"https://cdn.example.invalid/x.png"} />;' },
  { label: "jsx no-substitution template", kind: "tsx", expect: "remote", text: "export const v = <img src={`https://cdn.example.invalid/x.png`} />;" },
  { label: "jsx srcSet remote second", kind: "tsx", expect: "remote", text: 'export const v = <img srcSet={"/local.png 1x, https://cdn.example.invalid/x.png 2x"} />;' },
  { label: "jsx style object url", kind: "tsx", expect: "remote", text: 'export const v = <div style={{ backgroundImage: "url(https://cdn.example.invalid/x.png)" }} />;' },
  { label: "jsx style block import", kind: "tsx", expect: "remote", text: 'export const v = <style>{"@import \\"https://cdn.example.invalid/x.css\\";"}</style>;' },
  { label: "jsx input image src", kind: "tsx", expect: "remote", text: 'export const v = <input type="image" src="https://cdn.example.invalid/x.png" />;' },
  { label: "jsx svg use", kind: "tsx", expect: "remote", text: 'export const v = <svg><use xlinkHref="https://cdn.example.invalid/s.svg#a" /></svg>;' },
  // Negative: everything the shell legitimately uses or that is harmless text.
  { label: "local path", kind: "html", expect: "clean", text: '<img src="/assets/a.png"><script src="./app.js"></script><link href="a.css">' },
  { label: "fragment", kind: "html", expect: "clean", text: '<a href="#/settings">settings</a><img src="#anchor">' },
  { label: "data image", kind: "html", expect: "clean", text: '<img src="data:image/png;base64,iVBORw0KGgo=">' },
  { label: "about blank iframe", kind: "html", expect: "clean", text: '<iframe src="about:blank"></iframe>' },
  { label: "html comment", kind: "html", expect: "clean", text: '<!-- <img src="https://cdn.example.invalid/x.png"> --><p>safe</p>' },
  { label: "anchor navigation control", kind: "html", expect: "clean", text: '<a href="https://github.com/computerbraincompany/borealis">source</a>' },
  { label: "local base", kind: "html", expect: "clean", text: '<base href="/"><img src="ok.png">' },
  { label: "non-refresh meta", kind: "html", expect: "clean", text: '<meta http-equiv="content-type" content="text/html; charset=utf-8">' },
  { label: "plain meta name", kind: "html", expect: "clean", text: '<meta name="viewport" content="width=device-width">' },
  { label: "clean srcdoc", kind: "html", expect: "clean", text: '<iframe srcdoc="<p>local preview</p>" sandbox="allow-scripts"></iframe>' },
  { label: "url text outside resources", kind: "html", expect: "clean", text: "<p>see https://cdn.example.invalid/docs for help</p>" },
  { label: "script content ignored", kind: "html", expect: "clean", text: '<script>const u = "https://cdn.example.invalid/x.png"; if (a < b) { }</script>' },
  { label: "css comment", kind: "css", expect: "clean", text: '/* background: url(https://cdn.example.invalid/x.png) */ .a { color: red; }' },
  { label: "plain css text", kind: "css", expect: "clean", text: ".a { color: hsl(216 38% 97%); font-family: ui-monospace, monospace; }" },
  { label: "css string not url", kind: "css", expect: "clean", text: '.a { content: "https://cdn.example.invalid/x.png"; }' },
  { label: "css local urls", kind: "css", expect: "clean", text: '.a { background: url("/assets/a.png"); } @import "local.css";' },
  { label: "css data url", kind: "css", expect: "clean", text: ".a { background: url(data:image/svg+xml,<svg/>); }" },
  { label: "jsx harmless strings", kind: "tsx", expect: "clean", text: 'export const docs = "https://cdn.example.invalid/x.png"; export const v = <a href="https://github.com/x/y">docs</a>; export const w = <div title="https://cdn.example.invalid/t">t</div>;' },
  { label: "jsx dynamic attribute", kind: "tsx", expect: "clean", text: "export const v = (u: string) => <img src={u} />;" },
  { label: "jsx local resources", kind: "tsx", expect: "clean", text: 'export const v = <img src="/logo.svg" alt="logo" style={{ width: 40 }} />;' },
];

function runShellCanary(canary) {
  try {
    if (canary.kind === "html") scanHtmlMarkup(canary.text, 0);
    else if (canary.kind === "css") scanCss(canary.text);
    else scanTsxSource(canary.text, "canary.tsx");
    return null;
  } catch (error) {
    if (error instanceof ShellEgressViolation) return error.rule;
    throw error;
  }
}

for (const canary of shellEgressCanaries) {
  let rule;
  try {
    rule = runShellCanary(canary);
  } catch (error) {
    fail(`Shell egress canary "${canary.label}" crashed: ${error?.message ?? error}`);
    process.exit(1);
  }
  if (canary.expect === "remote" && rule === null) {
    fail(`Shell egress canary missed a remote resource: "${canary.label}".`);
    process.exit(1);
  }
  if (canary.expect === "clean" && rule !== null) {
    fail(`Shell egress canary rejected a harmless value: "${canary.label}" (${rule}).`);
    process.exit(1);
  }
}

// --- production CSP attachment must remain on both shell HTML paths ---------

const serverAppSource = readFileSync(
  path.join(repositoryDirectory, "server", "src", "serverApp.ts"),
  "utf8",
);
if (
  !serverAppSource.includes("export const STATIC_UI_CSP") ||
  (serverAppSource.match(/STATIC_UI_CSP/g) ?? []).length < 3 ||
  (serverAppSource.match(/Content-Security-Policy/g) ?? []).length < 2 ||
  !serverAppSource.includes("default-src 'self'") ||
  !serverAppSource.includes("object-src 'none'") ||
  !serverAppSource.includes("frame-ancestors 'none'") ||
  !serverAppSource.includes("frame-src about:")
) {
  fail(
    "The production shell CSP attachment in server/src/serverApp.ts is missing or incomplete.",
  );
  process.exit(1);
}

// --- tracked-source inventory scan ------------------------------------------

const shellInventory = gitFiles.filter((filePath) => {
  const relative = posixRelative(filePath);
  if (relative === "web/index.html") return true;
  if (relative.startsWith("web/") && relative.endsWith(".css")) return true;
  if (
    relative.startsWith("web/src/") &&
    (relative.endsWith(".ts") || relative.endsWith(".tsx")) &&
    !/\.test\.(ts|tsx)$/.test(relative) &&
    !relative.startsWith("web/src/test/")
  ) {
    return true;
  }
  return false;
});

const shellDiagnostics = [];
for (const filePath of shellInventory) {
  const relative = posixRelative(filePath);
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  try {
    if (relative === "web/index.html") scanHtmlMarkup(contents, 0);
    else if (relative.endsWith(".css")) scanCss(contents);
    else scanTsxSource(contents, relative);
  } catch (error) {
    if (error instanceof ShellEgressViolation) {
      shellDiagnostics.push(
        `${relative}: browser-fetching shell surface violates rule ${error.rule}`,
      );
      continue;
    }
    fail(`Shell egress scan crashed on ${relative}: ${error?.message ?? error}`);
    process.exit(1);
  }
}
if (shellDiagnostics.length > 0) {
  process.stderr.write(`${shellDiagnostics.join("\n")}\n`);
  fail(
    "The production shell must not name remote resources in browser-fetching positions; the CSP would block them at runtime.",
  );
  process.exit(1);
}
