import { describe, expect, it } from "vitest";
import { artifactLabel, sortedArtifacts } from "./artifacts";

describe("artifact history presentation", () => {
  it("orders numbered builds and their reviews together after current files", () => {
    const names = [".history/plan.md/V10.md", ".history/plan.md/B2.md", ".history/plan.md/V1.md", "plan.md", ".history/plan.md/B1.md", ".history/plan.md/B10.md", ".history/plan.md/V2.md"];
    const sorted = sortedArtifacts(names.map((name) => ({ name, size: 1, modifiedAt: 1 })));
    expect(sorted.map(artifactLabel)).toEqual(["plan.md", "plan B1", "plan Review V1", "plan B2", "plan Review V2", "plan B10", "plan Review V10"]);
    expect(artifactLabel({ name: ".history/design/spec.txt/B3.txt" })).toBe("design/spec B3");
    expect(artifactLabel({ name: "notes.md" })).toBe("notes.md");
  });
});
