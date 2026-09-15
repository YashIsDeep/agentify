/**
 * Recognises a coding agent hitting its subscription's usage limit, and when that limit resets.
 *
 * Claude Code reports it as a `rate_limit_event` (its adapter reads that directly) and in prose;
 * Codex only in prose: "You've hit your usage limit … try again at Sep 6th, 2026 2:40 AM". So this
 * reads the prose loosely. A limit it recognises but can't date still counts: the caller picks a
 * time to try again.
 */

export interface UsageLimit {
  /** When the limit lifts; null when the agent didn't say. */
  resetAt: number | null;
}

const LIMIT_PATTERNS = [
  /usage[ _]limit/i, // "hit your usage limit", "Claude AI usage limit reached", usage_limit_exceeded
  /hit your limit/i,
  /\blimit reached\b.*\bresets?\b/i, // "5-hour limit reached · resets 3pm"
  /out of usage credits/i,
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 86_400_000;

export function detectUsageLimit(text: string, now = Date.now()): UsageLimit | null {
  if (!LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return { resetAt: parseResetTime(text, now) };
}

/** Epoch seconds or milliseconds, as the CLIs mix them. */
export const epochMs = (value: number) => (value < 1e12 ? value * 1000 : value);

export function parseResetTime(text: string, now = Date.now()): number | null {
  // Older Claude Code: "Claude AI usage limit reached|1757890800"
  const epoch = text.match(/\|\s*(\d{10}|\d{13})\b/);
  if (epoch) return epochMs(Number(epoch[1]));

  const relative = text.match(/\b(?:try again|resets?)\s+in\s+([^.·\n)]+)/i);
  const inMs = relative ? parseDuration(relative[1]!) : null;
  if (inMs) return now + inMs;

  const absolute = text.match(/\b(?:try again at|resets? at|resets? on|resets)\s+([^·\n]+)/i);
  return absolute ? parseClock(absolute[1]!, now) : null;
}

/** "~5 min", "2h 30m", "3 days 4 hours". */
function parseDuration(text: string): number | null {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS };
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?\b/gi)) {
    total += Number(amount) * units[unit!.charAt(0).toLowerCase()]!;
  }
  return total || null;
}

/** "3pm (Europe/London)", "Sep 14, 2pm", "Sep 6th, 2026 2:40 AM", "2026-08-08 00:00 UTC", "14:00". */
function parseClock(text: string, now: number): number | null {
  let zone = text.match(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\)/)?.[1] ?? (/\bUTC\b/.test(text) ? "UTC" : undefined);
  if (zone && !isValidZone(zone)) zone = undefined;

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (iso) return zonedTime(zone, Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0));

  let hour: number;
  let minute: number;
  const twelve = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  const twentyFour = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twelve) {
    hour = (Number(twelve[1]) % 12) + (twelve[3]!.toLowerCase() === "p" ? 12 : 0);
    minute = Number(twelve[2] ?? 0);
  } else if (twentyFour) {
    hour = Number(twentyFour[1]);
    minute = Number(twentyFour[2]);
  } else {
    return null;
  }

  const today = partsIn(zone, now);
  const date = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/i);
  if (date) {
    const month = MONTHS.indexOf(date[1]!.toLowerCase());
    const day = Number(date[2]);
    const at = zonedTime(zone, date[3] ? Number(date[3]) : today.year, month, day, hour, minute);
    // "Jan 2" read on Dec 30 means next year's.
    return !date[3] && at < now - DAY_MS ? zonedTime(zone, today.year + 1, month, day, hour, minute) : at;
  }
  // A bare time is the next time the clock reads it.
  const at = zonedTime(zone, today.year, today.month, today.day, hour, minute);
  return at > now ? at : zonedTime(zone, today.year, today.month, today.day + 1, hour, minute);
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts at `at` in `zone`; the machine's own zone when none is named. */
function partsIn(zone: string | undefined, at: number): ClockParts {
  if (!zone) {
    const date = new Date(at);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The instant a wall clock in `zone` reads this date and time. Out-of-range days roll over. */
function zonedTime(zone: string | undefined, year: number, month: number, day: number, hour: number, minute: number): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (at: number) => {
    const p = partsIn(zone, at);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  // Twice, so a guess on the wrong side of a DST change settles on the right offset.
  return wall - offsetAt(wall - offsetAt(wall));
}
