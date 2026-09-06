import { describe, expect, it } from "vitest";
import {
  CalendarScheduleError,
  dueOccurrenceWindow,
  formatCivilKey,
  nextCivilOccurrence,
  nextOccurrence,
  nextOccurrences,
  normalizeCalendarSchedule,
  parseCivilKey,
  utcInstantForCivil,
  validateCalendarTimeZone,
  type CalendarSchedule,
} from "../calendarSchedule.js";

function schedule(partial: Partial<CalendarSchedule> & Pick<CalendarSchedule, "kind">): CalendarSchedule {
  return normalizeCalendarSchedule({ hour: 9, minute: 0, time_zone: "America/New_York", ...partial });
}

const utcMs = (iso: string) => Date.parse(iso);

describe("calendar schedule validation", () => {
  it("normalizes each civil kind with its exact companion field", () => {
    expect(schedule({ kind: "daily" })).toMatchObject({ kind: "daily", weekday: null, day_of_month: null });
    expect(schedule({ kind: "weekly", weekday: 1 })).toMatchObject({ kind: "weekly", weekday: 1 });
    expect(schedule({ kind: "monthly", day_of_month: 28 })).toMatchObject({ kind: "monthly", day_of_month: 28 });
  });

  it("rejects kind/companion mismatches and out-of-range parts", () => {
    expect(() => schedule({ kind: "weekly" })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "weekly", weekday: 7 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "monthly", day_of_month: 29 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "monthly", day_of_month: 0 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "daily", weekday: 1 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "daily", day_of_month: 1 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "daily", hour: 24 })).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "daily", minute: 60 })).toThrow(CalendarScheduleError);
    expect(() => normalizeCalendarSchedule({ kind: "daily", hour: 9, minute: 0, cron: "*" })).toThrow(
      /unknown schedule field/
    );
    expect(() => normalizeCalendarSchedule({ kind: "hourly", hour: 9, minute: 0 })).toThrow(CalendarScheduleError);
  });

  it("validates the IANA time zone through Intl and rejects garbage", () => {
    expect(validateCalendarTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(() => validateCalendarTimeZone("Mars/Olympus_Mons")).toThrow(/not a valid IANA time zone/);
    expect(() => validateCalendarTimeZone("")).toThrow(CalendarScheduleError);
    expect(() => validateCalendarTimeZone("  ")).toThrow(CalendarScheduleError);
    expect(() => validateCalendarTimeZone("Europe/Berlin\0")).toThrow(CalendarScheduleError);
    expect(() => schedule({ kind: "daily", time_zone: "Mars/Olympus_Mons" })).toThrow(CalendarScheduleError);
  });
});

describe("civil occurrence keys", () => {
  it("round-trips canonical civil keys and rejects malformed ones", () => {
    const civil = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 };
    expect(formatCivilKey(civil)).toBe("2026-03-08T02:30");
    expect(parseCivilKey("2026-03-08T02:30")).toEqual(civil);
    expect(() => parseCivilKey("2026-13-08T02:30")).toThrow(CalendarScheduleError);
    expect(() => parseCivilKey("2026-02-30T02:30")).toThrow(CalendarScheduleError);
    expect(() => parseCivilKey("2026-03-08 02:30")).toThrow(CalendarScheduleError);
    expect(() => parseCivilKey("manual:xyz")).toThrow(CalendarScheduleError);
  });
});

