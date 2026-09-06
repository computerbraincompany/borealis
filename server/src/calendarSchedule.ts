/**
 * Civil-schedule → UTC occurrence calculator for reviewed briefs (M16 stage 1).
 *
 * A brief schedule is a *civil* rule — daily, weekly on one weekday, or monthly
 * on day 1–28 — evaluated at a fixed wall-clock hour/minute inside one
 * validated IANA time zone. There is deliberately no cron or RRULE surface:
 * the civil rule is the durable contract, and every occurrence is identified
 * by its civil date-time string (`YYYY-MM-DDTHH:MM` in the recipe's zone),
 * never by a UTC instant. That identity is what makes restart-safe claiming
 * possible: a repeated autumn civil time exists only once as a key, so the
 * second UTC instance of that wall-clock minute can never start a second run.
 *
 * DST resolution rules (fixed by the M16 contract):
 * - Nonexistent spring-forward civil time → run at the first valid local
 *   instant after the gap. Implementation: the earliest UTC instant whose
 *   local minute is at or after the civil target; inside a gap that instant is
 *   exactly the first instant after the jump.
 * - Repeated autumn civil time → run once at the EARLIER instant. The same
 *   "earliest instant with local ≥ target" search returns the first pass of
 *   the wall-clock minute, and the civil occurrence key deduplicates the rest.
 *
 * The search relies on `localMinuteEpoch(utc)` being monotone nondecreasing in
 * UTC (true for every real time zone: local wall time only repeats, never
 * rewinds) and on the ±16-hour world-offset bound around the civil target.
 * All functions are pure and take explicit reference times so tests can inject
 * a clock; production code passes `new Date()` at the call site.
 */

export const CALENDAR_MAX_PREVIEW = 3;
export const CALENDAR_TIME_ZONE_MAX_CHARS = 64;
export const CALENDAR_OCCURRENCE_KEY_MAX_CHARS = 40;

export type CalendarScheduleKind = "daily" | "weekly" | "monthly";

export interface CalendarSchedule {
  readonly kind: CalendarScheduleKind;
  /** Weekday 0 (Sunday) … 6 (Saturday); present exactly for `weekly`. */
  readonly weekday: number | null;
  /** Day of month 1–28; present exactly for `monthly`. */
  readonly day_of_month: number | null;
  readonly hour: number;
  readonly minute: number;
  readonly time_zone: string;
}

/** A civil (wall-clock) minute in the schedule's zone. */
export interface CivilDateTime {
  readonly year: number; // proleptic year
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
}

export interface CalendarOccurrencePreview {
  /** Civil occurrence identity key, stable across restarts and clock skew. */
  readonly occurrence_key: string;
  /** Civil wall-clock time in the recipe's zone (same rendering as the key). */
  readonly civil: string;
  /** Resolved UTC instant of this civil occurrence (ISO 8601). */
  readonly utc_at: string;
}

export class CalendarScheduleError extends Error {
  readonly code = "CALENDAR_SCHEDULE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CalendarScheduleError";
  }
}

