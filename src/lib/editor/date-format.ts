const MS_PER_DAY = 86_400_000;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-09-13` or `2026-09-13T15:30`. Wall-clock time, no zone. */
const VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The time in a mention's value, or null for a day without one. */
export function timePart(iso: string): string | null {
  const m = iso.match(VALUE);
  return m?.[4] ? `${m[4]}:${m[5]}` : null;
}

/** The same day at `time`, or with no time at all. */
export function withTime(iso: string, time: string | null): string {
  const day = iso.slice(0, 10);
  return time ? `${day}T${time}` : day;
}

/** Null for a value this build cannot read; shown as written rather than taking the page down. */
export function fromISO(iso: string): Date | null {
  const m = iso.match(VALUE);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const [hours, minutes] = [Number(m[4] ?? 0), Number(m[5] ?? 0)];
  if (hours > 23 || minutes > 59) return null;
  const d = new Date(year, month, day, hours, minutes);
  // `new Date` rolls February 30th over into March rather than refusing it.
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** A time as the reader's locale writes it: `3:30 PM`, or `15:30`. */
export function formatTime(d: Date): string {
  // ICU puts a narrow no-break space before AM/PM; the label is written into Markdown too.
  return d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(/\u202f/g, " ");
}

export function formatDateAbsolute(iso: string, reference: Date = new Date()): string {
  const d = fromISO(iso);
  if (!d) return iso;
  const month = MONTHS[d.getMonth()].slice(0, 3);
  const day =
    d.getFullYear() === reference.getFullYear()
      ? `${month} ${d.getDate()}`
      : `${month} ${d.getDate()}, ${d.getFullYear()}`;
  return timePart(iso) ? `${day}, ${formatTime(d)}` : day;
}

export function formatDateLabel(iso: string, reference: Date = new Date()): string {
  const d = fromISO(iso);
  if (!d) return iso;
  const diffDays = Math.round(
    (startOfDay(d).getTime() - startOfDay(reference).getTime()) / MS_PER_DAY,
  );
  const relative =
    diffDays === 0
      ? "Today"
      : diffDays === 1
        ? "Tomorrow"
        : diffDays === -1
          ? "Yesterday"
          : null;
  if (!relative) return formatDateAbsolute(iso, reference);
  return timePart(iso) ? `${relative} ${formatTime(d)}` : relative;
}

export function formatWeekday(iso: string): string {
  const d = fromISO(iso);
  if (!d) return "";
  return WEEKDAYS[d.getDay()][0].toUpperCase() + WEEKDAYS[d.getDay()].slice(1);
}

interface DateGuess {
  iso: string;
}

/** A bare number is not a time: as likely the start of a date. */
function parseTime(q: string): string | null {
  const twelve = q.match(/^(\d{1,2})(?::(\d{2}))?([ap])m?$/);
  if (twelve) {
    const hour = Number(twelve[1]);
    const minutes = Number(twelve[2] ?? 0);
    if (hour < 1 || hour > 12 || minutes > 59) return null;
    return `${pad((hour % 12) + (twelve[3] === "p" ? 12 : 0))}:${pad(minutes)}`;
  }
  const clock = q.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    return `${pad(hours)}:${pad(minutes)}`;
  }
  return null;
}

function guessDates(query: string, now: Date): DateGuess[] {
  const q = query.trim().toLowerCase();
  const today = startOfDay(now);
  const out: DateGuess[] = [];

  if (!q) {
    return [
      { iso: toISO(today) },
      { iso: toISO(addDays(today, 1)) },
      { iso: toISO(addDays(today, -1)) },
    ];
  }

  // A time alone is most often later today, and otherwise tomorrow.
  const time = parseTime(q);
  if (time) {
    out.push({ iso: withTime(toISO(today), time) });
    out.push({ iso: withTime(toISO(addDays(today, 1)), time) });
  }

  if ("today".startsWith(q)) out.push({ iso: toISO(today) });
  if ("tomorrow".startsWith(q)) out.push({ iso: toISO(addDays(today, 1)) });
  if ("yesterday".startsWith(q)) out.push({ iso: toISO(addDays(today, -1)) });

  const inMatch = q.match(/^in (\d+) ?(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    const d = new Date(today);
    if (unit.startsWith("week")) d.setDate(d.getDate() + n * 7);
    else if (unit.startsWith("month")) d.setMonth(d.getMonth() + n);
    else d.setDate(d.getDate() + n);
    out.push({ iso: toISO(d) });
  }

  const wdMatch = q.match(/^(next |last )?([a-z]+)$/);
  if (wdMatch) {
    const wd = wdMatch[2];
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd) && wd.length >= 2);
    if (idx >= 0) {
      const cur = today.getDay();
      let delta = (idx - cur + 7) % 7;
      if (wdMatch[1] === "next ") delta = delta === 0 ? 7 : delta + 7;
      else if (wdMatch[1] === "last ") delta = delta === 0 ? -7 : delta - 7;
      out.push({ iso: toISO(addDays(today, delta)) });
    }
  }

  if (out.length === 0) {
    const explicit = tryParseExplicit(q, today);
    if (explicit) out.push({ iso: toISO(explicit) });
  }

  const seen = new Set<string>();
  return out
    .filter((g) => (seen.has(g.iso) ? false : (seen.add(g.iso), true)))
    .slice(0, 5);
}

function tryParseExplicit(q: string, today: Date): Date | null {
  const bare = q.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (bare) {
    const month = Number(bare[1]) - 1;
    const day = Number(bare[2]);
    if (month >= 0 && month < 12 && day >= 1 && day <= 31) {
      return new Date(today.getFullYear(), month, day);
    }
  }
  const parsed = Date.parse(q);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);

  if (!/\d{4}/.test(q)) d.setFullYear(today.getFullYear());
  return startOfDay(d);
}

export interface DateMenuItem {
  id: string;
  label: string;
  sublabel?: string;
  iso: string;
  pick?: boolean;
}

export function buildDateItems(query: string, now: Date = new Date()): DateMenuItem[] {
  const items: DateMenuItem[] = guessDates(query, now).map((g) => ({
    id: g.iso,
    label: formatDateLabel(g.iso, now),
    sublabel: formatWeekday(g.iso),
    iso: g.iso,
  }));
  items.push({
    id: "__pick__",
    label: "Pick a date",
    iso: toISO(startOfDay(now)),
    pick: true,
  });
  return items;
}
