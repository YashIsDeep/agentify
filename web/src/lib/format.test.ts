import { describe, expect, it } from "vitest";
import { age, cls, duration, fileSize, parseTags, relativeTime, runDuration } from "./format";

describe("format", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);

  it("formats relative times and ages", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(age(now - 30_000, now)).toBe("now");
    expect(age(now - 90 * 60_000, now)).toBe("1h");
    expect(age(now - 50 * 3_600_000, now)).toBe("2d");
  });

  it("formats durations, including still-running ones", () => {
    expect(duration(null, null, now)).toBe("");
    expect(duration(now - 42_000, now)).toBe("42s");
    expect(duration(now - 125_000, null, now)).toBe("2m 5s");
    expect(duration(now - 3_780_000, now)).toBe("1h 3m");
  });

  it("counts every round a run went through", () => {
    const round = { startedAt: now - 30_000, endedAt: now };
    expect(runDuration({ ...round, usage: null }, now)).toBe("30s");
    expect(runDuration({ ...round, usage: { priorMs: 90_000 } }, now)).toBe("2m 0s");
    expect(runDuration({ startedAt: null, endedAt: null, usage: { priorMs: 90_000 } }, now)).toBe("");
  });

  it("formats sizes, tags and class names", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2.0 KB");
    expect(parseTags(" ui, api,, ui ")).toEqual(["ui", "api"]);
    expect(cls("a", false, null, "b")).toBe("a b");
  });
});
