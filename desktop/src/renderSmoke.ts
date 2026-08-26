import { createServer } from "node:http";
import { writeSync } from "node:fs";

import { app, BrowserWindow } from "electron";

import type { BackendRenderRequest } from "./contracts.js";
import { ElectronRenderService } from "./electronRenderer.js";
import { hasPdfMagic, hasPngMagic } from "./policies.js";

writeSync(1, "Electron hidden-renderer smoke starting.\n");

const INLINE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function main(): Promise<void> {
  writeSync(1, "Electron hidden-renderer smoke app ready.\n");
  let networkHits = 0;
  const server = createServer((_request, response) => {
    networkHits += 1;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(Buffer.from(INLINE_PNG, "base64"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("render smoke server did not bind");
  const requests: Array<{ url: string; allowed: boolean }> = [];
  const renderer = new ElectronRenderService({
    onRequest: (event) => requests.push(event),
  });
  const html = `<!doctype html><html><body style="margin:0;background:#fff">
    <h1>Offline Borealis render</h1>
    <img src="data:image/png;base64,${INLINE_PNG}">
    <img src="http://127.0.0.1:${address.port}/tracker.png">
    <img src="file:///etc/hosts">
  </body></html>`;
  const pngRequest: BackendRenderRequest = {
    type: "render-request",
    request_id: "smoke_png",
    kind: "png",
    html,
  };
  const pdfRequest: BackendRenderRequest = {
    type: "render-request",
    request_id: "smoke_pdf",
    kind: "pdf",
    html,
  };

  try {
    writeSync(1, "Electron hidden-renderer PNG render starting.\n");
    const png = await renderer.render(pngRequest);
    writeSync(1, "Electron hidden-renderer PDF render starting.\n");
    const pdf = await renderer.render(pdfRequest);
    const unsafeRequests = requests.filter((request) =>
      /^(?:https?|file|wss?):/i.test(request.url),
    );
    if (!hasPngMagic(png) || !hasPdfMagic(pdf))
      throw new Error("render magic validation failed");
    if (networkHits !== 0)
      throw new Error("hidden renderer reached the network");
    if (unsafeRequests.some((request) => request.allowed))
      throw new Error("hidden renderer allowed an unsafe request");
    writeSync(
      1,
      `${JSON.stringify({ ok: true, png_bytes: png.length, pdf_bytes: pdf.length, network_hits: networkHits, blocked_unsafe_requests: unsafeRequests.length })}\n`,
    );
  } finally {
    renderer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

app.once("ready", () => {
  const keeper = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void main()
    .then(() => {
      keeper.destroy();
      app.exit(0);
    })
    .catch(() => {
      keeper.destroy();
      writeSync(2, "Electron hidden-renderer smoke failed.\n");
      app.exit(1);
    });
});
