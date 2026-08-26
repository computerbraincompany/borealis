import path from "node:path";

export interface DesktopPaths {
  readonly userData: string;
  readonly sqlite: string;
  readonly lance: string;
  readonly uploads: string;
  readonly reports: string;
  readonly settings: string;
  readonly jwtSecret: string;
  readonly staticWeb: string;
  readonly backendEntry: string;
}

export function defaultUserDataDirectory(applicationData: string): string {
  return path.join(path.resolve(applicationData), "Borealis");
}

export function validateUserDataOverride(value: string): string {
  if (!path.isAbsolute(value))
    throw new Error("--user-data-dir must be an absolute path");
  return path.resolve(value);
}

export function resolveDesktopPaths(
  userData: string,
  applicationPath: string,
): DesktopPaths {
  const resolvedUserData = path.resolve(userData);
  const runtime = path.join(path.resolve(applicationPath), "runtime");
  return {
    userData: resolvedUserData,
    sqlite: path.join(resolvedUserData, "borealis.sqlite"),
    lance: path.join(resolvedUserData, "lancedb"),
    uploads: path.join(resolvedUserData, "uploads"),
    reports: path.join(resolvedUserData, "reports"),
    settings: path.join(resolvedUserData, "settings.json"),
    jwtSecret: path.join(resolvedUserData, "jwt.secret"),
    staticWeb: path.join(runtime, "web"),
    backendEntry: path.join(runtime, "server", "dist", "desktopHost.js"),
  };
}

export function backendEnvironment(
  paths: DesktopPaths,
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    HOST: "127.0.0.1",
    PORT: "0",
    BOREALIS_DATA_DIR: paths.userData,
    SQLITE_PATH: paths.sqlite,
    LANCEDB_DIR: paths.lance,
    UPLOAD_DIR: paths.uploads,
    REPORT_DIR: paths.reports,
    SETTINGS_FILE: paths.settings,
    JWT_SECRET_FILE: paths.jwtSecret,
    STATIC_WEB_DIR: paths.staticWeb,
    RENDER_BACKEND: "electron",
    BOREALIS_DESKTOP: "1",
  };
}
