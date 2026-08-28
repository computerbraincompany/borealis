const { app, utilityProcess } = require("electron");
const path = require("node:path");

if (process.env.ELECTRON_RUN_AS_NODE === "1") {
  process.stderr.write(
    "utility native smoke must run as Electron, not ELECTRON_RUN_AS_NODE\n",
  );
  process.exit(1);
}

const childPath = path.join(__dirname, "utility-native-smoke-child.cjs");

app.whenReady().then(() => {
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    process.stderr.write("Electron utility native smoke timed out.\n");
    app.exit(1);
  }, 30_000);

  const child = utilityProcess.fork(childPath, [], {
    serviceName: "Borealis native utility smoke",
  });
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    app.exit(code);
  };
  child.on("message", (message) => {
    if (message && message.ok === true) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
      finish(0);
      return;
    }
    process.stderr.write("Electron utility native smoke failed.\n");
    finish(1);
  });
  child.on("exit", (code) => {
    if (settled) return;
    process.stderr.write(
      `Electron utility native smoke exited ${code ?? "null"}.\n`,
    );
    finish(code === 0 ? 0 : 1);
  });
});
