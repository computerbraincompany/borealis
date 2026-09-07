/** Retain synthetic acceptance artifacts without retaining credentials or workspace stores. */
import fs from "node:fs";
import path from "node:path";
import { assert } from "./util.mjs";

export function createEvidenceOutput(value) {
  if (value === undefined) return null;
  assert(
    typeof value === "string" && path.isAbsolute(value),
    "EVIDENCE_PATH_ABSOLUTE",
  );
  const target = path.resolve(value);
  // An exclusive new directory prevents accidental replacement of existing files.
  fs.mkdirSync(target, { mode: 0o700 });
  return {
    capture(artifactsDir) {
      if (fs.existsSync(artifactsDir)) {
        fs.cpSync(artifactsDir, path.join(target, "artifacts"), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    },
    finish(summary) {
      fs.writeFileSync(
        path.join(target, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    },
  };
}
