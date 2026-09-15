import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SaveWorkflowInput, WorkflowDef } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approval } from "../src/seed/workflows";
import { createHarness, type Harness, removeDir } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

/** The editor sends the whole workflow back; this mirrors what its draft looks like. */
function draft(workflow: WorkflowDef): SaveWorkflowInput {
  return {
    name: workflow.name,
    description: workflow.description,
    icon: workflow.icon,
    updatedAt: workflow.updatedAt,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      wipLimit: stage.wipLimit,
      agentDefaults: stage.agentDefaults,
      bindings: stage.bindings.map((binding) => ({
        id: binding.id,
        key: binding.key,
        label: binding.label,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        continueOnFailure: binding.continueOnFailure,
      })),
    })),
  };
}

const feature = () => h.engine.listWorkflows().find((w) => w.name === "Feature")!;
// Spike isn't a default workflow any more; these tests only need its stage shape, so it's added on first use.
const spike = () =>
  h.engine.listWorkflows().find((w) => w.name === "Spike") ??
  h.engine.getWorkflow(
    h.addWorkflow({
      name: "Spike",
      description: "Research a question and write it up.",
      stages: [
        { name: "Backlog" },
        { name: "Research", bindings: [approval("reviewFindings", "Review findings")] },
        { name: "Write-up", bindings: [approval("writeUp", "Write up")] },
      ],
    }),
  );
const save = (workflow: WorkflowDef, edit: (input: SaveWorkflowInput) => void) => {
  const input = draft(workflow);
  edit(input);
  return h.workflows.save(workflow.id, input);
};
const allBindings = (input: SaveWorkflowInput) => input.stages.flatMap((stage) => stage.bindings ?? []);

describe("action catalogue", () => {
  it("publishes editable fields whose defaults satisfy each action's schema", () => {
    const types = h.workflows.actionTypes();
    expect(types.map((type) => type.type)).toEqual(expect.arrayContaining(["coding-agent", "approval"]));

    for (const type of types) {
      expect(type.fields.length, `${type.type} has no fields`).toBeGreaterThan(0);
      const definition = h.registry.get(type.type)!;
      const defaults = Object.fromEntries(type.fields.map((field) => [field.name, field.default]));
      // Every field the schema accepts must be offered, and vice versa.
      const parsed = definition.configSchema.safeParse({ ...defaults, ...requiredText(type.type) });
      expect(parsed.success, `${type.type}: ${parsed.error?.message}`).toBe(true);
    }
  });
});

/** Fields the schema requires but that start blank in the editor. */
function requiredText(type: string): Record<string, string> {
  return { "coding-agent": { prompt: "x" }, shell: { command: "x" }, "write-artifact": { name: "x" }, "open-merge-request": { title: "x" } }[
    type
  ] ?? {};
}

describe("stage coding-agent defaults", () => {
  it("saves, validates and copies each stage's defaults", async () => {
    const setDefaults = (input: SaveWorkflowInput, agentDefaults: { agent: "claude" | "codex" | null; model: string | null; effort: string | null }) => {
      input.stages[0]!.agentDefaults = agentDefaults;
    };

    await expect(save(feature(), (input) => setDefaults(input, { agent: "claude", model: "gpt-5", effort: null }))).rejects.toThrow(
      /coding-agent defaults: .*not a Claude Code model/,
    );
    await expect(save(feature(), (input) => setDefaults(input, { agent: "claude", model: "opus", effort: "turbo" }))).rejects.toThrow(
      /coding-agent defaults: .*not a reasoning-effort level/,
    );

    const saved = await save(feature(), (input) => setDefaults(input, { agent: "claude", model: "opus", effort: "max" }));
    expect(saved.stages[0]!.agentDefaults).toEqual({ agent: "claude", model: "opus", effort: "max" });
    expect(saved.stages[1]!.agentDefaults).toEqual({ agent: null, model: null, effort: null });

    const copy = h.workflows.create({ name: "Feature copy", copyFromWorkflowId: saved.id });
    expect(copy.stages[0]!.agentDefaults).toEqual({ agent: "claude", model: "opus", effort: "max" });
  });

  it("checks an action that leaves its agent blank against the stage's agent", async () => {
    const blankAgent = (input: SaveWorkflowInput, model: string) => {
      const stage = input.stages.find((candidate) => candidate.bindings?.some((b) => b.actionType === "coding-agent"))!;
      stage.agentDefaults = { agent: "claude", model: null, effort: null };
      const binding = stage.bindings!.find((b) => b.actionType === "coding-agent")!;
      binding.config = { ...binding.config, agent: "", model };
    };
    await expect(save(feature(), (input) => blankAgent(input, "gpt-5"))).rejects.toThrow(/not a Claude Code model/);
    await expect(save(feature(), (input) => blankAgent(input, "sonnet"))).resolves.toBeDefined();
  });
});

