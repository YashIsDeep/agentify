import { describe, expect, it } from "vitest";
import { randomUuid } from "./insecure-context";

describe("randomUuid", () => {
  it("makes version 4 UUIDs, different every time", () => {
    const ids = new Set(Array.from({ length: 200 }, randomUuid));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
