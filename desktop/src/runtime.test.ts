import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  backendEnvironment,
  defaultUserDataDirectory,
  resolveDesktopPaths,
  validateUserDataOverride,
} from "./runtime.js";

test("uses the normal Borealis support directory unless an absolute CLI override is supplied", () => {
  assert.equal(
    defaultUserDataDirectory("/Users/example/Library/Application Support"),
    "/Users/example/Library/Application Support/Borealis",
  );
  assert.equal(
    validateUserDataOverride("/tmp/borealis-e2e"),
    "/tmp/borealis-e2e",
  );
  assert.throws(() => validateUserDataOverride("relative/e2e"));
});

test("resolves every durable path beneath the exact userData directory", () => {
  const userData = path.resolve("/tmp/Borealis user data");
  const application = path.resolve(
    "/Applications/Borealis.app/Contents/Resources/app.asar",
  );
  const paths = resolveDesktopPaths(userData, application);
  assert.deepEqual(paths, {
    userData,
    sqlite: path.join(userData, "borealis.sqlite"),
    lance: path.join(userData, "lancedb"),
    uploads: path.join(userData, "uploads"),
    reports: path.join(userData, "reports"),
    containedModels: path.join(userData, "models"),
    settings: path.join(userData, "settings.json"),
    jwtSecret: path.join(userData, "jwt.secret"),
    staticWeb: path.join(application, "runtime", "web"),
    backendEntry: path.join(
      application,
      "runtime",
      "server",
      "dist",
      "desktopHost.js",
    ),
  });
});

test("pins runtime paths and allowlists inherited backend configuration", () => {
  const paths = resolveDesktopPaths("/tmp/borealis", "/tmp/app");
  const environment = backendEnvironment(paths, {
    PATH: "/safe/bin",
    LLM_BASE_URL: "https://models.example.test",
    LLM_API_KEY: "configured-key",
    MAX_UPLOAD_BYTES: "1024",
    OCR_MAX_PAGES: "8",
    HOST: "0.0.0.0",
    PORT: "3000",
    NODE_OPTIONS: "--require=/unsafe/injection.cjs",
    NODE_EXTRA_CA_CERTS: "/unsafe/extra-ca.pem",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    DYLD_INSERT_LIBRARIES: "/unsafe/injection.dylib",
    DYLD_LIBRARY_PATH: "/unsafe/libraries",
    UNRECOGNIZED_VALUE: "discarded",
  });
  assert.deepEqual(
    {
      host: environment.HOST,
      port: environment.PORT,
      storageRoot: environment.BOREALIS_DATA_DIR,
      sqlite: environment.SQLITE_PATH,
      lance: environment.LANCEDB_DIR,
      uploads: environment.UPLOAD_DIR,
      reports: environment.REPORT_DIR,
      settings: environment.SETTINGS_FILE,
      jwtSecret: environment.JWT_SECRET_FILE,
      staticWeb: environment.STATIC_WEB_DIR,
      renderBackend: environment.RENDER_BACKEND,
      desktop: environment.BOREALIS_DESKTOP,
      nodeEnvironment: environment.NODE_ENV,
      path: environment.PATH,
      provider: environment.LLM_BASE_URL,
      providerKey: environment.LLM_API_KEY,
      uploadBudget: environment.MAX_UPLOAD_BYTES,
      ocrPages: environment.OCR_MAX_PAGES,
    },
    {
      host: "127.0.0.1",
      port: "0",
      storageRoot: paths.userData,
      sqlite: paths.sqlite,
      lance: paths.lance,
      uploads: paths.uploads,
      reports: paths.reports,
      settings: paths.settings,
      jwtSecret: paths.jwtSecret,
      staticWeb: paths.staticWeb,
      renderBackend: "electron",
      desktop: "1",
      nodeEnvironment: "production",
      path: "/safe/bin",
      provider: "https://models.example.test",
      providerKey: "configured-key",
      uploadBudget: "1024",
      ocrPages: "8",
    },
  );
  for (const key of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_ENABLE_LOGGING",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "UNRECOGNIZED_VALUE",
  ]) {
    assert.equal(environment[key], undefined);
  }
});
