import { describe, expect, it } from "vitest";
import { diffLineClass, splitPatch } from "./diff";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 83db48f..83f2f73 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/notes.md b/docs/notes.md",
  "similarity index 90%",
  "rename from notes.md",
  "rename to docs/notes.md",
].join("\n");

describe("diff", () => {
  it("splits a patch by the file its hunks belong to", () => {
    const byPath = splitPatch(PATCH);
    // A rename is keyed by where the file ended up, as the file list is.
    expect([...byPath.keys()]).toEqual(["src/app.ts", "docs/notes.md"]);
    expect(byPath.get("src/app.ts")).toContain("+new");
    expect(byPath.get("src/app.ts")).not.toContain("rename from");
  });

  it("has nothing to split when nothing changed", () => {
    expect(splitPatch("").size).toBe(0);
  });

  it("colours added and removed lines, but not the file headers", () => {
    expect(diffLineClass("+new")).toBe("diff-line-add");
    expect(diffLineClass("-old")).toBe("diff-line-del");
    expect(diffLineClass("@@ -1,2 +1,2 @@")).toBe("diff-line-hunk");
    expect(diffLineClass("+++ b/src/app.ts")).toBe("");
    expect(diffLineClass("--- a/src/app.ts")).toBe("");
    expect(diffLineClass(" keep")).toBe("");
  });
});
