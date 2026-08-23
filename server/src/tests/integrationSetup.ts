import "dotenv/config";

if (process.env.RUN_SOURCE_SCOPE_INTEGRATION !== "1") {
  throw new Error("source-scope integration tests require RUN_SOURCE_SCOPE_INTEGRATION=1");
}

const candidate = process.env.TEST_DATABASE_URL;
if (!candidate) {
  throw new Error("source-scope integration tests require TEST_DATABASE_URL");
}

function parseDatabaseUrl(raw: string): { target: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres protocol");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new Error("TEST_DATABASE_URL must name one database");
  }
  const host = decodeURIComponent(parsed.searchParams.get("host") || parsed.hostname).toLowerCase();
  const port = parsed.port || "5432";
  return { target: `${host}:${port}/${database}`, database };
}

const testDatabase = parseDatabaseUrl(candidate);
if (!testDatabase.database.endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL database name must end in _test");
}

const ambient = process.env.DATABASE_URL;
if (ambient && parseDatabaseUrl(ambient).target === testDatabase.target) {
  throw new Error("TEST_DATABASE_URL must differ from the ambient DATABASE_URL");
}

process.env.DATABASE_URL = candidate;
