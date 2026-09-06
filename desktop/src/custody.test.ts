import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBackendMessage } from "./contracts.js";
import { ConnectionKeyVault, type SafeStorageLike } from "./custody.js";

const ACCOUNT_SCOPE_KEY_FILE = "sealed-key.bin";

class FakeSafeStorage implements SafeStorageLike {
  available = true;
  decryptCalls = 0;
  encryptCalls = 0;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plaintext: string): Buffer {
    if (!this.available) throw new Error("unavailable");
    this.encryptCalls += 1;
    return Buffer.from(
      `SEALED:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      "utf8",
    );
  }

  decryptString(encrypted: Buffer): string {
    this.decryptCalls += 1;
    const text = encrypted.toString("utf8");
    if (!text.startsWith("SEALED:")) throw new Error("corrupt");
    return Buffer.from(text.slice("SEALED:".length), "base64").toString("utf8");
  }
}

async function tempVault(
  storage: FakeSafeStorage = new FakeSafeStorage(),
): Promise<{
  vault: ConnectionKeyVault;
  storage: FakeSafeStorage;
  keyFile: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "borealis-custody-"));
  const keyFile = path.join(root, "connection-custody", ACCOUNT_SCOPE_KEY_FILE);
  return {
    vault: new ConnectionKeyVault(storage, keyFile),
    storage,
    keyFile,
    root,
  };
}

test("read never creates the key and reports the actionable custody state", async () => {
  const { vault, storage } = await tempVault();
  const response = await vault.handle({
    type: "custody-request",
    request_id: "r1",
    op: "read",
  });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.reason, "custody");
  assert.equal(storage.encryptCalls, 0);
});

test("ensure creates exactly one 32-byte key with durable containment", async () => {
  const { vault, storage, keyFile } = await tempVault();
  const created = await vault.handle({
    type: "custody-request",
    request_id: "r1",
    op: "ensure",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  assert.equal(created.data.byteLength, 32);
  assert.equal(storage.encryptCalls, 1);

  const sealed = await readFile(keyFile);
  // The sealed file carries only the safeStorage envelope, never raw key bytes.
  assert.ok(sealed.toString("utf8").startsWith("SEALED:"));
  assert.ok(!sealed.includes(Buffer.from(created.data).subarray(0, 8)));
  const info = await stat(keyFile);
  assert.equal(info.mode & 0o777, 0o600);

  // `read` then serves from the bounded cache without re-touching the keychain.
  const again = await vault.handle({
    type: "custody-request",
    request_id: "r2",
    op: "read",
  });
  assert.deepEqual(again.ok && again.data, created.data);
  assert.equal(storage.decryptCalls, 0);
  void readFile;
});

test("a second vault instance (new process) reopens the same sealed key", async () => {
  const first = await tempVault();
  const created = await first.vault.handle({
    type: "custody-request",
    request_id: "r1",
    op: "ensure",
  });
  assert.ok(created.ok);
  const storage2 = new FakeSafeStorage();
  const second = new ConnectionKeyVault(storage2, first.keyFile);
  const reopened = await second.handle({
    type: "custody-request",
    request_id: "r2",
    op: "read",
  });
  assert.deepEqual(reopened.ok && reopened.data, created.ok && created.data);
});

test("clear() drops the cache and a corrupt seal reports the record state", async () => {
  const { vault, storage, keyFile } = await tempVault();
  await vault.handle({
    type: "custody-request",
    request_id: "r1",
    op: "ensure",
  });
  vault.clear();
  await writeFile(keyFile, Buffer.from("NOT-A-SEAL"), { mode: 0o600 });
  const response = await vault.handle({
    type: "custody-request",
    request_id: "r2",
    op: "read",
  });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.reason, "record");
  assert.ok(storage.decryptCalls >= 1);
});

test("ensure fails closed when OS-protected storage is unavailable", async () => {
  const storage = new FakeSafeStorage();
  storage.available = false;
  const { vault, keyFile } = await tempVault(storage);
  const response = await vault.handle({
    type: "custody-request",
    request_id: "r1",
    op: "ensure",
  });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.reason, "custody");
  await assert.rejects(() => readFile(keyFile));
});

test("the vault rejects a relative key path", () => {
  assert.throws(
    () => new ConnectionKeyVault(new FakeSafeStorage(), "relative/key.bin"),
  );
});

test("the custody request contract accepts only read and ensure", () => {
  assert.deepEqual(
    parseBackendMessage({
      type: "custody-request",
      request_id: "req-1",
      op: "ensure",
      extra: "ignored",
    }),
    { type: "custody-request", request_id: "req-1", op: "ensure" },
  );
  assert.equal(
    parseBackendMessage({
      type: "custody-request",
      request_id: "req-1",
      op: "read",
    })?.type,
    "custody-request",
  );
  // Every historical per-record operation and any scope/secret material is refused.
  for (const op of ["encrypt", "decrypt", "delete", "list", "", undefined]) {
    assert.equal(
      parseBackendMessage({ type: "custody-request", request_id: "req-1", op }),
      undefined,
    );
  }
  // Extra material is dropped: extraction keeps only the two contract fields.
  assert.deepEqual(
    parseBackendMessage({
      type: "custody-request",
      request_id: "req-1",
      op: "ensure",
      plaintext: "secret",
    }),
    { type: "custody-request", request_id: "req-1", op: "ensure" },
  );
  assert.equal(
    parseBackendMessage({ type: "custody-request", op: "read" }),
    undefined,
  );
});

test("the open-verify response is parsed narrowly", () => {
  assert.deepEqual(
    parseBackendMessage({
      type: "open-verify-response",
      request_id: "r-9",
      ok: true,
    }),
    {
      type: "open-verify-response",
      request_id: "r-9",
      ok: true,
    },
  );
  assert.equal(
    parseBackendMessage({
      type: "open-verify-response",
      request_id: "",
      ok: true,
    }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({
      type: "open-verify-response",
      request_id: "r",
      ok: "yes",
    }),
    undefined,
  );
});
