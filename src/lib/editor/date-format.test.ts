import { describe, expect, it } from "vitest";
import {
  buildDateItems,
  formatDateAbsolute,
  formatDateLabel,
  formatWeekday,
  fromISO,
  timePart,
  toISO,
  withTime,
} from "./date-format";

const REF = new Date(2026, 8, 1); // 2026-09-01

/** A time as the machine running the tests writes it, whatever its locale. */
const clock = (hours: number, minutes: number) =>
  new Date(2026, 0, 1, hours, minutes)
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(/\u202f/g, " ");

describe("a mention's value", () => {
  it("reads a day, and a day with a time", () => {
    expect(fromISO("2026-09-13")).toEqual(new Date(2026, 8, 13));
    expect(fromISO("2026-09-13T15:30")).toEqual(new Date(2026, 8, 13, 15, 30));
  });

  it("refuses what isn't one, rather than guessing", () => {
    for (const bad of [
      "",
      "soon",
      "2026-9-13",
      "2026-02-30",
      "2026-09-13T24:00",
      "2026-09-13T15:30Z",
    ]) {
      expect(fromISO(bad)).toBeNull();
    }
  });

  it("adds, changes and drops the time, keeping the day", () => {
    expect(withTime("2026-09-13", "09:05")).toBe("2026-09-13T09:05");
    expect(withTime("2026-09-13T09:05", "17:00")).toBe("2026-09-13T17:00");
    expect(withTime("2026-09-13T09:05", null)).toBe("2026-09-13");
    expect(timePart("2026-09-13T09:05")).toBe("09:05");
    expect(timePart("2026-09-13")).toBeNull();
  });

  it("is shown as written when this build can't read it", () => {
    expect(formatDateLabel("2026-09-13T15:30+02:00", REF)).toBe("2026-09-13T15:30+02:00");
    expect(formatWeekday("soon")).toBe("");
  });
});

describe("formatDateLabel", () => {
  it("names the three days around the reference as Today/Tomorrow/Yesterday", () => {
    expect(formatDateLabel("2026-09-01", REF)).toBe("Today");
    expect(formatDateLabel("2026-09-02", REF)).toBe("Tomorrow");
    expect(formatDateLabel("2026-08-31", REF)).toBe("Yesterday");
  });

  it("drops the year when the date falls in the reference year", () => {
    expect(formatDateLabel("2026-12-25", REF)).toBe("Dec 25");
  });

  it("keeps the year once the date leaves the reference year", () => {
    expect(formatDateLabel("2027-01-01", REF)).toBe("Jan 1, 2027");
    expect(formatDateLabel("2025-12-31", REF)).toBe("Dec 31, 2025");
  });

  it("adds the time, when there is one", () => {
    expect(formatDateLabel("2026-09-01T15:30", REF)).toBe(`Today ${clock(15, 30)}`);
    expect(formatDateLabel("2026-09-02T09:00", REF)).toBe(`Tomorrow ${clock(9, 0)}`);
    expect(formatDateLabel("2026-12-25T00:15", REF)).toBe(`Dec 25, ${clock(0, 15)}`);
    expect(formatDateAbsolute("2027-01-01T18:45", REF)).toBe(
      `Jan 1, 2027, ${clock(18, 45)}`,
    );
  });

  it("writes the time with plain spaces only", () => {
    expect(formatDateLabel("2026-09-01T15:30", REF)).not.toMatch(/[\u00a0\u202f]/);
  });
});

describe("formatWeekday", () => {
  it("names the day of the week", () => {
    expect(formatWeekday("2026-09-01")).toBe("Tuesday");
  });
});

describe("buildDateItems", () => {
  it("offers Today/Tomorrow/Yesterday plus 'Pick a date' for an empty query", () => {
    const items = buildDateItems("", REF);
    expect(items.map((i) => i.label)).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
      "Pick a date",
    ]);
    expect(items.at(-1)?.pick).toBe(true);
  });

  it("narrows to matches as the query grows", () => {
    const items = buildDateItems("tom", REF);
    expect(items.map((i) => i.label)).toEqual(["Tomorrow", "Pick a date"]);
  });

  it("resolves a bare weekday to its next occurrence", () => {
    const items = buildDateItems("friday", REF);
    expect(items[0].iso).toBe("2026-09-04");
  });

  it("resolves 'next <weekday>' to the following week's occurrence", () => {
    const items = buildDateItems("next tuesday", REF);
    expect(items[0].iso).toBe(toISO(new Date(2026, 8, 8)));
  });

  it("resolves relative offsets like 'in 3 days'", () => {
    const items = buildDateItems("in 3 days", REF);
    expect(items[0].iso).toBe("2026-09-04");
  });

  it("offers a typed time today and tomorrow", () => {
    for (const [query, time] of [
      ["3pm", "15:00"],
      ["3:30pm", "15:30"],
      ["9a", "09:00"],
      ["12am", "00:00"],
      ["12pm", "12:00"],
      ["15:30", "15:30"],
    ]) {
      const items = buildDateItems(query, REF);
      expect(items.map((i) => i.iso)).toEqual([
        `2026-09-01T${time}`,
        `2026-09-02T${time}`,
        "2026-09-01",
      ]);
      expect(items.at(-1)?.pick).toBe(true);
    }
  });

  it("takes neither a bare number nor an impossible time for a time", () => {
    for (const query of ["3", "13pm", "0am", "24:00", "9:60"]) {
      expect(buildDateItems(query, REF).some((i) => i.iso.includes("T"))).toBe(false);
    }
  });

  it("falls back to 'Pick a date' alone when nothing parses", () => {
    const items = buildDateItems("zzzzz", REF);
    expect(items).toHaveLength(1);
    expect(items[0].pick).toBe(true);
  });
});
