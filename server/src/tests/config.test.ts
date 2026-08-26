import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseServerPort,
  parseServiceOrigin,
  resolveJwtSecret,
  resolveLlmBaseUrl,
  resolveSettingsFile,
  serviceOriginsEquivalent,
} from "../config.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("desktop-safe process configuration", () => {
  it.each([
    [undefined, 3_000],
    ["0", 0],
    ["3000", 3_000],
    ["65535", 65_535],
  ])("parses PORT %s as %i", (input, expected) => {
    expect(parseServerPort(input)).toBe(expected);
  });

  it.each(["", "-1", "1.5", "65536", "not-a-port"])('rejects invalid PORT "%s"', (input) => {
    expect(() => parseServerPort(input)).toThrow("PORT must be an integer between 0 and 65535");
  });

  it("prefers SETTINGS_FILE, accepts SETTINGS_PATH, and defaults inside storage", () => {
    expect(
      resolveSettingsFile({
        settingsFile: "/tmp/primary-settings.json",
        legacySettingsPath: "/tmp/legacy-settings.json",
        storageDir: "/tmp/borealis-data",
      })
    ).toBe("/tmp/primary-settings.json");
    expect(resolveSettingsFile({ legacySettingsPath: "/tmp/legacy-settings.json", storageDir: "/tmp/data" })).toBe(
      "/tmp/legacy-settings.json"
    );
    expect(resolveSettingsFile({ storageDir: "/tmp/borealis-data" })).toBe("/tmp/borealis-data/settings.json");
  });

  it("does not discover a .env file from the Electron utility working directory", async () => {
    const directory = await temporaryDirectory();
    const secretFile = path.join(directory, "jwt.secret");
    await fs.writeFile(
      path.join(directory, ".env"),
      "JWT_SECRET=stray-user-data-secret-with-more-than-thirty-two-characters\nLLM_BASE_URL=https://stray.example\n",
      "utf8"
    );
    const configUrl = new URL("../config.ts", import.meta.url).href;
    const tsxBin = path.resolve("node_modules", ".bin", "tsx");
    const script = `import(${JSON.stringify(configUrl)}).then(() => process.stdout.write(JSON.stringify({ jwt: process.env.JWT_SECRET ?? null, llm: process.env.LLM_BASE_URL ?? null })));`;
    const { stdout } = await execFileAsync(tsxBin, ["--eval", script], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        BOREALIS_DESKTOP: "1",
        BOREALIS_DATA_DIR: directory,
        JWT_SECRET_FILE: secretFile,
      },
    });

    expect(JSON.parse(stdout)).toEqual({ jwt: null, llm: null });
    expect((await fs.stat(secretFile)).mode & 0o777).toBe(0o600);
  });
});

describe("JWT secret file", () => {
  it("uses a strong explicit environment value without creating a file", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "jwt.secret");
    const environmentSecret = "environment-jwt-secret-with-at-least-32-characters";

    expect(resolveJwtSecret({ envSecret: environmentSecret, filename })).toBe(environmentSecret);
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates one durable 0600 secret and reuses it", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "nested", "jwt.secret");

    const first = resolveJwtSecret({ filename });
    const second = resolveJwtSecret({ filename });

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(filename, "utf8")).trim()).toBe(first);
    expect(await fs.readdir(path.dirname(filename))).toEqual(["jwt.secret"]);
  });

  it("reads an existing newline-terminated secret and repairs broad permissions", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "jwt.secret");
    const secret = "existing-jwt-secret-with-at-least-thirty-two-characters";
    await fs.writeFile(filename, `${secret}\n`, { mode: 0o644 });

    expect(resolveJwtSecret({ filename })).toBe(secret);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  });

  it("rejects explicit weak values even when a valid file exists", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "jwt.secret");
    await fs.writeFile(filename, "valid-file-secret-with-at-least-thirty-two-characters\n", { mode: 0o600 });

    expect(() => resolveJwtSecret({ envSecret: "change-me", filename })).toThrow("JWT_SECRET");
  });

  it("does not follow a symlink or expose its target in an error", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "jwt.secret");
    const target = path.join(directory, "private-target");
    await fs.writeFile(target, "target-secret-with-at-least-thirty-two-characters\n", { mode: 0o600 });
    await fs.symlink(target, filename);

    const error = (() => {
      try {
        resolveJwtSecret({ filename });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: JWT secret file is invalid or unreadable");
    expect(String(error)).not.toContain(target);
    expect(String(error)).not.toContain("target-secret");
  });
});

describe("service origin configuration", () => {
  it.each(["http://localhost:4444", "http://127.0.0.1:8080", "http://127.255.1.2:8080", "http://[::1]:8080"])(
    "allows loopback HTTP origin %s",
    (origin) => expect(parseServiceOrigin(origin, "https://fallback.invalid", "SERVICE_URL")).toBe(origin)
  );

  it("requires HTTPS for remote credential-bearing services", () => {
    expect(() => parseServiceOrigin("http://service.example:8080", "https://fallback.invalid", "SERVICE_URL")).toThrow(
      "must use HTTPS"
    );
    expect(parseServiceOrigin("https://service.example:8443", "https://fallback.invalid", "SERVICE_URL")).toBe(
      "https://service.example:8443"
    );
  });

  it("does not mistake a DNS name beginning with 127 for a loopback address", () => {
    expect(() => parseServiceOrigin("http://127.evil", "https://fallback.invalid", "SERVICE_URL")).toThrow(
      "must use HTTPS"
    );
  });

  it.each(["https://user:secret@service.example", "https://service.example/path", "ftp://service.example"])(
    "rejects unsafe service origin %s",
    (origin) => {
      expect(() => parseServiceOrigin(origin, "https://fallback.invalid", "SERVICE_URL")).toThrow();
    }
  );
});

describe("model endpoint configuration", () => {
  it("defaults directly to LM Studio", () => {
    expect(resolveLlmBaseUrl({})).toBe("http://127.0.0.1:1234");
  });

  it("accepts the legacy name while preferring LLM_BASE_URL when both are present", () => {
    expect(resolveLlmBaseUrl({ legacyBaseUrl: "http://localhost:1234" })).toBe("http://localhost:1234");
    expect(
      resolveLlmBaseUrl({
        llmBaseUrl: "https://models.example",
        legacyBaseUrl: "http://localhost:1234",
      })
    ).toBe("https://models.example");
  });

  it("names the selected variable in safe validation errors", () => {
    expect(() => resolveLlmBaseUrl({ llmBaseUrl: "http://models.example" })).toThrow("LLM_BASE_URL");
    expect(() => resolveLlmBaseUrl({ legacyBaseUrl: "http://models.example" })).toThrow("LITELLM_BASE_URL");
  });
});

describe("service origin equivalence", () => {
  it.each([
    ["http://localhost:1234", "http://127.0.0.1:1234"],
    ["http://borealis.localhost:1234", "http://[::1]:1234"],
    ["https://models.example", "https://models.example"],
  ])("treats %s and %s as the same endpoint", (left, right) => {
    expect(serviceOriginsEquivalent(left, right)).toBe(true);
  });

  it.each([
    ["http://localhost:1234", "http://127.0.0.1:1235"],
    ["http://localhost:1234", "https://localhost:1234"],
    ["https://models-a.example", "https://models-b.example"],
  ])("does not merge distinct endpoints %s and %s", (left, right) => {
    expect(serviceOriginsEquivalent(left, right)).toBe(false);
  });
});
