const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appBundle = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const infoPlist = path.join(appBundle, "Contents", "Info.plist");
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "-bool",
    "NO",
    infoPlist,
  ]);
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoadsInWebContent",
    "-bool",
    "NO",
    infoPlist,
  ]);

  // electron-builder 26 bundles @electron/fuses 1.x, which predates Electron
  // 44's ninth fuse. Apply the complete reviewed policy with strict coverage;
  // electron-builder's built-in pass repeats the first eight immediately before
  // signing and leaves the explicitly reviewed ninth value intact.
  const [{ flipFuses }, { electronFusePolicy }] = await Promise.all([
    import("@electron/fuses"),
    import("./fuse-policy.mjs"),
  ]);
  await flipFuses(appBundle, electronFusePolicy);
};
