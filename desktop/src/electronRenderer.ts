import { randomUUID } from "node:crypto";

import { BrowserWindow, session } from "electron";

import type { BackendRenderRequest } from "./contracts.js";
import {
  hasPdfMagic,
  hasPngMagic,
  isAllowedRenderResourceUrl,
} from "./policies.js";

const CHART_VIEWPORT = { width: 1330, height: 728 } as const;
const RENDER_TIMEOUT_MS = 20_000;
const MAX_QUEUED_RENDERS = 8;

export interface ElectronRenderHooks {
  readonly onRequest?: (event: {
    readonly url: string;
    readonly allowed: boolean;
  }) => void;
}

function renderReadyScript(): string {
  return `new Promise((resolve, reject) => {
    const started = Date.now();
    const finish = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    const imagesReady = () => Promise.all(Array.from(document.images).map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((done) => {
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
      });
    }));
    const poll = () => {
      const chartPending = Object.prototype.hasOwnProperty.call(globalThis, '__borealisChartReady') &&
        globalThis.__borealisChartReady !== true;
      if (chartPending) {
        if (Date.now() - started >= 10000) {
          reject(new Error('chart did not become ready'));
          return;
        }
        setTimeout(poll, 16);
        return;
      }
      Promise.resolve(document.fonts ? document.fonts.ready : undefined)
        .then(imagesReady)
        .then(finish);
    };
    poll();
  })`;
}

function injectDocumentScript(html: string): string {
  return `(() => {
    const parsed = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
    document.documentElement.replaceWith(document.importNode(parsed.documentElement, true));
    for (const previous of Array.from(document.scripts)) {
      const script = document.createElement('script');
      for (const attribute of Array.from(previous.attributes)) {
        script.setAttribute(attribute.name, attribute.value);
      }
      script.textContent = previous.textContent;
      previous.replaceWith(script);
    }
    return true;
  })()`;
}

function withTimeout<T>(
  operation: Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("desktop render timed out"));
    }, RENDER_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ElectronRenderService {
  readonly #hooks: ElectronRenderHooks;
  readonly #windows = new Set<BrowserWindow>();
  #closed = false;
  #queued = 0;
  #gate: Promise<void> = Promise.resolve();

  constructor(hooks: ElectronRenderHooks = {}) {
    this.#hooks = hooks;
  }

  render(request: BackendRenderRequest): Promise<Buffer> {
    if (this.#closed)
      return Promise.reject(new Error("desktop renderer is closed"));
    if (this.#queued >= MAX_QUEUED_RENDERS)
      return Promise.reject(new Error("desktop render queue is full"));
    this.#queued += 1;
    const result = this.#gate.then(() => this.#renderOnce(request));
    this.#gate = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#queued -= 1;
    });
  }

  close(): void {
    this.#closed = true;
    for (const window of this.#windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.#windows.clear();
  }

  async #renderOnce(request: BackendRenderRequest): Promise<Buffer> {
    if (this.#closed) throw new Error("desktop renderer is closed");
    const partition = `borealis-render-${randomUUID()}`;
    const isolatedSession = session.fromPartition(partition, { cache: false });
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    isolatedSession.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        const allowed = isAllowedRenderResourceUrl(details.url);
        this.#hooks.onRequest?.({ url: details.url, allowed });
        callback({ cancel: !allowed });
      },
    );

    const window = new BrowserWindow({
      width: CHART_VIEWPORT.width,
      height: CHART_VIEWPORT.height,
      useContentSize: true,
      show: false,
      frame: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        spellcheck: false,
        backgroundThrottling: false,
        navigateOnDragDrop: false,
      },
    });
    this.#windows.add(window);
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedRenderResourceUrl(url)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (!isAllowedRenderResourceUrl(event.url)) event.preventDefault();
    });

    try {
      return await withTimeout(this.#renderDocument(window, request), () => {
        if (!window.isDestroyed()) window.destroy();
      });
    } finally {
      this.#windows.delete(window);
      if (!window.isDestroyed()) window.destroy();
      await isolatedSession.clearStorageData().catch(() => {});
      await isolatedSession.clearCache().catch(() => {});
      isolatedSession.closeAllConnections();
    }
  }

  async #renderDocument(
    window: BrowserWindow,
    request: BackendRenderRequest,
  ): Promise<Buffer> {
    const contents = window.webContents;
    await contents.loadURL("about:blank");
    await contents.executeJavaScript(injectDocumentScript(request.html), true);
    await contents.executeJavaScript(renderReadyScript(), true);
    if (this.#closed || window.isDestroyed())
      throw new Error("desktop renderer is closed");

    if (request.kind === "png") {
      const image = await contents.capturePage({
        x: 0,
        y: 0,
        ...CHART_VIEWPORT,
      });
      const png = image.toPNG();
      if (!hasPngMagic(png)) throw new Error("desktop PNG rendering failed");
      return png;
    }

    const pdf = await contents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margins: {
        top: 12 / 25.4,
        right: 10 / 25.4,
        bottom: 12 / 25.4,
        left: 10 / 25.4,
      },
    });
    if (!hasPdfMagic(pdf)) throw new Error("desktop PDF rendering failed");
    return pdf;
  }
}
