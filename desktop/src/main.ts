import { chmod, mkdir, stat } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from "electron";

import {
  asTransferableBytes,
  parseBackendMessage,
  rejectedRenderRequestId,
  type BackendRenderRequest,
  type BootstrapSession,
  type MainMessage,
} from "./contracts.js";
import { ElectronRenderService } from "./electronRenderer.js";
import {
  appOrigin,
  isAllowedPreviewWindowUrl,
  isTrustedAppUrl,
} from "./policies.js";
import {
  backendEnvironment,
  defaultUserDataDirectory,
  resolveDesktopPaths,
  validateUserDataOverride,
  type DesktopPaths,
} from "./runtime.js";

const BACKEND_READY_TIMEOUT_MS = 30_000;
const BACKEND_SHUTDOWN_TIMEOUT_MS = 8_000;
const PACKAGED_NATIVE_SMOKE_SWITCH = "borealis-packaged-native-smoke";
const UTILITY_NATIVE_SMOKE_ARGUMENT =
  "--borealis-packaged-native-smoke-utility";
const PACKAGED_NATIVE_SMOKE_TIMEOUT_MS = 30_000;
const PACKAGED_NATIVE_SMOKE_SUCCESS = "BOREALIS_PACKAGED_NATIVE_SMOKE_OK";
const packagedNativeSmoke =
  app.isPackaged && app.commandLine.hasSwitch(PACKAGED_NATIVE_SMOKE_SWITCH);

if (packagedNativeSmoke) process.noDeprecation = true;

class BootstrapVault {
  #encrypted: Buffer | undefined;

  store(value: BootstrapSession): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("secure bootstrap storage is unavailable");
    this.clear();
    this.#encrypted = safeStorage.encryptString(JSON.stringify(value));
  }

  consume(): BootstrapSession | null {
    const encrypted = this.#encrypted;
    if (!encrypted) return null;
    this.#encrypted = undefined;
    try {
      return JSON.parse(
        safeStorage.decryptString(encrypted),
      ) as BootstrapSession;
    } finally {
      encrypted.fill(0);
    }
  }

  clear(): void {
    this.#encrypted?.fill(0);
    this.#encrypted = undefined;
  }
}

async function runPackagedNativeSmoke(paths: DesktopPaths): Promise<void> {
  if (inspectorUrl())
    throw new Error("the Electron inspector must be disabled");
  await mkdir(paths.userData, { recursive: true, mode: 0o700 });
  await chmod(paths.userData, 0o700);
  const backendEntry = await stat(paths.backendEntry);
  if (!backendEntry.isFile()) throw new Error("desktop runtime is incomplete");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const backend = utilityProcess.fork(
      paths.backendEntry,
      [UTILITY_NATIVE_SMOKE_ARGUMENT],
      {
        cwd: paths.userData,
        env: backendEnvironment(paths),
        stdio: "ignore",
        serviceName: "Borealis Packaged Native Smoke",
      },
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      backend.kill();
      reject(new Error("packaged native smoke timed out"));
    }, PACKAGED_NATIVE_SMOKE_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    backend.on("message", (rawMessage: unknown) => {
      const message = parseBackendMessage(rawMessage);
      if (message?.type === "native-smoke") {
        backend.kill();
        finish();
        return;
      }
      backend.kill();
      finish(new Error("packaged native smoke returned an invalid result"));
    });
    backend.on("error", () => {
      backend.kill();
      finish(new Error("packaged native smoke utility failed"));
    });
    backend.on("exit", (code) => {
      finish(
        new Error(
          `packaged native smoke utility exited before verification (${code})`,
        ),
      );
    });
  });
}