describe("editing a workflow", () => {
  it("renames, reorders and adds a stage in one save", async () => {
    const before = feature();
    const saved = await save(before, (input) => {
      input.stages[0]!.name = "Inbox";
      input.stages.push({ id: randomUUID(), name: "Done", wipLimit: null, bindings: [] });
      const [first, second, ...rest] = input.stages;
      input.stages = [second!, first!, ...rest];
    });

    expect(saved.stages.map((stage) => stage.name)).toEqual(["To Pick", "Inbox", "Solidify Reqs", "Implement Reqs", "Review Imp", "Test Imp", "Submit MR", "Done"]);
    expect(saved.stages.map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("adds an action and reorders a stage's list", async () => {
    const bindingId = randomUUID();
    const saved = await save(spike(), (input) => {
      const stage = input.stages.find((candidate) => candidate.name === "Write-up")!;
      stage.bindings = [
        {
          id: bindingId,
          key: "publishNotes",
          label: "Publish notes",
          actionType: "write-artifact",
          config: { name: "notes.md", content: "{{task.title}}" },
          continueOnFailure: true,
        },
        ...(stage.bindings ?? []),
      ];
    });

    const stage = saved.stages.find((candidate) => candidate.name === "Write-up")!;
    expect(stage.bindings.map((binding) => binding.key)).toEqual(["publishNotes", "writeUp"]);
    expect(stage.bindings[0]).toMatchObject({ id: bindingId, continueOnFailure: true, enabled: true });

    const reordered = await save(saved, (input) => {
      const writeUp = input.stages.find((candidate) => candidate.name === "Write-up")!;
      writeUp.bindings = [...writeUp.bindings!].reverse();
    });
    expect(reordered.stages.find((candidate) => candidate.name === "Write-up")!.bindings.map((binding) => binding.key)).toEqual([
      "writeUp",
      "publishNotes",
    ]);
  });

  it("fills in config defaults and drops unknown keys", async () => {
    const saved = await save(spike(), (input) => {
      input.stages[0]!.bindings = [
        { id: randomUUID(), key: "note", label: "Note", actionType: "shell", config: { command: "echo hi", bogus: "dropped" } },
      ];
    });

    expect(saved.stages[0]!.bindings[0]).toMatchObject({
      config: { command: "echo hi", shell: "default", cwd: "worktree", extract: {} },
      enabled: true,
      continueOnFailure: false,
    });
  });

  it("edits a stage's actions without disturbing a task already running them", async () => {
    const workflow = spike();
    const research = workflow.stages.find((stage) => stage.name === "Research")!;
    const task = h.engine.createTask({ workflowId: workflow.id, title: "In flight", stageId: research.id });
    const runsAtEntry = h.engine.getTaskDetail(task.id).visits.at(-1)!.runs.map((run) => [run.bindingKey, run.status]);
    expect(runsAtEntry).toEqual([["reviewFindings", "awaiting-approval"]]);

    await save(spike(), (input) => {
      const stage = input.stages.find((candidate) => candidate.name === "Research")!;
      stage.bindings = [{ id: randomUUID(), key: "notes", label: "Notes", actionType: "write-artifact", config: { name: "n.md", content: "" } }];
    });

    // A visit's runs are created when its actions start, so the running task is untouched.
    expect(h.engine.getTaskDetail(task.id).visits.at(-1)!.runs.map((run) => [run.bindingKey, run.status])).toEqual(runsAtEntry);
    expect(spike().stages.find((stage) => stage.name === "Research")!.bindings.map((binding) => binding.key)).toEqual(["notes"]);
  });
});

describe("refusing edits that would strand tasks or actions", () => {
  it("refuses to delete a stage that holds an active task, and allows it once the task moves", async () => {
    const workflow = spike();
    const research = workflow.stages.find((stage) => stage.name === "Research")!;
    const writeUp = workflow.stages.find((stage) => stage.name === "Write-up")!;
    const task = h.engine.createTask({ workflowId: workflow.id, title: "Parked", stageId: research.id });

    const drop = () => save(spike(), (input) => (input.stages = input.stages.filter((stage) => stage.name !== "Research")));
    await expect(drop()).rejects.toThrow(/Move the tasks out of Research \(1\)/);

    h.engine.moveTask(task.id, writeUp.id, { runActions: false });
    expect((await drop()).stages.map((stage) => stage.name)).toEqual(["Backlog", "Write-up"]);
  });

  it("rejects duplicate keys, unknown actions and invalid config", async () => {
    const bad = (edit: (input: SaveWorkflowInput) => void) => save(feature(), edit);

    await expect(bad((input) => (allBindings(input)[0]!.key = "openMr"))).rejects.toThrow(/Duplicate action key/);
    await expect(bad((input) => (allBindings(input)[0]!.actionType = "teleport"))).rejects.toThrow(/unknown action type/);
    await expect(
      bad((input) => {
        allBindings(input).find((binding) => binding.actionType === "coding-agent")!.config = {};
      }),
    ).rejects.toThrow(/prompt/);
  });

  it("rejects a move-stage target or Send back stage that is not in the workflow", async () => {
    await expect(
      save(feature(), (input) => {
        allBindings(input).find((binding) => binding.actionType === "move-stage")!.config = { target: randomUUID() };
      }),
    ).rejects.toThrow(/destination stage is not part of this workflow/);
    await expect(
      save(feature(), (input) => {
        const gate = allBindings(input).find((binding) => binding.actionType === "approval")!;
        gate.config = { ...gate.config, sendBackTo: randomUUID() };
      }),
    ).rejects.toThrow(/stage it sends back to is not part of this workflow/);
  });

  it("rejects a model the chosen agent does not accept", async () => {
    const setModel = (input: SaveWorkflowInput, agent: string, model: string, effort = "") => {
      const binding = allBindings(input).find((b) => b.actionType === "coding-agent")!;
      binding.config = { ...binding.config, agent, model, effort };
    };

    // The exact mistake that used to surface only once the agent ran.
    await expect(save(feature(), (input) => setModel(input, "claude", "opus-5"))).rejects.toThrow(/not a Claude Code model/);
    await expect(save(feature(), (input) => setModel(input, "claude", "gpt-5"))).rejects.toThrow(/not a Claude Code model/);

    // Aliases, full model names and "blank means the CLI default" all stay valid.
    await expect(save(feature(), (input) => setModel(input, "claude", "opus"))).resolves.toBeDefined();
    await expect(save(feature(), (input) => setModel(input, "claude", "claude-opus-5"))).resolves.toBeDefined();
    await expect(save(feature(), (input) => setModel(input, "claude", ""))).resolves.toBeDefined();

    // So does the reasoning effort.
    await expect(save(feature(), (input) => setModel(input, "claude", "opus", "turbo"))).rejects.toThrow(/not a reasoning-effort level/);
    await expect(save(feature(), (input) => setModel(input, "claude", "opus", "max"))).resolves.toBeDefined();
  });

  it("lets an integration action sit unconfigured while it is switched off", async () => {
    // The seeded Jira bindings ship disabled; saving them untouched must not need a connection.
    await expect(save(feature(), () => {})).resolves.toBeDefined();

    const enable = (input: SaveWorkflowInput, connectionId: string) => {
      const binding = allBindings(input).find((b) => b.actionType === "jira-transition")!;
      binding.enabled = true;
      binding.config = { ...binding.config, connectionId };
    };

    await expect(save(feature(), (input) => enable(input, ""))).rejects.toThrow(/choose a jira connection/i);

    const connection = h.connections.create({ name: "Jira", type: "jira", values: { baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t" } });
    await expect(save(feature(), (input) => enable(input, connection.id))).resolves.toBeDefined();

    // Deleting the credential must not leave a live action pointing at nothing.
    h.connections.remove(connection.id);
    await expect(save(feature(), (input) => enable(input, connection.id))).rejects.toThrow(/no longer exists/);
  });

  it("refuses a save based on a stale copy of the workflow", async () => {
    const workflow = feature();
    const stale = draft(workflow);
    await save(workflow, (input) => (input.name = "Feature v2"));
    stale.name = "Feature v3";
    await expect(h.workflows.save(workflow.id, stale)).rejects.toThrow(/changed in another window/);
  });
});

describe("creating and deleting workflows", () => {
  it("creates a blank workflow with one stage", () => {
    const created = h.workflows.create({ name: "Chores" });
    expect(created.stages.map((stage) => stage.name)).toEqual(["Backlog"]);
    expect(h.engine.listWorkflows().map((workflow) => workflow.name)).toContain("Chores");
  });

  it("keeps a workflow's icon, and defaults it to none", async () => {
    const created = h.workflows.create({ name: "Chores", icon: "🧹" });
    expect(created.icon).toBe("🧹");
    expect(h.workflows.create({ name: "Plain" }).icon).toBe("");

    const saved = await save(created, (input) => {
      input.icon = "♻️";
    });
    expect(saved.icon).toBe("♻️");
    expect(h.engine.getWorkflow(created.id).icon).toBe("♻️");
  });

  it("duplicates a workflow with fresh ids and remapped references", () => {
    const source = feature();
    const copy = h.workflows.create({ name: "Feature copy", copyFromWorkflowId: source.id });

    expect(copy.id).not.toBe(source.id);
    expect(copy.stages.map((stage) => stage.name)).toEqual(source.stages.map((stage) => stage.name));
    expect(copy.stages.map((stage) => stage.bindings.map((b) => b.key))).toEqual(source.stages.map((stage) => stage.bindings.map((b) => b.key)));

    const copyStageIds = new Set(copy.stages.map((stage) => stage.id));
    const sourceIds = new Set([...source.stages.map((stage) => stage.id), ...source.stages.flatMap((stage) => stage.bindings.map((b) => b.id))]);

    let sendBacks = 0;
    for (const stage of copy.stages) {
      expect(sourceIds.has(stage.id)).toBe(false);
      for (const binding of stage.bindings) {
        expect(sourceIds.has(binding.id)).toBe(false);
        // Stage ids inside config must now be the copy's own stages.
        if (binding.actionType === "move-stage" && binding.config.target !== "next") {
          expect(copyStageIds).toContain(binding.config.target);
        }
        if (binding.actionType === "approval" && binding.config.sendBackTo) {
          sendBacks++;
          expect(copyStageIds).toContain(binding.config.sendBackTo);
        }
      }
    }
    expect(sendBacks).toBeGreaterThan(0);
  });

  it("deletes an unused workflow but keeps one that tasks still reference", async () => {
    const chores = h.workflows.create({ name: "Chores" });
    const task = h.engine.createTask({ workflowId: chores.id, title: "Take out the bins" });

    await expect(h.workflows.remove(chores.id)).rejects.toThrow(/1 active task/);

    h.engine.markArchived(task.id, { worktreeRemoved: false });
    await expect(h.workflows.remove(chores.id)).rejects.toThrow(/1 archived task/);

    const spare = h.workflows.create({ name: "Spare" });
    await h.workflows.remove(spare.id);
    expect(h.engine.listWorkflows().map((workflow) => workflow.name)).not.toContain("Spare");
  });

  it("force-deletes a workflow together with its tasks and their files", async () => {
    const chores = h.workflows.create({ name: "Chores" });
    const active = h.engine.createTask({ workflowId: chores.id, title: "Active" });
    const archived = h.engine.createTask({ workflowId: chores.id, title: "Archived" });
    h.engine.markArchived(archived.id, { worktreeRemoved: false });
    mkdirSync(h.paths.artifactDir(active.id), { recursive: true });
    writeFileSync(join(h.paths.artifactDir(active.id), "notes.md"), "gone with the task");
    const bystander = h.engine.createTask({ workflowId: feature().id, title: "Elsewhere" });

    await h.workflows.remove(chores.id, { force: true });

    expect(h.engine.listWorkflows().map((workflow) => workflow.name)).not.toContain("Chores");
    expect(h.engine.findTask(active.id)).toBeUndefined();
    expect(h.engine.findTask(archived.id)).toBeUndefined();
    const timeline = h.sqlite
      .prepare("SELECT count(*) AS n FROM timeline_events WHERE task_id IN (?, ?)")
      .get(active.id, archived.id) as { n: number };
    expect(timeline.n).toBe(0);
    expect(existsSync(h.paths.taskDir(active.id))).toBe(false);
    expect(h.engine.findTask(bystander.id)).toBeDefined();
  });
});
