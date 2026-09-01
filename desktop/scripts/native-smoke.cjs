const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "borealis-electron-native-"),
  );
  try {
    const Database = require("better-sqlite3");
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE smoke (value INTEGER NOT NULL)");
    sqlite.prepare("INSERT INTO smoke (value) VALUES (?)").run(1);
    if (sqlite.prepare("SELECT value FROM smoke").get().value !== 1)
      throw new Error("SQLite smoke failed");
    sqlite.close();

    const lancedb = require("@lancedb/lancedb");
    const lance = await lancedb.connect(
      path.join(temporaryDirectory, "lancedb"),
    );
    const table = await lance.createTable("smoke", [
      { id: "row", vector: [1, 0, 0] },
    ]);
    const rows = await table.vectorSearch([1, 0, 0]).limit(1).toArray();
    if (rows[0]?.id !== "row") throw new Error("LanceDB smoke failed");
    table.close();
    lance.close();

    const { DuckDBInstance } = require("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run("SELECT 1");
    connection.closeSync();
    instance.closeSync();

    process.stdout.write(
      JSON.stringify({
        ok: true,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        native: ["better-sqlite3", "@lancedb/lancedb", "@duckdb/node-api"],
      }) + "\n",
    );
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("Electron native-module smoke failed.\n");
  process.exitCode = 1;
});
