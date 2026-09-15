import { randomUUID } from "node:crypto";
import type { SaveWorkflowInput, WorkflowDef } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, removeDir } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

/** The editor sends the whole template back; this mirrors what its draft looks like. */
function draft(workflow: WorkflowDef): SaveWorkflowInput {
  return {
    name: workflow.name,
    description: workflow.description,
    updatedAt: workflow.updatedAt,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      wipLimit: stage.wipLimit,
      phases: stage.phases.map(({ id, name, completion }) => ({ id, name, completion })),
      bindings: stage.bindings.map((binding) => ({
        id: binding.id,
        key: binding.key,
        label: binding.label,
        trigger: binding.trigger,
        phaseId: binding.phaseId,
        afterBindingId: binding.afterBindingId,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        askFeedback: binding.askFeedback,
      })),
    })),
  };
}

const feature = () => h.engine.listWorkflows().find((w) => w.name === "Feature")!;
const spike = () => h.engine.listWorkflows().find((w) => w.name === "Spike")!;
const save = (workflow: WorkflowDef, edit: (input: SaveWorkflowInput) => void) => {
  const input = draft(workflow);
  edit(input);
  return h.templates.save(workflow.id, input);
};

describe("action catalogue", () => {
  it("publishes editable fields whose defaults satisfy each action's schema", () => {
    const types = h.templates.actionTypes();
    expect(types.map((type) => type.type)).toContain("coding-agent");

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

describe("editing a template", () => {
  it("renames, reorders and adds a stage in one save", async () => {
    const before = feature();
    const saved = await save(before, (input) => {
      input.stages[0]!.name = "Inbox";
      input.stages.push({ id: randomUUID(), name: "Done", wipLimit: null, phases: [], bindings: [] });
      const [first, second, ...rest] = input.stages;
      input.stages = [second!, first!, ...rest];
    });

    expect(saved.stages.map((stage) => stage.name)).toEqual(["To Pick", "Inbox", "Solidify Reqs", "Implement Reqs", "Review Imp", "Test Imp", "Submit MR", "Done"]);
    expect(saved.stages.map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("adds a phase and an action that references it", async () => {
    const phaseId = randomUUID();
    const bindingId = randomUUID();
    const saved = await save(spike(), (input) => {
      const stage = input.stages.find((candidate) => candidate.name === "Write-up")!;
      stage.phases = [...(stage.phases ?? []), { id: phaseId, name: "Publish", completion: "auto" }];
      stage.bindings = [
        ...(stage.bindings ?? []),
        {
          id: bindingId,
          key: "publishNotes",
          label: "Publish notes",
          trigger: "phase.started",
          phaseId,
          afterBindingId: null,
          actionType: "write-artifact",
          config: { name: "notes.md", content: "{{task.title}}" },
          enabled: true,
          askFeedback: false,
        },
      ];
    });

    const stage = saved.stages.find((candidate) => candidate.name === "Write-up")!;
    expect(stage.phases.map((phase) => phase.name)).toContain("Publish");
    expect(stage.bindings.find((binding) => binding.id === bindingId)?.phaseId).toBe(phaseId);
  });

  it("fills in config defaults and drops unknown keys", async () => {
    const saved = await save(spike(), (input) => {
      const stage = input.stages[0]!;
      stage.bindings = [
        {
          id: randomUUID(),
          key: "note",
          label: "Note",
          trigger: "stage.entered",
          phaseId: null,
          afterBindingId: null,
          actionType: "shell",
          config: { command: "echo hi", bogus: "dropped" },
          enabled: true,
          askFeedback: false,
        },
      ];
    });

    expect(saved.stages[0]!.bindings[0]!.config).toEqual({ command: "echo hi", shell: "default", cwd: "worktree", extract: {} });
  });

  it("deletes a phase without disturbing a task already in that stage", async () => {
    const workflow = spike();
    const research = workflow.stages.find((stage) => stage.name === "Research")!;
    const task = h.engine.createTask({ workflowId: workflow.id, title: "In flight", stageId: research.id });
    const phasesAtEntry = h.engine.getTaskDetail(task.id).visits.at(-1)!.phases.map((phase) => phase.name);

    await save(spike(), (input) => {
      const stage = input.stages.find((candidate) => candidate.name === "Research")!;
      stage.phases = stage.phases!.slice(0, 1);
    });

    // Phase states are snapshots taken at entry, so the running task is untouched.
    expect(h.engine.getTaskDetail(task.id).visits.at(-1)!.phases.map((phase) => phase.name)).toEqual(phasesAtEntry);
    expect(spike().stages.find((stage) => stage.name === "Research")!.phases).toHaveLength(1);
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

  it("rejects duplicate keys, unknown actions, invalid config and dangling references", async () => {
    const bad = (edit: (input: SaveWorkflowInput) => void) => save(feature(), edit);
    const firstBinding = (input: SaveWorkflowInput) => input.stages.flatMap((stage) => stage.bindings ?? [])[0]!;

    await expect(bad((input) => (firstBinding(input).key = "openMr"))).rejects.toThrow(/Duplicate action key/);
    await expect(bad((input) => (firstBinding(input).actionType = "teleport"))).rejects.toThrow(/unknown action type/);
    await expect(bad((input) => (firstBinding(input).phaseId = randomUUID()))).rejects.toThrow(/phase is not in this stage/);
    await expect(bad((input) => (firstBinding(input).trigger = "action.succeeded"))).rejects.toThrow(/needs an action to follow/);
    await expect(
      bad((input) => {
        const agent = input.stages.flatMap((stage) => stage.bindings ?? []).find((binding) => binding.actionType === "coding-agent")!;
        agent.config = {};
      }),
    ).rejects.toThrow(/prompt/);
  });

  it("rejects a move-stage target that is not in the template", async () => {
    await expect(
      save(feature(), (input) => {
        const move = input.stages.flatMap((stage) => stage.bindings ?? []).find((binding) => binding.actionType === "move-stage")!;
        move.config = { target: randomUUID() };
      }),
    ).rejects.toThrow(/destination stage is not part of this template/);
  });

  it("rejects actions that trigger each other in a loop", async () => {
    await expect(
      save(feature(), (input) => {
        const stage = input.stages.find((candidate) => candidate.name === "Solidify Reqs")!;
        const [a, b] = stage.bindings!;
        a!.trigger = "action.succeeded";
        a!.afterBindingId = b!.id;
        b!.trigger = "action.failed";
        b!.afterBindingId = a!.id;
      }),
    ).rejects.toThrow(/loop/);
  });

  it("rejects a model the chosen agent does not accept", async () => {
    const setModel = (input: SaveWorkflowInput, agent: string, model: string) => {
      const binding = input.stages.flatMap((stage) => stage.bindings ?? []).find((b) => b.actionType === "coding-agent")!;
      binding.config = { ...binding.config, agent, model };
    };

    // The exact mistake that used to surface only once the agent ran.
    await expect(save(feature(), (input) => setModel(input, "claude", "opus-5"))).rejects.toThrow(/not a Claude Code model/);
    await expect(save(feature(), (input) => setModel(input, "claude", "gpt-5"))).rejects.toThrow(/not a Claude Code model/);

    // Aliases, full model names and "blank means the CLI default" all stay valid.
    await expect(save(feature(), (input) => setModel(input, "claude", "opus"))).resolves.toBeDefined();
    await expect(save(feature(), (input) => setModel(input, "claude", "claude-opus-5"))).resolves.toBeDefined();
    await expect(save(feature(), (input) => setModel(input, "claude", ""))).resolves.toBeDefined();
  });

  it("lets an integration action sit unconfigured while it is switched off", async () => {
    // The seeded Jira bindings ship disabled; saving them untouched must not need a connection.
    await expect(save(feature(), () => {})).resolves.toBeDefined();

    const enable = (input: SaveWorkflowInput, connectionId: string) => {
      const binding = input.stages.flatMap((stage) => stage.bindings ?? []).find((b) => b.actionType === "jira-transition")!;
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

  it("refuses a save based on a stale copy of the template", async () => {
    const workflow = feature();
    const stale = draft(workflow);
    await save(workflow, (input) => (input.name = "Feature v2"));
    stale.name = "Feature v3";
    await expect(h.templates.save(workflow.id, stale)).rejects.toThrow(/changed in another window/);
  });
});

describe("creating and deleting templates", () => {
  it("creates a blank template with one stage", () => {
    const created = h.templates.create({ name: "Chores" });
    expect(created.stages.map((stage) => stage.name)).toEqual(["Backlog"]);
    expect(h.engine.listWorkflows().map((workflow) => workflow.name)).toContain("Chores");
  });

  it("duplicates a template with fresh ids and remapped references", () => {
    const source = feature();
    const copy = h.templates.create({ name: "Feature copy", copyFromWorkflowId: source.id });

    expect(copy.id).not.toBe(source.id);
    expect(copy.stages.map((stage) => stage.name)).toEqual(source.stages.map((stage) => stage.name));

    const copyStageIds = new Set(copy.stages.map((stage) => stage.id));
    const copyBindingIds = new Set(copy.stages.flatMap((stage) => stage.bindings.map((binding) => binding.id)));
    const sourceIds = new Set([
      ...source.stages.map((stage) => stage.id),
      ...source.stages.flatMap((stage) => [...stage.phases.map((p) => p.id), ...stage.bindings.map((b) => b.id)]),
    ]);

    for (const stage of copy.stages) {
      expect(sourceIds.has(stage.id)).toBe(false);
      for (const binding of stage.bindings) {
        expect(sourceIds.has(binding.id)).toBe(false);
        if (binding.phaseId) expect(stage.phases.map((phase) => phase.id)).toContain(binding.phaseId);
        if (binding.afterBindingId) expect(copyBindingIds).toContain(binding.afterBindingId);
        // "Send back" points at a stage id, which must now be the copy's own stage.
        if (binding.actionType === "move-stage" && binding.config.target !== "next") {
          expect(copyStageIds).toContain(binding.config.target);
        }
      }
    }
  });

  it("deletes an unused template but keeps one that tasks still reference", () => {
    const chores = h.templates.create({ name: "Chores" });
    const task = h.engine.createTask({ workflowId: chores.id, title: "Take out the bins" });

    expect(() => h.templates.remove(chores.id)).toThrow(/1 active task/);

    h.engine.markArchived(task.id, { worktreeRemoved: false });
    expect(() => h.templates.remove(chores.id)).toThrow(/1 archived task/);

    const spare = h.templates.create({ name: "Spare" });
    h.templates.remove(spare.id);
    expect(h.engine.listWorkflows().map((workflow) => workflow.name)).not.toContain("Spare");
  });
});