describe("spring-forward gaps (nonexistent civil times)", () => {
  it("America/New_York 2026-03-08 02:30 runs at the first valid instant after the gap", () => {
    // New York springs forward 2026-03-08 02:00 EST -> 03:00 EDT.
    const instant = utcInstantForCivil("America/New_York", {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
    });
    expect(new Date(instant).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("Europe/Berlin 2026-03-29 02:30 runs at the first valid instant after the gap", () => {
    // Berlin springs forward 2026-03-29 02:00 CET -> 03:00 CEST.
    const instant = utcInstantForCivil("Europe/Berlin", { year: 2026, month: 3, day: 29, hour: 2, minute: 30 });
    expect(new Date(instant).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("Australia/Sydney 2026-10-04 02:30 (southern-hemisphere spring) resolves past the gap", () => {
    // Sydney springs forward 2026-10-04 02:00 AEST -> 03:00 AEDT.
    const instant = utcInstantForCivil("Australia/Sydney", { year: 2026, month: 10, day: 4, hour: 2, minute: 30 });
    expect(new Date(instant).toISOString()).toBe("2026-10-03T16:00:00.000Z");
  });

  it("the identity key for a gapped occurrence is the requested civil time", () => {
    const daily = schedule({ kind: "daily", hour: 2, minute: 30 });
    const preview = nextOccurrence(daily, utcMs("2026-03-08T06:59:00.000Z"));
    expect(preview.occurrence_key).toBe("2026-03-08T02:30");
    expect(preview.utc_at).toBe("2026-03-08T07:00:00.000Z");
  });
});

describe("autumn overlaps (repeated civil times)", () => {
  it("America/New_York 2026-11-01 01:30 runs once at the earlier instant", () => {
    // New York falls back 2026-11-01 02:00 EDT -> 01:00 EST: 01:30 occurs twice.
    const instant = utcInstantForCivil("America/New_York", { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(new Date(instant).toISOString()).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, the earlier pass
    // One hour later the SAME civil minute has passed again — proof this civil
    // time really repeats, and the reason the key (not the instant) is identity.
    const later = utcInstantForCivil("America/New_York", { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(later).toBe(instant);
  });

  it("Europe/Berlin 2026-10-25 02:30 resolves at the earlier of the two instants", () => {
    // Berlin falls back 2026-10-25 03:00 CEST -> 02:00 CET: 02:30 occurs twice.
    const instant = utcInstantForCivil("Europe/Berlin", { year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
    expect(new Date(instant).toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST
  });

  it("Australia/Sydney 2026-04-05 02:30 (southern-hemisphere fall) resolves at the earlier instant", () => {
    // Sydney falls back 2026-04-05 03:00 AEDT -> 02:00 AEST: 02:30 occurs twice.
    const instant = utcInstantForCivil("Australia/Sydney", { year: 2026, month: 4, day: 5, hour: 2, minute: 30 });
    expect(new Date(instant).toISOString()).toBe("2026-04-04T15:30:00.000Z"); // 02:30 AEDT
  });

  it("the repeated civil time produces exactly one occurrence key in a walk", () => {
    const daily = schedule({ kind: "daily", hour: 1, minute: 30 });
    // Injected clock inside the overlap window (after the earlier 05:30Z pass
    // and before the next civil day's instant). The civil key was already
    // produced at the earlier instant, so the walk must not expose a second
    // key for the repeated wall time.
    const window = dueOccurrenceWindow(daily, "2026-11-01T01:30", utcMs("2026-11-01T06:00:00.000Z"));
    expect(window.due.map((entry) => entry.occurrence_key)).toEqual(["2026-11-01T01:30"]);
    expect(window.next.occurrence_key).toBe("2026-11-02T01:30");
  });
});

describe("civil sequence arithmetic", () => {
  it("daily steps one civil day and crosses month/year boundaries", () => {
    const daily = schedule({ kind: "daily", hour: 23, minute: 30 });
    expect(nextCivilOccurrence(daily, parseCivilKey("2026-01-31T23:30"))).toEqual(parseCivilKey("2026-02-01T23:30"));
    expect(nextCivilOccurrence(daily, parseCivilKey("2026-12-31T23:30"))).toEqual(parseCivilKey("2027-01-01T23:30"));
  });

  it("weekly steps seven civil days to the chosen weekday", () => {
    const mondays = schedule({ kind: "weekly", weekday: 1, hour: 9, minute: 0 });
    expect(nextCivilOccurrence(mondays, parseCivilKey("2026-03-02T09:00"))).toEqual(parseCivilKey("2026-03-09T09:00"));
    // A civil datetime on the same weekday after the scheduled time advances a week.
    expect(nextCivilOccurrence(mondays, parseCivilKey("2026-03-02T10:00"))).toEqual(parseCivilKey("2026-03-09T09:00"));
  });

  it("monthly day 1–28 never skips a month", () => {
    const monthly = schedule({ kind: "monthly", day_of_month: 28, hour: 7, minute: 15 });
    expect(nextCivilOccurrence(monthly, parseCivilKey("2026-01-28T07:15"))).toEqual(parseCivilKey("2026-02-28T07:15"));
    expect(nextCivilOccurrence(monthly, parseCivilKey("2026-02-28T07:15"))).toEqual(parseCivilKey("2026-03-28T07:15"));
    const first = schedule({ kind: "monthly", day_of_month: 1, hour: 0, minute: 0 });
    expect(nextCivilOccurrence(first, parseCivilKey("2026-12-01T00:00"))).toEqual(parseCivilKey("2027-01-01T00:00"));
  });
});

describe("next-occurrence preview", () => {
  it("shows the next three civil keys and their resolved UTC instants", () => {
    const weekly = schedule({ kind: "weekly", weekday: 1, hour: 9, minute: 0 });
    const previews = nextOccurrences(weekly, utcMs("2026-02-25T12:00:00.000Z"));
    expect(previews).toHaveLength(3);
    expect(previews.map((entry) => entry.occurrence_key)).toEqual([
      "2026-03-02T09:00",
      "2026-03-09T09:00",
      "2026-03-16T09:00",
    ]);
    // 2026-03-02 is still EST: 09:00 EST = 14:00Z.
    expect(previews[0].utc_at).toBe("2026-03-02T14:00:00.000Z");
  });

  it("a daily 02:30 New York preview steps over the spring gap by civil identity", () => {
    const daily = schedule({ kind: "daily", hour: 2, minute: 30 });
    const previews = nextOccurrences(daily, utcMs("2026-03-06T08:00:00.000Z"));
    expect(previews.map((entry) => entry.occurrence_key)).toEqual([
      "2026-03-07T02:30",
      "2026-03-08T02:30",
      "2026-03-09T02:30",
    ]);
    expect(previews[1].utc_at).toBe("2026-03-08T07:00:00.000Z"); // gapped day -> first valid instant
  });

  it("the preview is deterministic under an injected clock", () => {
    const monthly = schedule({ kind: "monthly", day_of_month: 15, hour: 18, minute: 30, time_zone: "Europe/Berlin" });
    const reference = utcMs("2026-05-17T00:00:00.000Z");
    expect(nextOccurrences(monthly, reference)).toEqual(nextOccurrences(monthly, reference));
    expect(nextOccurrences(monthly, reference)[0].utc_at).toBe("2026-06-15T16:30:00.000Z"); // 18:30 CEST
  });

  it("rejects preview counts beyond the bound", () => {
    const daily = schedule({ kind: "daily" });
    expect(() => nextOccurrences(daily, Date.now(), 4)).toThrow(CalendarScheduleError);
    expect(() => nextOccurrences(daily, Date.now(), 0)).toThrow(CalendarScheduleError);
  });
});

describe("due-occurrence window with an injected clock", () => {
  it("collapses a missed daily window to the exact missed keys and advances past now", () => {
    const daily = schedule({ kind: "daily", hour: 2, minute: 30 });
    // Server down from the 2026-03-08 gap occurrence through 2026-03-31.
    const window = dueOccurrenceWindow(daily, "2026-03-08T02:30", utcMs("2026-04-01T00:00:00.000Z"));
    expect(window.due[0].occurrence_key).toBe("2026-03-08T02:30");
    expect(window.due[window.due.length - 1].occurrence_key).toBe("2026-03-31T02:30");
    expect(window.due).toHaveLength(24);
    expect(window.next.occurrence_key).toBe("2026-04-01T02:30");
  });

  it("replaying the same injected clock and cursor reproduces the same first key", () => {
    const weekly = schedule({ kind: "weekly", weekday: 0, hour: 8, minute: 0, time_zone: "Australia/Sydney" });
    const clock = utcMs("2026-06-15T05:00:00.000Z");
    const first = dueOccurrenceWindow(weekly, "2026-05-10T08:00", clock);
    const restart = dueOccurrenceWindow(weekly, "2026-05-10T08:00", clock);
    expect(first).toEqual(restart);
    expect(first.due[0].occurrence_key).toBe("2026-05-10T08:00");
  });

  it("a cursor that is not yet due yields an empty due window", () => {
    const daily = schedule({ kind: "daily", hour: 9, minute: 0 });
    const window = dueOccurrenceWindow(daily, "2026-06-10T09:00", utcMs("2026-06-10T00:00:00.000Z"));
    expect(window.due).toEqual([]);
    expect(window.next.occurrence_key).toBe("2026-06-10T09:00");
  });
});
