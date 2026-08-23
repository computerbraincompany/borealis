import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageTest = vi.hoisted(() => ({ root: `/tmp/borealis-storage-artifacts-vitest-${process.pid}` }));
vi.mock("../config.js", () => ({
  config: {
    uploadDir: `${storageTest.root}/uploads`,
    reportDir: `${storageTest.root}/reports`,
  },
}));

import {
  createReportResourceDirectory,
  createUploadResourceDirectory,
  removeReportArtifacts,
  removeSourceArtifact,
  resolveReportArtifact,
  resolveSourceArtifact,
} from "../storageArtifacts.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceId = "22222222-2222-4222-8222-222222222222";
const reportId = "33333333-3333-4333-8333-333333333333";
const TEST_ROOT = storageTest.root;

beforeEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("tenant artifact path boundaries", () => {
  it("refuses upload creation through an account or source namespace symlink", async () => {
    const otherAccount = path.join(TEST_ROOT, "uploads", otherAccountId);
    const linkedAccount = path.join(TEST_ROOT, "uploads", accountId);
    await fs.mkdir(otherAccount, { recursive: true });
    await fs.symlink(otherAccount, linkedAccount);
    await expect(createUploadResourceDirectory(accountId, sourceId)).rejects.toThrow("unsafe storage namespace");
    await expect(fs.access(path.join(otherAccount, sourceId))).rejects.toThrow();

    await fs.unlink(linkedAccount);
    await fs.mkdir(linkedAccount);
    const otherSource = path.join(otherAccount, sourceId);
    await fs.mkdir(otherSource);
    await fs.writeFile(path.join(otherSource, "ledger.csv"), "other-source");
    await fs.symlink(otherSource, path.join(linkedAccount, sourceId));
    await expect(createUploadResourceDirectory(accountId, sourceId)).rejects.toThrow();
    await expect(
      resolveSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: path.join(linkedAccount, sourceId, "ledger.csv"),
      })
    ).resolves.toBe(undefined);
    await expect(fs.readdir(otherSource)).resolves.toEqual(["ledger.csv"]);
  });

  it("refuses report creation through an account namespace symlink", async () => {
    const otherAccount = path.join(TEST_ROOT, "reports", otherAccountId);
    const linkedAccount = path.join(TEST_ROOT, "reports", accountId);
    await fs.mkdir(otherAccount, { recursive: true });
    await fs.symlink(otherAccount, linkedAccount);
    await expect(createReportResourceDirectory(accountId, reportId)).rejects.toThrow("unsafe storage namespace");
    await expect(fs.access(path.join(otherAccount, reportId))).rejects.toThrow();
  });

  it("resolves only an exact non-symlink account/source upload file for reads", async () => {
    const directory = await createUploadResourceDirectory(accountId, sourceId);
    const owned = path.join(directory, "ledger.csv");
    await fs.writeFile(owned, "owned");
    await expect(resolveSourceArtifact({ accountId, sourceId, name: "ledger", filePath: owned })).resolves.toBe(
      await fs.realpath(owned)
    );

    const outside = path.join(TEST_ROOT, "outside.csv");
    await fs.writeFile(outside, "outside");
    await expect(resolveSourceArtifact({ accountId, sourceId, name: "ledger", filePath: outside })).resolves.toBe(
      undefined
    );

    const linked = path.join(directory, "linked.csv");
    await fs.symlink(outside, linked);
    await expect(resolveSourceArtifact({ accountId, sourceId, name: "ledger", filePath: linked })).resolves.toBe(
      undefined
    );
  });

  it("removes only the exact account/source UUID upload directory", async () => {
    const ownedDirectory = path.join(TEST_ROOT, "uploads", accountId, sourceId);
    const siblingDirectory = path.join(TEST_ROOT, "uploads", accountId, "sibling-source");
    const ownedFile = path.join(ownedDirectory, "ledger.csv");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.mkdir(siblingDirectory, { recursive: true });
    await fs.writeFile(ownedFile, "owned");
    await fs.writeFile(path.join(siblingDirectory, "keep.csv"), "keep");

    await expect(removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: ownedFile })).resolves.toBe(
      true
    );

    await expect(fs.access(ownedDirectory)).rejects.toThrow();
    await expect(fs.readFile(path.join(siblingDirectory, "keep.csv"), "utf8")).resolves.toBe("keep");
  });

  it("fails closed on a legacy shared-prefix upload that cannot prove the full account", async () => {
    const legacyDirectory = path.join(TEST_ROOT, "uploads", "legacy-shared");
    const target = path.join(legacyDirectory, "target.csv");
    const sibling = path.join(legacyDirectory, "keep.csv");
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(target, "target");
    await fs.writeFile(sibling, "keep");

    await expect(removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: target })).resolves.toBe(false);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("target");
    await expect(fs.readFile(sibling, "utf8")).resolves.toBe("keep");
  });

  it("refuses a within-root source path reached through another account directory symlink", async () => {
    const otherDirectory = path.join(TEST_ROOT, "uploads", otherAccountId, sourceId);
    const target = path.join(otherDirectory, "ledger.csv");
    const linkedAccountDirectory = path.join(TEST_ROOT, "uploads", accountId);
    await fs.mkdir(otherDirectory, { recursive: true });
    await fs.writeFile(target, "other-account");
    await fs.symlink(path.join(TEST_ROOT, "uploads", otherAccountId), linkedAccountDirectory);

    await expect(
      resolveSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: path.join(linkedAccountDirectory, sourceId, "ledger.csv"),
      })
    ).resolves.toBe(undefined);

    await expect(
      removeSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: path.join(linkedAccountDirectory, sourceId, "ledger.csv"),
      })
    ).resolves.toBe(false);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("other-account");
  });

  it("refuses a source artifact file symlink even when its target remains inside the upload root", async () => {
    const ownedDirectory = path.join(TEST_ROOT, "uploads", accountId, sourceId);
    const otherFile = path.join(TEST_ROOT, "uploads", otherAccountId, sourceId, "ledger.csv");
    const linkedFile = path.join(ownedDirectory, "ledger.csv");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.mkdir(path.dirname(otherFile), { recursive: true });
    await fs.writeFile(otherFile, "other-account");
    await fs.symlink(otherFile, linkedFile);

    await expect(removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: linkedFile })).resolves.toBe(
      false
    );
    await expect(fs.readFile(otherFile, "utf8")).resolves.toBe("other-account");
    await expect(fs.lstat(linkedFile).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it("removes only an exact full-account connector cache version", async () => {
    const { createHash } = await import("node:crypto");
    const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
    const cacheDirectory = path.join(TEST_ROOT, "uploads", "url_cache", accountKey, "ledger");
    const target = path.join(cacheDirectory, "0123456789abcdef0123456789abcdef.csv");
    const sibling = path.join(cacheDirectory, "keep.csv");
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.writeFile(target, "target");
    await fs.writeFile(sibling, "keep");

    await expect(
      resolveSourceArtifact({ accountId, sourceId, name: "ledger", filePath: target, connector: "connector-id" })
    ).resolves.toBe(await fs.realpath(target));

    await expect(
      removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: target, connector: "connector-id" })
    ).resolves.toBe(true);

    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readFile(sibling, "utf8")).resolves.toBe("keep");
  });

  it("refuses connector cache namespace and candidate symlinks", async () => {
    const { createHash } = await import("node:crypto");
    const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
    const accountCache = path.join(TEST_ROOT, "uploads", "url_cache", accountKey);
    const otherTable = path.join(accountCache, "other_table");
    const linkedTable = path.join(accountCache, "ledger");
    const versionName = "0123456789abcdef0123456789abcdef.csv";
    const otherTarget = path.join(otherTable, versionName);
    await fs.mkdir(otherTable, { recursive: true });
    await fs.writeFile(otherTarget, "other-table");
    await fs.symlink(otherTable, linkedTable);

    await expect(
      removeSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: path.join(linkedTable, versionName),
        connector: "connector-id",
      })
    ).resolves.toBe(false);
    await expect(fs.readFile(otherTarget, "utf8")).resolves.toBe("other-table");

    await fs.unlink(linkedTable);
    await fs.mkdir(linkedTable);
    const linkedCandidate = path.join(linkedTable, versionName);
    await fs.symlink(otherTarget, linkedCandidate);
    await expect(
      removeSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: linkedCandidate,
        connector: "connector-id",
      })
    ).resolves.toBe(false);
    await expect(fs.readFile(otherTarget, "utf8")).resolves.toBe("other-table");
  });

  it("rejects connector cache files without an immutable version filename", async () => {
    const { createHash } = await import("node:crypto");
    const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
    const target = path.join(TEST_ROOT, "uploads", "url_cache", accountKey, "ledger", "latest.csv");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "mutable");

    await expect(
      removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: target, connector: "connector-id" })
    ).resolves.toBe(false);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("mutable");
  });

  it("refuses a connector cache path owned by another table in the same account", async () => {
    const { createHash } = await import("node:crypto");
    const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
    const otherTableFile = path.join(TEST_ROOT, "uploads", "url_cache", accountKey, "other_table", "version.csv");
    await fs.mkdir(path.dirname(otherTableFile), { recursive: true });
    await fs.writeFile(otherTableFile, "other");

    await expect(
      removeSourceArtifact({
        accountId,
        sourceId,
        name: "ledger",
        filePath: otherTableFile,
        connector: "connector-id",
      })
    ).resolves.toBe(false);
    await expect(fs.readFile(otherTableFile, "utf8")).resolves.toBe("other");
  });

  it("refuses an out-of-root source path", async () => {
    const outside = path.join(TEST_ROOT, "outside.txt");
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await fs.writeFile(outside, "private");

    await expect(removeSourceArtifact({ accountId, sourceId, name: "ledger", filePath: outside })).resolves.toBe(false);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("private");
  });

  it("resolves only exact UUID-scoped report reads and rejects cross-account paths", async () => {
    const ownedDirectory = path.join(TEST_ROOT, "reports", accountId, reportId);
    const ownedHtml = path.join(ownedDirectory, "report.html");
    const otherHtml = path.join(TEST_ROOT, "reports", "other-account", reportId, "report.html");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.mkdir(path.dirname(otherHtml), { recursive: true });
    await fs.writeFile(ownedHtml, "owned");
    await fs.writeFile(otherHtml, "other");

    await expect(resolveReportArtifact({ accountId, reportId, filePath: ownedHtml, kind: "html" })).resolves.toBe(
      await fs.realpath(ownedHtml)
    );
    await expect(
      resolveReportArtifact({ accountId, reportId, filePath: otherHtml, kind: "html" })
    ).resolves.toBeUndefined();
  });

  it("fails closed when an owned report filename is a symlink outside the root", async () => {
    const outside = path.join(TEST_ROOT, "outside.html");
    const ownedDirectory = path.join(TEST_ROOT, "reports", accountId, reportId);
    const link = path.join(ownedDirectory, "report.html");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.writeFile(outside, "private");
    await fs.symlink(outside, link);

    await expect(resolveReportArtifact({ accountId, reportId, filePath: link, kind: "html" })).resolves.toBeUndefined();
  });

  it("refuses report access and deletion through a within-root account-parent symlink", async () => {
    const otherDirectory = path.join(TEST_ROOT, "reports", otherAccountId, reportId);
    const target = path.join(otherDirectory, "report.html");
    const linkedAccount = path.join(TEST_ROOT, "reports", accountId);
    const linkedTarget = path.join(linkedAccount, reportId, "report.html");
    await fs.mkdir(otherDirectory, { recursive: true });
    await fs.writeFile(target, "other-account");
    await fs.symlink(path.join(TEST_ROOT, "reports", otherAccountId), linkedAccount);

    await expect(
      resolveReportArtifact({ accountId, reportId, filePath: linkedTarget, kind: "html" })
    ).resolves.toBeUndefined();
    await removeReportArtifacts({ accountId, reportId, htmlPath: linkedTarget });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("other-account");
  });

  it("refuses report access and deletion through a within-root report-directory symlink", async () => {
    const accountDirectory = path.join(TEST_ROOT, "reports", accountId);
    const otherDirectory = path.join(TEST_ROOT, "reports", otherAccountId, reportId);
    const target = path.join(otherDirectory, "report.html");
    const linkedDirectory = path.join(accountDirectory, reportId);
    const linkedTarget = path.join(linkedDirectory, "report.html");
    await fs.mkdir(accountDirectory, { recursive: true });
    await fs.mkdir(otherDirectory, { recursive: true });
    await fs.writeFile(target, "other-report");
    await fs.symlink(otherDirectory, linkedDirectory);

    await expect(
      resolveReportArtifact({ accountId, reportId, filePath: linkedTarget, kind: "html" })
    ).resolves.toBeUndefined();
    await removeReportArtifacts({ accountId, reportId, htmlPath: linkedTarget });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("other-report");
  });

  it("fails closed for legacy direct-root report paths", async () => {
    const legacyDirectory = path.join(TEST_ROOT, "reports", reportId);
    const target = path.join(legacyDirectory, "report.html");
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(target, "legacy");

    await expect(
      resolveReportArtifact({ accountId, reportId, filePath: target, kind: "html" })
    ).resolves.toBeUndefined();
    await removeReportArtifacts({ accountId, reportId, htmlPath: target });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("legacy");
  });

  it("requires canonical report filenames before deleting an owned report directory", async () => {
    const ownedDirectory = path.join(TEST_ROOT, "reports", accountId, reportId);
    const unexpected = path.join(ownedDirectory, "preview.html");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.writeFile(unexpected, "keep");

    await removeReportArtifacts({ accountId, reportId, htmlPath: unexpected });
    await expect(fs.readFile(unexpected, "utf8")).resolves.toBe("keep");
  });

  it("deletes exact report artifacts without touching a sibling report", async () => {
    const ownedDirectory = path.join(TEST_ROOT, "reports", accountId, reportId);
    const siblingDirectory = path.join(TEST_ROOT, "reports", accountId, "sibling-report");
    await fs.mkdir(ownedDirectory, { recursive: true });
    await fs.mkdir(siblingDirectory, { recursive: true });
    await fs.writeFile(path.join(ownedDirectory, "report.html"), "owned");
    await fs.writeFile(path.join(siblingDirectory, "report.html"), "keep");

    await removeReportArtifacts({
      accountId,
      reportId,
      htmlPath: path.join(ownedDirectory, "report.html"),
    });

    await expect(fs.access(ownedDirectory)).rejects.toThrow();
    await expect(fs.readFile(path.join(siblingDirectory, "report.html"), "utf8")).resolves.toBe("keep");
  });
});