const CIVIL_PARTS_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MAX_WORLD_OFFSET_MS = 16 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Time-zone validation
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Validates a nonempty IANA zone name exactly through `Intl`. */
export function validateCalendarTimeZone(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > CALENDAR_TIME_ZONE_MAX_CHARS ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new CalendarScheduleError("time_zone must be a bounded nonblank string");
  }
  try {
    zoneFormatter(value);
  } catch {
    throw new CalendarScheduleError(`time_zone "${value}" is not a valid IANA time zone`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Schedule normalization
// ---------------------------------------------------------------------------

function integerIn(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CalendarScheduleError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function rejectScheduleField(): never {
  throw new CalendarScheduleError("weekday applies only to weekly and day_of_month only to monthly schedules");
}

/**
 * Validates and freezes one civil schedule. `weekly` requires exactly a
 * `weekday` (0–6); `monthly` requires exactly a `day_of_month` (1–28, so
 * every calendar month has the date); `daily` requires neither.
 */
export function normalizeCalendarSchedule(value: unknown): CalendarSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalendarScheduleError("schedule must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["kind", "weekday", "day_of_month", "hour", "minute", "time_zone"].includes(key)) {
      throw new CalendarScheduleError(`unknown schedule field "${key}"`);
    }
  }
  const kind = record.kind;
  if (kind !== "daily" && kind !== "weekly" && kind !== "monthly") {
    throw new CalendarScheduleError("schedule kind must be daily, weekly, or monthly");
  }
  const hour = integerIn(record.hour, "hour", 0, 23);
  const minute = integerIn(record.minute, "minute", 0, 59);
  const weekday = kind === "weekly" ? integerIn(record.weekday, "weekday", 0, 6) : fieldAbsent(record, "weekday");
  const dayOfMonth =
    kind === "monthly" ? integerIn(record.day_of_month, "day_of_month", 1, 28) : fieldAbsent(record, "day_of_month");
  const time_zone = validateCalendarTimeZone(record.time_zone);
  return Object.freeze({ kind, weekday, day_of_month: dayOfMonth, hour, minute, time_zone });
}

function fieldAbsent(record: Record<string, unknown>, field: "weekday" | "day_of_month"): null {
  // Persisted schedule snapshots carry explicit nulls; an absent companion
  // field may arrive as either `undefined` (API input) or `null` (decoded
  // durable JSON). Anything else is a kind/companion mismatch.
  if (record[field] === undefined || record[field] === null) return null;
  return rejectScheduleField();
}

// ---------------------------------------------------------------------------
// Civil keys and civil arithmetic (proleptic, zone-free)
// ---------------------------------------------------------------------------

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCivilKey(civil: CivilDateTime): string {
  return `${String(civil.year).padStart(4, "0")}-${two(civil.month)}-${two(civil.day)}T${two(civil.hour)}:${two(civil.minute)}`;
}

export function parseCivilKey(key: unknown): CivilDateTime {
  if (typeof key !== "string" || key.length > CALENDAR_OCCURRENCE_KEY_MAX_CHARS) {
    throw new CalendarScheduleError("civil occurrence key must match YYYY-MM-DDTHH:MM");
  }
  const match = CIVIL_PARTS_PATTERN.exec(key);
  if (!match) throw new CalendarScheduleError("civil occurrence key must match YYYY-MM-DDTHH:MM");
  const civil: CivilDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  // Explicit bounds catch ranges the formatting step would echo back
  // unchanged; the Date.UTC probe catches rolled-over real dates (Feb 30).
  const probe = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, 12));
  if (
    !Number.isFinite(probe.getTime()) ||
    civil.year < 1 ||
    civil.hour > 23 ||
    civil.minute > 59 ||
    probe.getUTCFullYear() !== civil.year ||
    probe.getUTCMonth() !== civil.month - 1 ||
    probe.getUTCDate() !== civil.day ||
    formatCivilKey(civil) !== key
  ) {
    throw new CalendarScheduleError("civil occurrence key is not canonical");
  }
  return civil;
}

function civilEpochDays(year: number, month: number, day: number): number {
  // Noon-anchored UTC day number: exact for the proleptic Gregorian range.
  return Math.floor(Date.UTC(year, month - 1, day, 12, 0, 0) / 86_400_000);
}

function civilDateFromEpochDays(days: number): { year: number; month: number; day: number } {
  const instant = new Date(days * 86_400_000 + 12 * 3_600_000);
  return { year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1, day: instant.getUTCDate() };
}

function civilAtTime(civil: CivilDateTime, schedule: CalendarSchedule): CivilDateTime {
  return {
    ...civilDateFromEpochDays(civilEpochDays(civil.year, civil.month, civil.day)),
    hour: schedule.hour,
    minute: schedule.minute,
  };
}

function civilWeekday(civil: CivilDateTime): number {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day, 12)).getUTCDay();
}

