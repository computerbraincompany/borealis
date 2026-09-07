import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, opendir, realpath, stat } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from "electron";

import {
  asTransferableBytes,
  buildFolderGrantMessage,
  FOLDER_PICKER_CANCELLED,
  MAX_FOLDER_PREVIEW_ENTRIES,
  narrowFolderPickerResult,
  parseBackendMessage,
  parseOpenExternalRequest,
  rejectedRenderRequestId,
  type BackendRenderRequest,
  type BootstrapSession,
  type FolderPickerResult,
  type MainMessage,
} from "./contracts.js";
import { ConnectionKeyVault } from "./custody.js";
import { ElectronRenderService } from "./electronRenderer.js";
import {
  appOrigin,
  isAllowedPreviewWindowUrl,
  isExternalOpenUrl,
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
const OPEN_VERIFY_TIMEOUT_MS = 3_000;
const PACKAGED_NATIVE_SMOKE_SWITCH = "borealis-packaged-native-smoke";
const UTILITY_NATIVE_SMOKE_ARGUMENT =
  "--borealis-packaged-native-smoke-utility";
const PACKAGED_NATIVE_SMOKE_TIMEOUT_MS = 30_000;
const PACKAGED_NATIVE_SMOKE_SUCCESS = "BOREALIS_PACKAGED_NATIVE_SMOKE_OK";
const packagedNativeSmoke =
  app.isPackaged && app.commandLine.hasSwitch(PACKAGED_NATIVE_SMOKE_SWITCH);
// Packaged quit-contract smoke (headless desktop lifecycle gate). macOS gives
// no headless channel into the NSApplication quit flow (signals are swallowed
// by Chromium; unattended Apple Events need Automation consent), so the
// packaged build accepts an explicit smoke switch that drives the very same
// app.quit() → before-quit → DesktopApplication.shutdown() chain a user quit
// takes and reports whether the backend acknowledged an orderly stop.
const PACKAGED_SHUTDOWN_SMOKE_SWITCH = "borealis-packaged-shutdown-smoke";
const PACKAGED_SHUTDOWN_SMOKE_SUCCESS = "BOREALIS_PACKAGED_SHUTDOWN_SMOKE_OK";
const PACKAGED_SHUTDOWN_SMOKE_FAILED =
  "BOREALIS_PACKAGED_SHUTDOWN_SMOKE_FAILED";
const PACKAGED_SHUTDOWN_SMOKE_TIMEOUT_MS = 120_000;
const packagedShutdownSmoke =
  app.isPackaged && app.commandLine.hasSwitch(PACKAGED_SHUTDOWN_SMOKE_SWITCH);

if (packagedNativeSmoke || packagedShutdownSmoke) process.noDeprecation = true;

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

interface PendingOpenVerification {
  readonly token: string;
  readonly resolve: (ok: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class DesktopApplication {
  readonly #paths: DesktopPaths;
  readonly #vault = new BootstrapVault();
  readonly #custody: ConnectionKeyVault;
  readonly #renderer = new ElectronRenderService();
  readonly #pendingOpenVerifications = new Map<
    string,
    PendingOpenVerification
  >();
  readonly #openVerificationsInFlight = new Set<string>();
  #backend: UtilityProcess | undefined;
  #window: BrowserWindow | undefined;
  #origin: string | undefined;
  #backendStopped = false;
  #backendStoppedGracefully = false;
  #readySettled = false;
  #shutdownPromise: Promise<void> | undefined;
  #resolveBackendStopped: (() => void) | undefined;
  readonly #backendStoppedPromise = new Promise<void>((resolve) => {
    this.#resolveBackendStopped = resolve;
  });

  constructor(paths: DesktopPaths) {
    this.#paths = paths;
    // The key file lives beside the workspace data but outside the archived
    // record paths: custody keys are machine-bound and never portable.
    this.#custody = new ConnectionKeyVault(safeStorage, paths.connectionKey);
  }

  async start(): Promise<void> {
    await this.#assertRuntime();
    this.#installBootstrapHandler();
    this.#installFolderChooserHandler();
    this.#installOpenExternalHandler();
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
    this.#custody.clear();
    for (const pending of this.#pendingOpenVerifications.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.#pendingOpenVerifications.clear();
    this.#openVerificationsInFlight.clear();
    ipcMain.removeHandler("borealis:consume-bootstrap");
    ipcMain.removeHandler("borealis:choose-folder");
    ipcMain.removeHandler("borealis:open-external");
    this.#renderer.close();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();

    if (!this.#backend || this.#backendStopped) {
      this.#markBackendStopped();
      return;
    }
    this.#postToBackend({ type: "shutdown" });
    const graceful = this.#backendStoppedPromise.then(
      () => "graceful" as const,
    );
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        if (!this.#backendStopped) this.#backend?.kill();
        resolve("timeout");
      }, BACKEND_SHUTDOWN_TIMEOUT_MS);
    });
    this.#backendStoppedGracefully =
      (await Promise.race([graceful, timeout])) === "graceful";
  }

  /** True only when the last shutdown's backend stopped by its own ack. */
  get backendStoppedGracefully(): boolean {
    return this.#backendStoppedGracefully;
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

  /**
   * Native folder chooser (M14 narrow preload addition). The same trust
   * boundary as bootstrap applies — application window only, exact trusted
   * origin, and the window's main frame (never a subframe). On a real
   * selection, main resolves the canonical directory, mints a one-time
   * opaque grant, and forwards `{grant_id, root_path, label}` only to the
   * backend over the private utility-process channel; the renderer receives
   * only the opaque grant id, label, and bounded preview metadata.
   * Cancellation creates no grant and no message.
   */
  #installFolderChooserHandler(): void {
    ipcMain.handle(
      "borealis:choose-folder",
      async (event: IpcMainInvokeEvent): Promise<FolderPickerResult> => {
        const window = this.#window;
        if (!this.#origin || !window || window.isDestroyed())
          return FOLDER_PICKER_CANCELLED;
        if (event.sender !== window.webContents) return FOLDER_PICKER_CANCELLED;
        const frame = event.senderFrame;
        if (!frame || frame !== window.webContents.mainFrame)
          return FOLDER_PICKER_CANCELLED;
        if (!isTrustedAppUrl(frame.url, this.#origin))
          return FOLDER_PICKER_CANCELLED;
        if (this.#backendStopped || !this.#backend?.pid)
          return FOLDER_PICKER_CANCELLED;
        const choice = await dialog.showOpenDialog(window, {
          title: "Choose a folder for Borealis",
          buttonLabel: "Choose folder",
          properties: ["openDirectory"],
        });
        const selected = choice.canceled ? undefined : choice.filePaths[0];
        if (typeof selected !== "string" || selected.length < 1)
          return FOLDER_PICKER_CANCELLED;
        let canonical: string;
        try {
          canonical = await realpath(selected);
          const info = await stat(canonical);
          if (!info.isDirectory()) return FOLDER_PICKER_CANCELLED;
        } catch {
          return FOLDER_PICKER_CANCELLED;
        }
        const label =
          Array.from(path.basename(canonical)).slice(0, 120).join("") ||
          "Selected folder";
        const grantId = randomBytes(32).toString("hex");
        let handoff: MainMessage;
        try {
          handoff = buildFolderGrantMessage({
            grantId,
            rootPath: canonical,
            label,
          });
        } catch {
          return FOLDER_PICKER_CANCELLED;
        }
        this.#postToBackend(handoff);
        const preview = await this.#previewFolder(canonical);
        return narrowFolderPickerResult({
          grantId,
          label,
          entries: preview.count,
          truncated: preview.truncated,
        });
      },
    );
  }

  /**
   * The single system-browser open action (Connected agents stage 5). The
   * renderer can only request an open by presenting a one-time intent token
   * that the BACKEND minted for an exact sign-in URL; main verifies-and-
   * consumes that token with the backend over the authenticated utility
   * message pair before `shell.openExternal` ever runs, so a compromised
   * renderer cannot name an arbitrary URL. Nothing else is exposed here.
   */
  #installOpenExternalHandler(): void {
    ipcMain.handle(
      "borealis:open-external",
      async (
        event: IpcMainInvokeEvent,
        rawRequest: unknown,
      ): Promise<boolean> => {
        if (!this.#origin || !this.#window || this.#window.isDestroyed())
          return false;
        if (event.sender !== this.#window.webContents) return false;
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedAppUrl(senderUrl, this.#origin))
          return false;
        const request = parseOpenExternalRequest(rawRequest);
        if (!request || !isExternalOpenUrl(request.url)) return false;
        if (this.#backendStopped || !this.#backend?.pid) return false;
        // A renderer cannot stack up parallel verifies for the same token.
        if (this.#openVerificationsInFlight.has(request.token)) return false;
        this.#openVerificationsInFlight.add(request.token);
        try {
          const requestId = randomUUID();
          const verified = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              this.#settleOpenVerification(requestId, false);
            }, OPEN_VERIFY_TIMEOUT_MS);
            this.#pendingOpenVerifications.set(requestId, {
              token: request.token,
              resolve,
              timer,
            });
            this.#postToBackend({
              type: "open-verify-request",
              request_id: requestId,
              token: request.token,
              url: request.url,
            });
          });
          if (!verified) return false;
          await shell.openExternal(request.url);
          return true;
        } catch {
          return false;
        } finally {
          this.#openVerificationsInFlight.delete(request.token);
        }
      },
    );
  }

  /** Bounded top-level entry count for the picker preview (never content). */
  async #previewFolder(
    directory: string,
  ): Promise<{ count: number; truncated: boolean }> {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(directory);
      let count = 0;
      let truncated = false;
      for await (const _entry of handle) {
        count += 1;
        if (count > MAX_FOLDER_PREVIEW_ENTRIES) {
          truncated = true;
          break;
        }
      }
      return {
        count: Math.min(count, MAX_FOLDER_PREVIEW_ENTRIES),
        truncated,
      };
    } catch {
      return { count: 0, truncated: false };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  #settleOpenVerification(requestId: string, ok: boolean): void {
    const pending = this.#pendingOpenVerifications.get(requestId);
    if (!pending) return;
    this.#pendingOpenVerifications.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(ok);
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
        if (message.type === "custody-request") {
          void this.#custody
            .handle(message)
            .then((response) => this.#postToBackend(response))
            .catch(() => {
              this.#postToBackend({
                type: "custody-response",
                request_id: message.request_id,
                ok: false,
                reason: "custody",
              });
            });
          return;
        }
        if (message.type === "open-verify-response") {
          this.#settleOpenVerification(message.request_id, message.ok);
          return;
        }
        if (message.type === "stopped") {
          this.#markBackendStopped();
          for (const pending of this.#pendingOpenVerifications.values()) {
            clearTimeout(pending.timer);
            pending.resolve(false);
          }
          this.#pendingOpenVerifications.clear();
          this.#openVerificationsInFlight.clear();
          this.#custody.clear();
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
    for (const pending of this.#pendingOpenVerifications.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.#pendingOpenVerifications.clear();
    this.#openVerificationsInFlight.clear();
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
} else if (packagedShutdownSmoke) {
  const smokeT0 = Date.now();
  const elapsed = () => ` elapsed=${Date.now() - smokeT0}ms`;
  // Bounded, content-free failure discriminators (never raw errors).
  const failSmoke = (reason: "START_FAILED" | "DEADLINE" | "NOT_GRACEFUL") => {
    process.stderr.write(
      `${PACKAGED_SHUTDOWN_SMOKE_FAILED}:${reason}${elapsed()}\n`,
    );
    app.exit(1);
  };
  app.on("before-quit", (event) => {
    if (quitInProgress) return;
    event.preventDefault();
    quitInProgress = true;
    process.stdout.write(`BOREALIS_PACKAGED_SHUTDOWN_SMOKE_QUIT${elapsed()}\n`);
    const application = desktop;
    const shutdown = application ? application.shutdown() : Promise.resolve();
    void shutdown
      .catch(() => {})
      .then(() => {
        process.stdout.write(
          `BOREALIS_PACKAGED_SHUTDOWN_SMOKE_STOPPED${elapsed()}\n`,
        );
        if (application?.backendStoppedGracefully) {
          process.stdout.write(
            `${PACKAGED_SHUTDOWN_SMOKE_SUCCESS}${elapsed()}\n`,
          );
          app.exit(0);
          return;
        }
        failSmoke("NOT_GRACEFUL");
      });
  });
  const deadline = setTimeout(() => {
    failSmoke("DEADLINE");
  }, PACKAGED_SHUTDOWN_SMOKE_TIMEOUT_MS);
  deadline.unref();
  void app.whenReady().then(async () => {
    process.stdout.write(
      `BOREALIS_PACKAGED_SHUTDOWN_SMOKE_READY${elapsed()}\n`,
    );
    const paths = resolveDesktopPaths(
      app.getPath("userData"),
      app.getAppPath(),
    );
    const application = new DesktopApplication(paths);
    desktop = application;
    try {
      await application.start();
    } catch {
      await application.shutdown().catch(() => {});
      failSmoke("START_FAILED");
      return;
    }
    process.stdout.write(
      `BOREALIS_PACKAGED_SHUTDOWN_SMOKE_STARTED${elapsed()}\n`,
    );
    // Identical trigger to a user Cmd+Q: the real quit-event plumbing.
    app.quit();
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
