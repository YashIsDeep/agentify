import { workedMs } from "@wm/shared";

export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

/** Compact age for cards: "12m", "3h", "5d". */
export function age(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function duration(start: number | null, end: number | null, now = Date.now()): string {
  if (!start) return "";
  return elapsed((end ?? now) - start);
}

/** "45s", "3m 20s", "2h 5m". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A moment ahead, as a clock reads it: "2:40 PM" today, "Sat 2:40 PM" this week, else "Sep 14, 2:40 PM". */
export function clockTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  if (at > now && at - now < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

/** A run's working time across every round it went through. */
export function runDuration(run: Parameters<typeof workedMs>[0], now = Date.now()): string {
  const ms = workedMs(run, now);
  return ms === null ? "" : elapsed(ms);
}

/** "12.3k in · 450 out · $0.03 est." */
export function usageSummary(usage: Record<string, unknown> | null | undefined): string {
  if (!usage) return "";
  const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : undefined);
  const parts: string[] = [];
  const input = num("inputTokens");
  const output = num("outputTokens");
  if (input !== undefined) parts.push(`${compact(input)} in`);
  if (output !== undefined) parts.push(`${compact(output)} out`);
  const cost = usageCost(usage);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

/** "$1.66 est.", or "" when the run reported no cost. */
export function usageCost(usage: Record<string, unknown> | null | undefined): string {
  const cost = usage?.costUsd;
  if (typeof cost !== "number" || !cost) return "";
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}${usage?.estimated ? " est." : ""}`;
}

export function truncateText(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

/** "1 stage", "3 stages". */
export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
