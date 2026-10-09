import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactHistory } from "../src/services/artifact-history";
import { runReview } from "../src/agents/review";
import { removeDir } from "./helpers";
import { limited, loopInput, reply, scriptedTurns } from "./scripted-turns";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wm-history-")); });
afterEach(() => removeDir(root));
const read = (name: string) => readFileSync(join(root, name), "utf8");
const approved = () => reply('{"decision":"approved","feedback":""}', "reviewer");
const changes = () => reply('{"decision":"changes_requested","feedback":"Add rollback"}', "reviewer");
const files = () => readdirSync(join(root, ".history", "plan.md")).sort();

describe("versioned build–verify artifacts", () => {
  it("saves each build and paired review before continuing, and only publishes accepted work", async () => {
    const history = artifactHistory(root, "plan.md");
    const turns = scriptedTurns(reply("Original"), () => {
      expect(read(".history/plan.md/B1.md")).toBe("Original");
      expect(existsSync(join(root, "plan.md"))).toBe(false);
      return changes();
    }, () => {
      expect(read(".history/plan.md/V1.md")).toContain("Add rollback");
      return reply("Revised");
    }, approved());
    const result = await runReview(loopInput(turns, { history, verificationInstructions: "Rollback must be covered" }), true);
    expect(result.ok).toBe(true);
    history.publish(result.text);
    expect(files()).toEqual(["B1.md", "B2.md", "V1.md", "V2.md"]);
    expect(read(".history/plan.md/B1.md")).toBe("Original");
    expect(read(".history/plan.md/B2.md")).toBe("Revised");
    expect(read(".history/plan.md/V2.md")).toContain("Result: Clean");
    expect(read("plan.md")).toBe("Revised");
    for (const turn of turns.calls.slice(1)) expect(turn.prompt).toContain("Rollback must be covered");
  });

  it.each(["review", "revise"])("resumes an interrupted %s without duplicating builds or reviews", async (phase) => {
    const history = artifactHistory(root, "plan.md");
    const pending = await runReview(loopInput(scriptedTurns(reply("Original"), ...(phase === "revise" ? [changes()] : []), limited("paused")), { history }), true);
    expect(pending.saved).toMatchObject({ phase, draft: { version: 1 } });
    const resumed = await runReview(loopInput(scriptedTurns(...(phase === "revise" ? [reply("Revised")] : []), approved()), {
      history: artifactHistory(root, "plan.md"), saved: JSON.parse(JSON.stringify(pending.saved)),
    }), true);
    expect(resumed.ok).toBe(true);
    expect(files()).toEqual(phase === "revise" ? ["B1.md", "B2.md", "V1.md", "V2.md"] : ["B1.md", "V1.md"]);
  });

  it("retains the previous accepted result and failed builds at the correction limit", async () => {
    writeFileSync(join(root, "plan.md"), "Previously accepted");
    const result = await runReview(loopInput(scriptedTurns(reply("Draft"), changes(), reply("Still incomplete"), changes()), {
      history: artifactHistory(root, "plan.md"), maxCorrections: 1,
    }), true);
    expect(result.ok).toBe(false);
    expect(files()).toEqual(["B1.md", "B2.md", "B3.md", "V2.md", "V3.md"]);
    expect(read(".history/plan.md/B1.md")).toBe("Previously accepted");
    expect(read(".history/plan.md/V3.md")).toContain("Changes requested");
    expect(read("plan.md")).toBe("Previously accepted");
  });

  it("keeps malformed review responses without presenting them as clean", async () => {
    const result = await runReview(loopInput(scriptedTurns(reply("Draft"), reply("Not JSON", "reviewer"), reply("Still not JSON", "reviewer")), {
      history: artifactHistory(root, "plan.md"),
    }), true);
    expect(result.ok).toBe(false);
    expect(read(".history/plan.md/V1.md")).toContain("Result: Invalid review");
    expect(read(".history/plan.md/V1.md")).toContain("Still not JSON");
    expect(existsSync(join(root, "plan.md"))).toBe(false);
  });

  it("continues numbering across new runs and refuses to overwrite a review", async () => {
    for (const text of ["First", "Second"]) {
      const history = artifactHistory(root, "plan.md");
      const result = await runReview(loopInput(scriptedTurns(reply(text), approved()), { history }), true);
      history.publish(result.text);
    }
    expect(files()).toEqual(["B1.md", "B2.md", "V1.md", "V2.md"]);
    expect(read(".history/plan.md/B1.md")).toBe("First");
    expect(read("plan.md")).toBe("Second");
    const history = artifactHistory(root, "plan.md");
    expect(() => history.verify(1, { decision: "approved", feedback: "replacement", raw: "replacement" })).toThrow();
    expect(read(".history/plan.md/V1.md")).not.toContain("replacement");
  });

  it("keeps nested artifact names distinct and blocks writes into history", () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "notes.txt"), "Old");
    const history = artifactHistory(root, "nested/notes.txt");
    expect(history.build("New")).toBe(2);
    history.publish("New");
    expect(read(".history/nested/notes.txt/B1.txt")).toBe("Old");
    expect(read(".history/nested/notes.txt/B2.txt")).toBe("New");
    expect(() => artifactHistory(root, "../outside.md")).toThrow();
    expect(() => artifactHistory(root, ".history/plan.md/B1.md")).toThrow();
  });
});