class DesktopApplication {
  readonly #paths: DesktopPaths;
  readonly #vault = new BootstrapVault();
  readonly #renderer = new ElectronRenderService();
  #backend: UtilityProcess | undefined;
  #window: BrowserWindow | undefined;
  #origin: string | undefined;
  #backendStopped = false;
  #readySettled = false;
  #shutdownPromise: Promise<void> | undefined;
  #resolveBackendStopped: (() => void) | undefined;
  readonly #backendStoppedPromise = new Promise<void>((resolve) => {
    this.#resolveBackendStopped = resolve;
  });

  constructor(paths: DesktopPaths) {
    this.#paths = paths;
  }

  async start(): Promise<void> {
    await this.#assertRuntime();
    this.#installBootstrapHandler();
    const ready = await this.#startBackend();
    this.#origin = appOrigin(ready.port);
    this.#vault.store(ready.bootstrap);
    this.#configureApplicationSession();
    this.#createWindow();
  }

  focus(): void {
    if (!this.#window || this.#window.isDestroyed()) return;
    if (this.#window.isMinimized()) this.#window.restore();
    this.#window.show();
    this.#window.focus();
  }

  isShuttingDown(): boolean {
    return this.#shutdownPromise !== undefined;
  }

  shutdown(): Promise<void> {
    this.#shutdownPromise ??= Promise.resolve().then(() =>
      this.#performShutdown(),
    );
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    this.#vault.clear();
    ipcMain.removeHandler("borealis:consume-bootstrap");
    this.#renderer.close();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();

    if (!this.#backend || this.#backendStopped) {
      this.#markBackendStopped();
      return;
    }
    this.#postToBackend({ type: "shutdown" });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!this.#backendStopped) this.#backend?.kill();
        resolve();
      }, BACKEND_SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([this.#backendStoppedPromise, timeout]);
  }

  async #assertRuntime(): Promise<void> {
    const [backend, web] = await Promise.all([
      stat(this.#paths.backendEntry),
      stat(this.#paths.staticWeb),
    ]);
    if (!backend.isFile() || !web.isDirectory())
      throw new Error("desktop runtime is incomplete");
  }

  #installBootstrapHandler(): void {
    ipcMain.handle(
      "borealis:consume-bootstrap",
      (event: IpcMainInvokeEvent): BootstrapSession | null => {
        if (!this.#origin || !this.#window || this.#window.isDestroyed())
          return null;
        if (event.sender !== this.#window.webContents) return null;
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedAppUrl(senderUrl, this.#origin))
          return null;
        return this.#vault.consume();
      },
    );
  }

  #startBackend(): Promise<
    Extract<ReturnType<typeof parseBackendMessage>, { type: "ready" }>
  > {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#readySettled) return;
        this.#readySettled = true;
        this.#backend?.kill();
        reject(new Error("backend startup timed out"));
      }, BACKEND_READY_TIMEOUT_MS);

      const backend = utilityProcess.fork(this.#paths.backendEntry, [], {
        // The backend owns workspace creation after acquiring its exact lock;
        // an existing OS directory avoids touching userData in a lock race.
        cwd: app.getPath("temp"),
        env: backendEnvironment(this.#paths),
        stdio: "inherit",
        serviceName: "Borealis Backend",
      });
      this.#backend = backend;
      backend.on("message", (rawMessage: unknown) => {
        const message = parseBackendMessage(rawMessage);
        if (!message) {
          const requestId = rejectedRenderRequestId(rawMessage);
          if (requestId) {
            this.#postToBackend({
              type: "render-response",
              request_id: requestId,
              ok: false,
            });
          }
          return;
        }
        if (message.type === "ready") {
          if (this.#readySettled) return;
          this.#readySettled = true;
          clearTimeout(timeout);
          resolve(message);
          return;
        }
        if (message.type === "render-request") {
          void this.#handleRender(message);
          return;
        }
        if (message.type === "stopped") {
          this.#markBackendStopped();
          if (!this.#shutdownPromise)
            this.#handleBackendFatal("BACKEND_STOPPED");
          return;
        }
        if (!this.#readySettled) {
          this.#readySettled = true;
          clearTimeout(timeout);
          reject(new Error("backend startup failed"));
        } else {
          this.#handleBackendFatal(
            message.type === "fatal"
              ? message.error_code
              : "BACKEND_PROTOCOL_ERROR",
          );
        }
      });
      backend.on("error", () => {
        if (!this.#readySettled) {
          this.#readySettled = true;
          clearTimeout(timeout);
          reject(new Error("backend process failed"));
        }
      });
      backend.on("exit", (code) => {
        this.#markBackendStopped();
        if (!this.#readySettled) {
          this.#readySettled = true;
          clearTimeout(timeout);
          reject(new Error(`backend exited before startup (${code})`));
        } else if (!this.#shutdownPromise) {
          this.#handleBackendFatal("BACKEND_EXITED");
        }
      });
    });
  }

  async #handleRender(request: BackendRenderRequest): Promise<void> {
    try {
      const data = await this.#renderer.render(request);
      this.#postToBackend({
        type: "render-response",
        request_id: request.request_id,
        ok: true,
        data: asTransferableBytes(data),
      });
    } catch {
      this.#postToBackend({
        type: "render-response",
        request_id: request.request_id,
        ok: false,
      });
    }
  }

  #postToBackend(message: MainMessage): void {
    if (this.#backendStopped || !this.#backend?.pid) return;
    this.#backend.postMessage(message);
  }

  #markBackendStopped(): void {
    if (this.#backendStopped) return;
    this.#backendStopped = true;
    this.#resolveBackendStopped?.();
    this.#resolveBackendStopped = undefined;
  }

  #handleBackendFatal(errorCode?: string): void {
    if (this.#shutdownPromise) return;
    const suffix = errorCode ? ` (${errorCode})` : "";
    dialog.showErrorBox(
      "Borealis backend stopped",
      `The local Borealis service could not continue${suffix}.`,
    );
    void this.shutdown().finally(() => app.exit(1));
  }

  #configureApplicationSession(): void {
    const applicationSession = session.fromPartition("persist:borealis-app");
    applicationSession.setPermissionCheckHandler(() => false);
    applicationSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
  }

  #createWindow(): void {
    if (!this.#origin) throw new Error("backend origin is unavailable");
    const preload = path.join(app.getAppPath(), "dist", "preload.cjs");
    const previewPreload = path.join(
      app.getAppPath(),
      "dist",
      "previewPreload.cjs",
    );
    const window = new BrowserWindow({
      title: "Borealis",
      width: 1440,
      height: 960,
      minWidth: 960,
      minHeight: 640,
      show: false,
      backgroundColor: "#0b0d10",
      webPreferences: {
        partition: "persist:borealis-app",
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    this.#window = window;
    const contents = window.webContents;
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      if (!this.#origin || !isTrustedAppUrl(url, this.#origin))
        event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
      if (!isAllowedPreviewWindowUrl(details.url)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: true,
          width: 1100,
          height: 800,
          webPreferences: {
            partition: "persist:borealis-app",
            preload: previewPreload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            navigateOnDragDrop: false,
          },
        },
      };
    });
    contents.on("did-create-window", (child) => {
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      child.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      child.webContents.on("will-navigate", (event, url) => {
        if (!isAllowedPreviewWindowUrl(url)) event.preventDefault();
      });
    });
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (this.#window === window) this.#window = undefined;
    });
    void window
      .loadURL(`${this.#origin}/`)
      .catch(() => this.#handleBackendFatal("UI_LOAD_FAILED"));
  }
}

