/**
 * Journey registry for the product-acceptance harness.
 *
 * The six required journeys A–F from docs/END_TO_END_ACCEPTANCE.md are each a
 * module exporting `run(ctx)`. Until a journey's feature wave lands, its
 * module is an explicit NOT-IMPLEMENTED stub that fails loudly — the runner
 * must never silently skip a journey, so a green `--journey=all` run can only
 * mean all six are real.
 *
 * `smoke` is the harness's own lifecycle self-test (server + provider +
 * real-UI auth + console cleanliness + orderly shutdown). It is NOT one of
 * A–F and its passing says nothing about them.
 */
import { HarnessError } from "../harness/util.mjs";

export class JourneyNotImplementedError extends HarnessError {
  constructor(journeyId) {
    super(`JOURNEY_NOT_IMPLEMENTED:${journeyId}`, `journey ${journeyId} ships as a loud stub until its feature lands`);
    this.name = "JourneyNotImplementedError";
    this.journeyId = journeyId;
  }
}

export function notImplementedStub(journeyId) {
  return async function run() {
    throw new JourneyNotImplementedError(journeyId);
  };
}

/** Canonical journey modules keyed by id. */
export const JOURNEYS = {
  A: () => import("./A.mjs"),
  B: () => import("./B.mjs"),
  C: () => import("./C.mjs"),
  D: () => import("./D.mjs"),
  E: () => import("./E.mjs"),
  F: () => import("./F.mjs"),
  smoke: () => import("./smoke.mjs"),
};

export const REQUIRED_JOURNEY_IDS = ["A", "B", "C", "D", "E", "F"];

/**
 * Resolve the `--journey=` value. `all` means exactly the six required
 * journeys (never extra self-tests); explicit ids are accepted for the smoke
 * self-test and individual journeys.
 */
export function resolveJourneyIds(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HarnessError("ARG_JOURNEY_MISSING", "pass --journey=A|B|C|D|E|F|smoke|all (comma-separated allowed)");
  }
  if (value === "all") return [...REQUIRED_JOURNEY_IDS];
  const canonical = new Map(Object.keys(JOURNEYS).map((key) => [key.toUpperCase(), key]));
  const ids = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const key = canonical.get(token.toUpperCase());
      if (!key) throw new HarnessError("ARG_JOURNEY_UNKNOWN", token);
      return key;
    });
  return ids;
}

export async function loadJourney(id) {
  const module = await JOURNEYS[id]();
  if (typeof module.run !== "function") {
    throw new HarnessError("JOURNEY_RUN_MISSING", id);
  }
  return {
    id,
    implemented: module.IMPLEMENTED === true,
    run: module.run,
  };
}
