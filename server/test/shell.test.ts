import { fileURLToPath } from "node:url";
import type { RunLogLine } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

const ANSI_OUTPUT = fileURLToPath(new URL("./fixtures/ansi-output.mjs", import.meta.url));
const ESCAPE = /\[/;

let h: Harness;
let q: ReturnType<typeof inspect>;

beforeEach(() => {
  h = createHarness();
  q = inspect(h);
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

function shellWorkflow(config: Record<string, unknown> = {}) {
  return h.addWorkflow({
    name: "Test",
    description: "",
    stages: [
      {
        name: "Test",
        bindings: [
          {
            key: "test",
            label: "Run tests",
            actionType: "shell",
            config: { command: `"${process.execPath}" "${ANSI_OUTPUT}"`, cwd: "artifacts", ...config },
          },
        ],
      },
      { name: "Done" },
    ],
  });
}

const logOf = async (runId: number) => (await (await h.app.request(`/api/runs/${runId}/log`)).json()) as RunLogLine[];

describe("shell action output", () => {
  it("logs colourised command output as plain text", async () => {
    const workflowId = shellWorkflow();
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));

    const run = q.latest(task.id, "test");
    const lines = (await logOf(run!.id)).map((line) => line.text ?? "");
    expect(lines.join("\n")).not.toMatch(ESCAPE);
    expect(lines).toContain("✔ a task with no due date is never overdue (0.6907ms)");
    expect(lines).toContain("ℹ pass 10");
    // stderr is stripped too, and still marked as stderr so the log can style it.
    expect(await logOf(run!.id)).toContainEqual(expect.objectContaining({ text: "✖ 1 failing", stream: "stderr" }));
  });

  it("keeps escape codes out of the failure message", async () => {
    const workflowId = shellWorkflow({ command: `"${process.execPath}" "${ANSI_OUTPUT}" fail` });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    const run = await waitFor(() => (q.latest(task.id, "test")?.status === "failed" ? q.latest(task.id, "test") : undefined));

    expect(run.error).not.toMatch(ESCAPE);
    expect(run.error).toContain("✖ 1 failing");
  });

  it("extracts outputs from colourised output", async () => {
    const workflowId = shellWorkflow({ extract: { report: "report: (https?://\\S+)" } });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));

    expect(q.latest(task.id, "test")?.outputs).toEqual({ report: "https://example.test/run/42" });
  });
});