app.setName("Borealis");
const explicitUserData = app.commandLine.getSwitchValue("user-data-dir");
if (explicitUserData) {
  const expectedUserData = validateUserDataOverride(explicitUserData);
  if (path.resolve(app.getPath("userData")) !== expectedUserData)
    app.setPath("userData", expectedUserData);
} else {
  app.setPath("userData", defaultUserDataDirectory(app.getPath("appData")));
}

let desktop: DesktopApplication | undefined;
let quitInProgress = false;

if (packagedNativeSmoke) {
  void app.whenReady().then(async () => {
    try {
      const paths = resolveDesktopPaths(
        app.getPath("userData"),
        app.getAppPath(),
      );
      await runPackagedNativeSmoke(paths);
      process.stdout.write(`${PACKAGED_NATIVE_SMOKE_SUCCESS}\n`);
      app.exit(0);
    } catch {
      process.stderr.write("BOREALIS_PACKAGED_NATIVE_SMOKE_FAILED\n");
      app.exit(1);
    }
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => desktop?.focus());
  app.on("activate", () => desktop?.focus());
  app.on("window-all-closed", () => {
    if (!desktop?.isShuttingDown()) app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitInProgress) return;
    event.preventDefault();
    quitInProgress = true;
    const shutdown = desktop ? desktop.shutdown() : Promise.resolve();
    void shutdown.catch(() => {}).finally(() => app.exit(0));
  });

  void app.whenReady().then(async () => {
    const paths = resolveDesktopPaths(
      app.getPath("userData"),
      app.getAppPath(),
    );
    desktop = new DesktopApplication(paths);
    try {
      await desktop.start();
    } catch {
      dialog.showErrorBox(
        "Borealis could not start",
        "The local Borealis service could not be started.",
      );
      await desktop.shutdown().catch(() => {});
      app.exit(1);
    }
  });
}