function compareCivil(left: CivilDateTime, right: CivilDateTime): number {
  const a = formatCivilKey(left);
  const b = formatCivilKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function nextMonthCivil(civil: CivilDateTime): CivilDateTime {
  const total = civil.year * 12 + (civil.month - 1) + 1;
  return { ...civil, year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** The strictly next civil occurrence of `schedule` after `after`. */
export function nextCivilOccurrence(schedule: CalendarSchedule, after: CivilDateTime): CivilDateTime {
  switch (schedule.kind) {
    case "daily": {
      const nextDay = civilDateFromEpochDays(civilEpochDays(after.year, after.month, after.day) + 1);
      return { ...nextDay, hour: schedule.hour, minute: schedule.minute };
    }
    case "weekly": {
      const target = schedule.weekday as number;
      let delta = (target - civilWeekday(after) + 7) % 7;
      const candidate = civilDateFromEpochDays(civilEpochDays(after.year, after.month, after.day) + delta);
      if (compareCivil({ ...candidate, hour: schedule.hour, minute: schedule.minute }, after) <= 0) delta += 7;
      const advanced = civilDateFromEpochDays(civilEpochDays(after.year, after.month, after.day) + delta);
      return { ...advanced, hour: schedule.hour, minute: schedule.minute };
    }
    case "monthly": {
      const targetDay = schedule.day_of_month as number;
      // Day 1–28 always exists in the candidate month, so the civil sequence
      // never skips a month.
      const candidate: CivilDateTime = {
        year: after.year,
        month: after.month,
        day: targetDay,
        hour: schedule.hour,
        minute: schedule.minute,
      };
      if (compareCivil(candidate, after) > 0) return candidate;
      return nextMonthCivil(candidate);
    }
  }
}

/** The first civil occurrence at or after `from` (inclusive). */
function firstCivilAtOrAfter(schedule: CalendarSchedule, from: CivilDateTime): CivilDateTime {
  switch (schedule.kind) {
    case "daily": {
      const candidate = civilAtTime(from, schedule);
      return compareCivil(candidate, from) >= 0 ? candidate : nextCivilOccurrence(schedule, candidate);
    }
    case "weekly": {
      const target = schedule.weekday as number;
      const delta = (target - civilWeekday(from) + 7) % 7;
      const candidateDate = civilDateFromEpochDays(civilEpochDays(from.year, from.month, from.day) + delta);
      const candidate: CivilDateTime = { ...candidateDate, hour: schedule.hour, minute: schedule.minute };
      return compareCivil(candidate, from) >= 0
        ? candidate
        : {
            ...civilDateFromEpochDays(civilEpochDays(from.year, from.month, from.day) + delta + 7),
            hour: schedule.hour,
            minute: schedule.minute,
          };
    }
    case "monthly": {
      const targetDay = schedule.day_of_month as number;
      const candidate: CivilDateTime = {
        year: from.year,
        month: from.month,
        day: targetDay,
        hour: schedule.hour,
        minute: schedule.minute,
      };
      return compareCivil(candidate, from) >= 0 ? candidate : nextMonthCivil(candidate);
    }
  }
}

// ---------------------------------------------------------------------------
// Civil → UTC resolution with DST gap/overlap rules
// ---------------------------------------------------------------------------

function localMinuteEpoch(timeZone: string, utcMs: number): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new CalendarScheduleError(`time zone ${timeZone} produced no ${type} part`);
    return Number(part.value);
  };
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"));
}

function localCivilOf(timeZone: string, utcMs: number): CivilDateTime {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new CalendarScheduleError(`time zone ${timeZone} produced no ${type} part`);
    return Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

/**
 * The earliest UTC instant whose local wall-clock minute in `timeZone` is at
 * or after the civil target minute.
 *
 * - Civil time exists exactly once → that minute's start, second-aligned.
 * - Repeated (autumn overlap) → the EARLIER of the two instants.
 * - Nonexistent (spring gap) → the first valid local instant after the gap.
 */
export function utcInstantForCivil(timeZone: string, civil: CivilDateTime): number {
  validateCalendarTimeZone(timeZone);
  const target = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
  // `localMinuteEpoch` is monotone nondecreasing in UTC, so the predicate
  // "local minute >= target" is monotone; binary-search its first true ms
  // inside the world-offset bound. The predicate is constant within each
  // minute and DST switches are second-aligned, so the minimum lands exactly
  // on a second-0 instant.
  let lo = target - MAX_WORLD_OFFSET_MS; // predicate false here and below
  let hi = target + MAX_WORLD_OFFSET_MS; // predicate true here and above
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localMinuteEpoch(timeZone, mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Occurrence enumeration
// ---------------------------------------------------------------------------

function previewOf(civil: CivilDateTime, timeZone: string): CalendarOccurrencePreview {
  const key = formatCivilKey(civil);
  return Object.freeze({
    occurrence_key: key,
    civil: key,
    utc_at: new Date(utcInstantForCivil(timeZone, civil)).toISOString(),
  });
}

/**
 * The next occurrence strictly after `afterUtcMs`: its stable civil key plus
 * the resolved UTC instant. The search starts from the local civil minute of
 * `afterUtcMs` and walks at most a handful of civil candidates; each
 * candidate resolves through the gap/overlap rules above.
 */
export function nextOccurrence(schedule: CalendarSchedule, afterUtcMs: number): CalendarOccurrencePreview {
  if (!Number.isFinite(afterUtcMs)) throw new CalendarScheduleError("reference time must be finite");
  let civil = firstCivilAtOrAfter(schedule, localCivilOf(schedule.time_zone, afterUtcMs));
  for (let steps = 0; steps < 10; steps += 1) {
    const utcMs = utcInstantForCivil(schedule.time_zone, civil);
    if (utcMs > afterUtcMs) return previewOf(civil, schedule.time_zone);
    civil = nextCivilOccurrence(schedule, civil);
  }
  throw new CalendarScheduleError("schedule produced no occurrence after the reference time");
}

/**
 * The next `count` (default 3, maximum {@link CALENDAR_MAX_PREVIEW}) local and
 * UTC run times, for the editor's before-save preview.
 */
export function nextOccurrences(
  schedule: CalendarSchedule,
  afterUtcMs: number,
  count: number = CALENDAR_MAX_PREVIEW
): readonly CalendarOccurrencePreview[] {
  if (!Number.isInteger(count) || count < 1 || count > CALENDAR_MAX_PREVIEW) {
    throw new CalendarScheduleError(`preview count must be between 1 and ${CALENDAR_MAX_PREVIEW}`);
  }
  const previews: CalendarOccurrencePreview[] = [];
  let cursor = afterUtcMs;
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrence(schedule, cursor);
    previews.push(next);
    cursor = Date.parse(next.utc_at);
  }
  return Object.freeze(previews);
}

/**
 * Walks civil occurrences from `cursorKey` (inclusive) while their resolved
 * UTC instant is at or before `nowMs`. Returns every due occurrence (the
 * catch-up window the caller coalesces into one run) plus the first not-yet
 * due occurrence (the cursor the caller advances to). The walk is capped so a
 * pathological cursor can never spin: the cap is a fairness bound, never a
 * correctness bound, because the civil sequence is strictly increasing and the
 * remaining past-due occurrences coalesce on the next tick.
 */
export function dueOccurrenceWindow(
  schedule: CalendarSchedule,
  cursorKey: string,
  nowMs: number,
  walkLimit = 1000
): { readonly due: readonly CalendarOccurrencePreview[]; readonly next: CalendarOccurrencePreview } {
  let civil = parseCivilKey(cursorKey);
  const due: CalendarOccurrencePreview[] = [];
  for (let steps = 0; steps <= walkLimit; steps += 1) {
    const utcMs = utcInstantForCivil(schedule.time_zone, civil);
    if (utcMs > nowMs) return { due: Object.freeze(due), next: previewOf(civil, schedule.time_zone) };
    due.push(previewOf(civil, schedule.time_zone));
    civil = nextCivilOccurrence(schedule, civil);
  }
  return { due: Object.freeze(due), next: previewOf(civil, schedule.time_zone) };
}
