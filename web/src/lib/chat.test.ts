import type { RunLogLine } from "@wm/shared";
import { describe, expect, it } from "vitest";
import { toChatItems } from "./chat";

let clock = 0;
const line = (entry: Omit<RunLogLine, "at">): RunLogLine => ({ at: (clock += 1000), ...entry });

describe("grouping a transcript into a chat", () => {
  it("pairs a tool result with the call it answers, by id", () => {
    const items = toChatItems([
      line({ kind: "tool", stream: "info", text: "src/a.ts", tool: "Read", ref: "t1" }),
      line({ kind: "tool", stream: "info", text: "src/b.ts", tool: "Read", ref: "t2" }),
      // Out of order on purpose: agents interleave calls, so the id has to decide, not position.
      line({ kind: "tool-result", stream: "info", text: "42 lines", tool: "Read", ref: "t2", ok: true }),
      line({ kind: "tool-result", stream: "stderr", text: "no such file", tool: "Read", ref: "t1", ok: false }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "tool", detail: "src/a.ts", result: { ok: false, detail: "no such file" } });
    expect(items[1]).toMatchObject({ kind: "tool", detail: "src/b.ts", result: { ok: true, detail: "42 lines" } });
  });

  it("falls back to the last unanswered call of the same tool when the CLI gives no id", () => {
    const items = toChatItems([
      line({ kind: "tool", stream: "info", text: "npm test", tool: "shell" }),
      line({ kind: "tool-result", stream: "info", text: "exit 0", tool: "shell", ok: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tool: "shell", result: { ok: true } });
  });

  it("keeps an orphan result visible rather than dropping it", () => {
    const items = toChatItems([line({ kind: "tool-result", stream: "info", text: "exit 0", tool: "shell", ok: true })]);
    expect(items).toMatchObject([{ kind: "tool", tool: "shell", detail: "", result: { ok: true } }]);
  });

  it("keeps the prompt as its own item rather than as an info notice", () => {
    const items = toChatItems([line({ kind: "prompt", stream: "info", text: "Implement Widget\n\nRequirements:\n" })]);
    expect(items).toMatchObject([{ kind: "prompt", text: "Implement Widget\n\nRequirements:\n" }]);
  });

  it("keeps a multi-line message whole instead of splitting it into lines", () => {
    const items = toChatItems([line({ kind: "message", stream: "stdout", text: "One\n\nTwo" })]);
    expect(items).toMatchObject([{ kind: "message", text: "One\n\nTwo" }]);
  });

  it("shows the question and the answer as turns in the conversation", () => {
    const items = toChatItems([
      line({ kind: "question", stream: "info", text: "Which database? (Postgres / SQLite)" }),
      line({ kind: "answer", stream: "info", text: "Which database? → Postgres" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["question", "answer"]);
  });

  it("coalesces unstructured output from plain actions, and treats info lines as notices", () => {
    const items = toChatItems([
      line({ stream: "info", text: "Running npm test" }),
      line({ stream: "stdout", text: "PASS a" }),
      line({ stream: "stdout", text: "PASS b" }),
      line({ stream: "stderr", text: "warning" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "notice", text: "Running npm test", error: false });
    expect(items[1]).toMatchObject({ kind: "output" });
    expect(items[1]?.kind === "output" && items[1].lines).toHaveLength(3);
  });

  it("hides the ask tool's call, which the question and answer turns already show", () => {
    const items = toChatItems([
      line({ kind: "tool", stream: "info", text: "", tool: "mcp__workflow__ask_user", ref: "t9" }),
      line({ kind: "question", stream: "info", text: "Which database?" }),
      line({ kind: "answer", stream: "info", text: "Which database? → SQLite" }),
      line({ kind: "tool-result", stream: "info", text: "SQLite", tool: "mcp__workflow__ask_user", ref: "t9", ok: true }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["question", "answer"]);
  });

  it("says so when a question ended without an answer, rather than hiding it with the call", () => {
    const items = toChatItems([
      line({ kind: "tool", stream: "info", text: "", tool: "mcp__workflow__ask_user", ref: "t9" }),
      line({ kind: "question", stream: "info", text: "Which database?" }),
      line({
        kind: "tool-result",
        stream: "stderr",
        text: "The operation timed out.",
        tool: "mcp__workflow__ask_user",
        ref: "t9",
        ok: false,
      }),
    ]);
    expect(items).toMatchObject([
      { kind: "question" },
      { kind: "notice", error: true, text: "The question ended without an answer: The operation timed out." },
    ]);
  });
});
