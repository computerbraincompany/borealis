/**
 * Journey F — Reviewed weekly brief (docs/END_TO_END_ACCEPTANCE.md row F +
 * milestones/M16-reviewed-briefs.md "Required tests and end-to-end acceptance").
 *
 * Real production build + real Chromium + the harness-launched OpenAI-compatible
 * fixture + a journey-launched authenticated WebDAV fixture serving ONE small
 * finance CSV (columns month,category,amount with a known sum).
 *
 * Attribution (per the acceptance contract): schedule semantics that need an
 * injected clock — DST spring gap / autumn overlap and coalesced-missed-
 * occurrence keys — are proven deterministically by the server suite
 * `server/src/tests/briefRunner.test.ts` (injected-clock runner) and
 * `server/src/tests/calendarSchedule.test.ts`. This BROWSER journey therefore
 * drives every execution through the real "Run now" pipeline (manual idempotent
 * runs), asserts the persisted weekly schedule fields, and asserts that the
 * SERVER-COMPUTED next-three occurrence preview renders honestly (civil + UTC
 * pairs verified against Node's own Intl calendar math, DST-shifted instants
 * included). The journey does not pretend to wait calendar days: production
 * exposes no test-clock control, and faking a due occurrence in the browser
 * would exercise the calendar math nowhere.
 *
 * Phases:
 *   P0  seed WebDAV finance.csv (sum 100) + launch fixture
 *   P1  account + library + knowledge connection preview/apply (D-pattern) so
 *       the single CSV source is knowledge-refreshable and tabular
 *   P2  saved analysis (metric_label/value, comparison key metric_label,
 *       one bound parameter) + baseline run for 100
 *   P3  recipe via the real Automations wizard (analysis+rev pin, param seed,
 *       membership mirror, weekly calendar + tz, knowledge refresh binding,
 *       running-app caveat) + persisted schedule fields + next-3 preview check
 *   P4  Run now #1 → awaiting_review → inbox first-run honest labeling →
 *       approve → report published + HTML/PDF bytes
 *   P5  WebDAV PUT 125 → Run now #2 → keyed delta (+25/+25%) via the STORED
 *       comparison → edit draft in workbench → approve edited head
 *   P6  Run now #3 unchanged → no-change comparison + NO new notification
 *   P7  Run now #4 → reject with note → preserved draft, no publication
 *   P8  notification tray read/dismiss durability
 *   P9  pause/resume, then DELETE recipe → published reports + run history
 *       stay readable through retained snapshots
 *   P10 failure matrix: double Run-now (one active / replay), stale decision
 *       409 with UI refresh guidance, foreign account 404
 */
import { HarnessError } from "../harness/util.mjs";

export const JOURNEY_ID = "F";
export const IMPLEMENTED = true;

export async function run() {
  throw new HarnessError("JOURNEY_F_INCOMPLETE", "phases P0–P10 not implemented yet");
}
