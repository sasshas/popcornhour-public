// The Calendar page: which movies come out on each day of a month, for any month and year.
// Client-safe (no server imports).

/** "theatrical" = in cinemas; "streaming" = digital / streaming release (what whentostream.com lists). */
export const CALENDAR_KINDS = {
  theatrical: { label: "In cinemas", releaseTypes: "2|3" },
  streaming: { label: "Streaming & digital", releaseTypes: "4" },
} as const;

export type CalendarKind = keyof typeof CALENDAR_KINDS;

export const CALENDAR_KIND_SLUGS = Object.keys(CALENDAR_KINDS) as [CalendarKind, ...CalendarKind[]];

export function isCalendarKind(v: unknown): v is CalendarKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CALENDAR_KINDS, v);
}

export const CALENDAR_MIN_YEAR = 1950;
export const CALENDAR_MAX_YEAR = 2100;

/** The most titles shown for one day (the most popular ones; a busy day has many). */
export const CALENDAR_MAX_PER_DAY = 20;

export type CalendarMonth = { year: number; month: number }; // month is 1-12

const pad = (n: number) => String(n).padStart(2, "0");

export function daysInMonth({ year, month }: CalendarMonth): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthKey({ year, month }: CalendarMonth): string {
  return `${year}-${pad(month)}`;
}

export function dayKey({ year, month }: CalendarMonth, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-11" -> {year: 2026, month: 11}; anything invalid or out of range gives null. */
export function parseMonthKey(v: unknown): CalendarMonth | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < CALENDAR_MIN_YEAR || year > CALENDAR_MAX_YEAR) return null;
  return { year, month };
}

export function addMonths({ year, month }: CalendarMonth, delta: number): CalendarMonth {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function clampMonth(m: CalendarMonth): CalendarMonth {
  if (m.year < CALENDAR_MIN_YEAR) return { year: CALENDAR_MIN_YEAR, month: 1 };
  if (m.year > CALENDAR_MAX_YEAR) return { year: CALENDAR_MAX_YEAR, month: 12 };
  return m;
}

export function currentMonth(): CalendarMonth {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Weekday of the 1st, with Monday = 0 (the grid starts on Monday). */
export function firstWeekdayMonday({ year, month }: CalendarMonth): number {
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}
