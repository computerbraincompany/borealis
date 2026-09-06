import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionConfigError } from "../connections/store.js";
import {
  ConnectionCustodyUnavailableError,
  connectionSecrets,
  FileConnectionSecretStore,
  FileKeyCustody,
  type ConnectionKeyCustody,
} from "../connections/secrets.js";

const ACCOUNT = randomUUID();
const CONNECTION = randomUUID();
const OTHER_CONNECTION = randomUUID();
const SECRETS = { headers: { authorization: "Bearer super-secret-token" }, env: { API_KEY: "stdio-secret-value" } };

const directories: string[] = [];

async function tempRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-secrets-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function storeIn(root: string): FileConnectionSecretStore {
  return new FileConnectionSecretStore({
    directory: path.join(root, "secrets"),
    custody: new FileKeyCustody(path.join(root, "connections.key")),
  });
}

function recordPath(root: string, connectionId: string): string {
  return path.join(root, "secrets", ACCOUNT, `${connectionId}.json`);
}

async function scanForPlaintext(root: string, needle: string): Promise<string[]> {
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const text = await fs.readFile(full, "utf8").catch(() => "");
        if (text.includes(needle)) offenders.push(full);
      }
    }
  };
  await walk(root);
  return offenders;
}

describe("connection secret custody", () => {
  it("round-trips, rotates, and removes encrypted credential records", async () => {
    const root = await tempRoot();
    const store = storeIn(root);

    expect(await store.read(ACCOUNT, CONNECTION)).toEqual({ state: "absent" });
    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));
    const read = await store.read(ACCOUNT, CONNECTION);
    expect(read).toMatchObject({ state: "available" });
    if (read.state !== "available") throw new Error("unreachable");
    expect(read.secrets.headers.authorization).toBe(SECRETS.headers.authorization);
    expect(read.secrets.env.API_KEY).toBe(SECRETS.env.API_KEY);

    // Rotation replaces material completely.
    await store.put(ACCOUNT, CONNECTION, connectionSecrets({ headers: { authorization: "Bearer rotated-token" } }));
    const rotated = await store.read(ACCOUNT, CONNECTION);
    expect(rotated).toMatchObject({ state: "available" });
    if (rotated.state === "available") {
      expect(rotated.secrets.headers.authorization).toBe("Bearer rotated-token");
      expect(Object.keys(rotated.secrets.env)).toEqual([]);
    }
    expect(await scanForPlaintext(root, "super-secret-token")).toEqual([]);
    expect(await scanForPlaintext(root, "rotated-token")).toEqual([]);

    await store.remove(ACCOUNT, CONNECTION);
    expect(await store.read(ACCOUNT, CONNECTION)).toEqual({ state: "absent" });
    await expect(store.remove(ACCOUNT, CONNECTION)).resolves.toBeUndefined();
  });

  it("keeps durable custody files private and leaves no temporary residue", async () => {
    const root = await tempRoot();
    const store = storeIn(root);
    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));

    const keyStat = await fs.stat(path.join(root, "connections.key"));
    expect(keyStat.mode & 0o777).toBe(0o600);
    const recordStat = await fs.stat(recordPath(root, CONNECTION));
    expect(recordStat.mode & 0o777).toBe(0o600);
    const accountDirStat = await fs.stat(path.join(root, "secrets", ACCOUNT));
    expect(accountDirStat.mode & 0o777).toBe(0o700);

    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));
    const leftovers = (await fs.readdir(path.dirname(recordPath(root, CONNECTION)))).filter((name) =>
      name.includes(".tmp")
    );
    expect(leftovers).toEqual([]);

    // A pre-existing widened mode is repaired on read, as elsewhere.
    await fs.chmod(recordPath(root, CONNECTION), 0o644);
    expect(await store.read(ACCOUNT, CONNECTION)).toMatchObject({ state: "available" });
    expect(((await fs.stat(recordPath(root, CONNECTION))).mode & 0o777) === 0o600).toBe(true);
  });

  it("treats unavailable custody as an actionable state, never a crash or plaintext", async () => {
    const root = await tempRoot();
    const store = storeIn(root);
    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));

    await fs.writeFile(path.join(root, "connections.key"), "not-a-key\n", { mode: 0o600 });
    expect(await store.read(ACCOUNT, CONNECTION)).toEqual({ state: "unavailable", reason: "custody" });
    await expect(store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS))).rejects.toBeInstanceOf(
      ConnectionCustodyUnavailableError
    );

    // A garbage custody file must not be silently replaced.
    expect((await fs.readFile(path.join(root, "connections.key"), "utf8")).trim()).toBe("not-a-key");
  });

  it("fails closed on tampered, cross-scope, and symlinked records", async () => {
    const root = await tempRoot();
    const store = storeIn(root);
    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));

    const original = recordPath(root, CONNECTION);
    const bytes = await fs.readFile(original);

    // Cross-scope substitution: the AAD binds ciphertext to its exact scope.
    await fs.mkdir(path.dirname(recordPath(root, OTHER_CONNECTION)), { recursive: true, mode: 0o700 });
    await fs.writeFile(recordPath(root, OTHER_CONNECTION), bytes, { mode: 0o600 });
    expect(await store.read(ACCOUNT, OTHER_CONNECTION)).toMatchObject({ state: "unavailable" });

    // Tampering inside the ciphertext.
    const text = bytes.toString("utf8");
    const ctStart = text.indexOf('"ct":"') + 7;
    await fs.writeFile(original, `${text.slice(0, ctStart)}${text.slice(ctStart + 2)}AA${text.slice(ctStart + 4)}`, {
      mode: 0o600,
    });
    expect(await store.read(ACCOUNT, CONNECTION)).toMatchObject({ state: "unavailable" });

    // A symlinked record is refused rather than read through.
    const linkRoot = await tempRoot();
    const symlink = path.join(linkRoot, "escape.json");
    await fs.symlink(original, symlink);
    // A link that lives outside the store's own scoped path is never read.
    const escaped = storeIn(linkRoot);
    expect(await escaped.read(ACCOUNT, CONNECTION)).toEqual({ state: "absent" });
    const store2Root = await tempRoot();
    const store2 = new FileConnectionSecretStore({
      directory: path.join(store2Root, "secrets"),
      custody: new FileKeyCustody(path.join(store2Root, "connections.key")),
    });
    await store2.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));
    const real = recordPath(store2Root, CONNECTION);
    await fs.rename(real, `${real}.real`);
    await fs.symlink(`${real}.real`, real);
    expect(await store2.read(ACCOUNT, CONNECTION)).toMatchObject({ state: "unavailable" });
    expect(await scanForPlaintext(store2Root, "stdio-secret-value")).toEqual([]);
    expect(symlink).toBeDefined();
  });

  it("accepts an injected custody adapter, the desktop OS-keychain seam", async () => {
    const root = await tempRoot();
    const injectedKey = randomBytes(32);
    class InMemoryCustody implements ConnectionKeyCustody {
      available = true;
      async readKey(): Promise<Buffer | undefined> {
        return this.available ? injectedKey : undefined;
      }
      async ensureKey(): Promise<Buffer | undefined> {
        return this.readKey();
      }
    }
    const custody = new InMemoryCustody();
    const store = new FileConnectionSecretStore({ directory: path.join(root, "secrets"), custody });

    await store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS));
    expect(await store.read(ACCOUNT, CONNECTION)).toMatchObject({ state: "available" });
    // No key file exists for in-memory custody; nothing key-shaped on disk.
    await expect(fs.stat(path.join(root, "connections.key"))).rejects.toMatchObject({ code: "ENOENT" });

    custody.available = false;
    expect(await store.read(ACCOUNT, CONNECTION)).toEqual({ state: "unavailable", reason: "custody" });
    await expect(store.put(ACCOUNT, CONNECTION, connectionSecrets(SECRETS))).rejects.toBeInstanceOf(
      ConnectionCustodyUnavailableError
    );
    // The failed put committed nothing new.
    custody.available = true;
    expect(await store.read(ACCOUNT, CONNECTION)).toMatchObject({ state: "available" });
  });

  it("validates credential shapes strictly", () => {
    expect(connectionSecrets({ headers: { authorization: "Bearer x" }, env: { TOKEN: "y" } })).toEqual({
      headers: { authorization: "Bearer x" },
      env: { TOKEN: "y" },
    });
    for (const invalid of [
      {},
      [],
      null,
      { token: "secret" },
      { headers: {} },
      { headers: { authorization: "" } },
      { headers: { authorization: "a\r\nb" } },
      { headers: { "bad name": "x" } },
      { headers: { authorization: "x".repeat(4_097) } },
      { env: { "1BAD": "x" } },
      { env: { A: "x".repeat(4_097) } },
      { headers: Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`h${n}`, "x"])) },
      { env: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`E${n}`, "x"])) },
      { headers: { a: "y".repeat(20_000) }, env: { B: "z".repeat(20_000) } },
    ]) {
      expect(() => connectionSecrets(invalid), JSON.stringify(invalid)?.slice(0, 40)).toThrow(ConnectionConfigError);
    }
  });
});
