import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
