import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";

export interface TempSqliteLedger {
  readonly directory: string;
  readonly filename: string;
  readonly ledger: SqliteLedger;
  cleanup(): Promise<void>;
}

export async function createTempSqliteLedger(): Promise<TempSqliteLedger> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-sqlite-test-"));
  const filename = path.join(directory, "ledger.sqlite");
  const ledger = await openSqliteLedger({ path: filename });
  let cleaned = false;
  return {
    directory,
    filename,
    ledger,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await ledger.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
