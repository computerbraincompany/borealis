import path from "node:path";

const INHERITED_BACKEND_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "JWT_SECRET",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LM_STUDIO_BASE_URL",
  "LLM_CHAT_MODEL",
  "LLM_EMBED_MODEL",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_CHAT_MODEL",
  "LITELLM_EMBED_MODEL",
  "EMBEDDING_DIM",
  "MAX_UPLOAD_BYTES",
  "MAX_MESSAGE_CHARS",
  "MAX_HISTORY_MESSAGES",
  "MAX_HISTORY_CHARS",
  "MAX_EXTRACTED_CHARS",
  "MAX_INGEST_CHUNKS",
  "OCR_MAX_PAGES",
  "OCR_MAX_RASTER_PIXELS",
  "OCR_PAGE_TIMEOUT_MS",
  "OCR_TOTAL_TIMEOUT_MS",
  "OCR_MAX_OBSERVATIONS",
  "OCR_MAX_PAGE_CHARS",
  "CONTAINED_MAX_DOWNLOAD_BYTES",
] as const);

export interface DesktopPaths {
  readonly userData: string;
  readonly sqlite: string;
  readonly lance: string;
  readonly uploads: string;
  readonly reports: string;
  readonly settings: string;
  readonly jwtSecret: string;
  readonly containedModels: string;
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
    containedModels: path.join(resolvedUserData, "models"),
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
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_BACKEND_ENVIRONMENT_KEYS) {
    const value = inherited[key];
    if (value !== undefined) allowed[key] = value;
  }
  return {
    ...allowed,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    BOREALIS_DATA_DIR: paths.userData,
    SQLITE_PATH: paths.sqlite,
    LANCEDB_DIR: paths.lance,
    UPLOAD_DIR: paths.uploads,
    REPORT_DIR: paths.reports,
    CONTAINED_DIR: paths.containedModels,
    SETTINGS_FILE: paths.settings,
    JWT_SECRET_FILE: paths.jwtSecret,
    STATIC_WEB_DIR: paths.staticWeb,
    RENDER_BACKEND: "electron",
    BOREALIS_DESKTOP: "1",
  };
}
