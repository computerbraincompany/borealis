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

test("pins the backend to loopback and overrides every runtime path", () => {
  const paths = resolveDesktopPaths("/tmp/borealis", "/tmp/app");
  const environment = backendEnvironment(paths, {
    EXISTING_SAFE_VALUE: "kept",
    HOST: "0.0.0.0",
    PORT: "3000",
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
      inherited: environment.EXISTING_SAFE_VALUE,
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
      inherited: "kept",
    },
  );
});
