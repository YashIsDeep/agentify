import { randomUUID } from "node:crypto";
import { CHAIN_TRIGGERS, type CompletionMode, PHASE_TRIGGERS, type Trigger } from "@wm/shared";
import { count, eq } from "drizzle-orm";
import type { Db, Sqlite } from "../db/client";
import * as s from "../db/schema";

export interface SeedBinding {
  key: string;
  label: string;
  trigger: Trigger;
  /** Phase name within the same stage (phase.* triggers, or to tie manual/stage actions to a phase). */
  phase?: string;
  /** Binding key whose run completion fires this one (action.* triggers). */
  after?: string;
  actionType: string;
  /** Strings of the form "@stage:<name>" resolve to that stage's id. */
  config: Record<string, unknown>;
  enabled?: boolean;
  askFeedback?: boolean;
}

export interface SeedStage {
  name: string;
  wipLimit?: number;
  phases?: { name: string; completion: CompletionMode }[];
  bindings?: SeedBinding[];
}

export interface SeedWorkflow {
  name: string;
  description: string;
  stages: SeedStage[];
}

const STAGE_REF = "@stage:";

export function insertWorkflow(db: Db, def: SeedWorkflow, createdAt = Date.now()): string {
  const workflowId = randomUUID();
  db.insert(s.workflows)
    .values({ id: workflowId, name: def.name, description: def.description, createdAt, updatedAt: createdAt })
    .run();

  const stageIds = new Map<string, string>();
  const phaseIds = new Map<string, string>();
  const bindingIds = new Map<string, string>();

  def.stages.forEach((stage, position) => {
    if (stageIds.has(stage.name)) throw new Error(`${def.name}: duplicate stage "${stage.name}"`);
    const stageId = randomUUID();
    stageIds.set(stage.name, stageId);
    db.insert(s.stages)
      .values({ id: stageId, workflowId, name: stage.name, position, wipLimit: stage.wipLimit ?? null })
      .run();
    (stage.phases ?? []).forEach((phase, phasePosition) => {
      const phaseId = randomUUID();
      phaseIds.set(`${stage.name}/${phase.name}`, phaseId);
      db.insert(s.phases)
        .values({ id: phaseId, stageId, name: phase.name, position: phasePosition, completion: phase.completion })
        .run();
    });
    for (const binding of stage.bindings ?? []) {
      if (bindingIds.has(binding.key)) throw new Error(`${def.name}: duplicate binding key "${binding.key}"`);
      bindingIds.set(binding.key, randomUUID());
    }
  });

  const resolveStageRefs = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith(STAGE_REF)) {
      const id = stageIds.get(value.slice(STAGE_REF.length));
      if (!id) throw new Error(`${def.name}: unknown stage reference "${value}"`);
      return id;
    }
    if (Array.isArray(value)) return value.map(resolveStageRefs);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveStageRefs(item)]));
    }
    return value;
  };

  const chains: { id: string; afterBindingId: string }[] = [];
  for (const stage of def.stages) {
    (stage.bindings ?? []).forEach((binding, position) => {
      const where = `${def.name}/${stage.name}/${binding.key}`;
      const phaseId = binding.phase ? phaseIds.get(`${stage.name}/${binding.phase}`) : undefined;
      if (binding.phase && !phaseId) throw new Error(`${where}: unknown phase "${binding.phase}"`);
      if (PHASE_TRIGGERS.includes(binding.trigger) && !phaseId) throw new Error(`${where}: ${binding.trigger} needs a phase`);
      const id = bindingIds.get(binding.key)!;
      if (CHAIN_TRIGGERS.includes(binding.trigger)) {
        const afterBindingId = binding.after ? bindingIds.get(binding.after) : undefined;
        if (!afterBindingId) throw new Error(`${where}: ${binding.trigger} needs a valid "after" binding`);
        chains.push({ id, afterBindingId });
      }
      db.insert(s.actionBindings)
        .values({
          id,
          workflowId,
          stageId: stageIds.get(stage.name)!,
          phaseId: phaseId ?? null,
          key: binding.key,
          label: binding.label,
          trigger: binding.trigger,
          actionType: binding.actionType,
          config: resolveStageRefs(binding.config) as Record<string, unknown>,
          enabled: binding.enabled ?? true,
          askFeedback: binding.askFeedback ?? false,
          position,
        })
        .run();
    });
  }
  // Chains may point at bindings inserted later, so link them once every binding exists.
  for (const chain of chains) {
    db.update(s.actionBindings).set({ afterBindingId: chain.afterBindingId }).where(eq(s.actionBindings.id, chain.id)).run();
  }
  return workflowId;
}

/** Seeds the default templates into an empty database. Returns false if workflows already exist. */
export function seedDefaultWorkflows(db: Db, sqlite: Sqlite): boolean {
  const existing = db.select({ n: count() }).from(s.workflows).get()?.n ?? 0;
  if (existing > 0) return false;
  const base = Date.now();
  sqlite.transaction(() => {
    DEFAULT_WORKFLOWS.forEach((workflow, index) => insertWorkflow(db, workflow, base + index));
  })();
  return true;
}

// ---------------------------------------------------------------- default templates

const codingAgent = (config: {
  autonomy: "read-only" | "autonomous";
  prompt: string;
  continueSession?: boolean;
  saveResultAs?: string;
}) => ({ agent: "claude", model: "", continueSession: false, saveResultAs: "", ...config });

const worktree = (key: string, phase: string): SeedBinding => ({
  key,
  label: "Ensure worktree",
  trigger: "phase.started",
  phase,
  actionType: "ensure-worktree",
  config: { branchPrefix: "wm/" },
});

const next = (key: string): SeedBinding => ({
  key,
  label: "Move to next stage",
  trigger: "stage.completed",
  actionType: "move-stage",
  config: { target: "next" },
});

const sendBack = (to: string): SeedBinding => ({
  key: "sendBack",
  label: "Send back",
  trigger: "manual",
  actionType: "move-stage",
  config: { target: `${STAGE_REF}${to}` },
  askFeedback: true,
});

/**
 * Integration bindings ship switched off: they need a connection, and the template editor
 * refuses to enable one without it. They are here so the shape is obvious to copy.
 */
const jira = (key: string, label: string, status: string, trigger: Trigger, phase?: string): SeedBinding => ({
  key,
  label,
  trigger,
  phase,
  actionType: "jira-transition",
  config: { connectionId: "", issue: "{{task.links.jira}}", transition: status, comment: "" },
  enabled: false,
});

const submitMr = (): SeedStage => ({
  name: "Submit MR",
  phases: [
    { name: "Open MR", completion: "auto" },
    { name: "Merged", completion: "manual" },
  ],
  bindings: [
    {
      key: "openMr",
      label: "Push & open MR",
      trigger: "phase.started",
      phase: "Open MR",
      actionType: "open-merge-request",
      config: {
        remote: "origin",
        host: "auto",
        title: "{{task.title}}",
        description: "{{task.description}}",
        commitMessage: "{{task.title}}",
        draft: false,
      },
    },
    jira("jiraInReview", "Jira → In Review", "In Review", "phase.started", "Open MR"),
    {
      key: "submitArchive",
      label: "Archive task",
      trigger: "stage.completed",
      actionType: "archive-task",
      config: { removeWorktree: true, force: false },
    },
  ],
});

const FEEDBACK_BLOCK = `Reviewer feedback from a previous attempt (empty if none):
{{task.lastFeedback}}`;

export const DEFAULT_WORKFLOWS: SeedWorkflow[] = [
  {
    name: "Feature",
    description: "Requirements → implementation → review → test → merge request.",
    stages: [
      { name: "Backlog" },
      { name: "To Pick" },
      {
        name: "Solidify Reqs",
        phases: [
          { name: "Draft requirements", completion: "auto" },
          { name: "Approve requirements", completion: "manual" },
        ],
        bindings: [
          worktree("solidifyWorktree", "Draft requirements"),
          {
            key: "draftRequirements",
            label: "Draft requirements",
            trigger: "phase.started",
            phase: "Draft requirements",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "read-only",
              saveResultAs: "requirements.md",
              prompt: `You are solidifying requirements for a software task. Do not modify any files.

Task: {{task.title}}

{{task.description}}

${FEEDBACK_BLOCK}

Explore the repository as needed, then reply with only a Markdown requirements document containing:
## Goal
## Scope (in / out)
## Functional requirements (numbered, testable)
## Edge cases
## Open questions`,
            }),
          },
          next("solidifyNext"),
        ],
      },
      {
        name: "Implement Reqs",
        phases: [
          { name: "Implement", completion: "auto" },
          { name: "Self-check", completion: "manual" },
        ],
        bindings: [
          jira("jiraInProgress", "Jira → In Progress", "In Progress", "stage.entered"),
          worktree("implementWorktree", "Implement"),
          {
            key: "implement",
            label: "Implement",
            trigger: "phase.started",
            phase: "Implement",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "autonomous",
              continueSession: true,
              prompt: `Implement the following task in this repository.

Task: {{task.title}}

Requirements:
{{artifacts["requirements.md"]}}

${FEEDBACK_BLOCK}

Keep changes focused, run the relevant tests, and commit your work with a clear message.
Finish with a short summary of what changed.`,
            }),
          },
          next("implementNext"),
        ],
      },
      {
        name: "Review Imp",
        phases: [{ name: "Review diff", completion: "manual" }],
        bindings: [sendBack("Implement Reqs"), next("reviewNext")],
      },
      {
        name: "Test Imp",
        phases: [
          { name: "Run tests", completion: "auto" },
          { name: "Manual QA", completion: "manual" },
        ],
        bindings: [
          {
            key: "runTests",
            label: "Run tests",
            trigger: "phase.started",
            phase: "Run tests",
            actionType: "shell",
            config: {
              command: 'echo No test command configured. Edit the "Run tests" action for this workflow.',
              cwd: "worktree",
            },
          },
          next("testNext"),
        ],
      },
      submitMr(),
    ],
  },
  {
    name: "Bugfix",
    description: "Reproduce → fix → review → merge request.",
    stages: [
      { name: "Backlog" },
      {
        name: "Reproduce",
        phases: [
          { name: "Investigate", completion: "auto" },
          { name: "Confirm reproduction", completion: "manual" },
        ],
        bindings: [
          worktree("reproduceWorktree", "Investigate"),
          {
            key: "investigate",
            label: "Investigate",
            trigger: "phase.started",
            phase: "Investigate",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "read-only",
              saveResultAs: "reproduction.md",
              prompt: `Investigate this bug. Do not modify any files.

Bug: {{task.title}}

{{task.description}}

Reply with only a Markdown report: reproduction steps, expected vs actual behaviour, likely root cause (with file references), and a proposed fix.`,
            }),
          },
          next("reproduceNext"),
        ],
      },
      {
        name: "Fix",
        phases: [
          { name: "Fix", completion: "auto" },
          { name: "Self-check", completion: "manual" },
        ],
        bindings: [
          {
            key: "linearInProgress",
            label: "Linear → In Progress",
            trigger: "stage.entered",
            actionType: "linear-update",
            config: { connectionId: "", issue: "{{task.links.linear}}", state: "In Progress", comment: "" },
            enabled: false,
          },
          worktree("fixWorktree", "Fix"),
          {
            key: "fix",
            label: "Fix",
            trigger: "phase.started",
            phase: "Fix",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "autonomous",
              continueSession: true,
              prompt: `Fix this bug in the repository.

Bug: {{task.title}}

Investigation:
{{artifacts["reproduction.md"]}}

${FEEDBACK_BLOCK}

Add a regression test, keep the change minimal, and commit with a clear message. Finish with a short summary.`,
            }),
          },
          next("fixNext"),
        ],
      },
      {
        name: "Review",
        phases: [{ name: "Review diff", completion: "manual" }],
        bindings: [sendBack("Fix"), next("reviewNext")],
      },
      submitMr(),
    ],
  },
  {
    name: "Spike",
    description: "Research a question and write it up.",
    stages: [
      { name: "Backlog" },
      {
        name: "Research",
        phases: [
          { name: "Research", completion: "auto" },
          { name: "Review findings", completion: "manual" },
        ],
        bindings: [
          worktree("researchWorktree", "Research"),
          {
            key: "research",
            label: "Research",
            trigger: "phase.started",
            phase: "Research",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "read-only",
              saveResultAs: "findings.md",
              prompt: `Research the following question. Do not modify any files.

Question: {{task.title}}

{{task.description}}

Reply with only a Markdown write-up: summary, options considered with trade-offs, recommendation, and open questions.`,
            }),
          },
          next("researchNext"),
        ],
      },
      {
        name: "Write-up",
        phases: [{ name: "Write up", completion: "manual" }],
        bindings: [
          {
            key: "notionWriteup",
            label: "Publish findings to Notion",
            trigger: "manual",
            actionType: "notion-append",
            config: {
              connectionId: "",
              mode: "create-page",
              target: "",
              title: "{{task.title}}",
              content: '{{artifacts["findings.md"]}}',
            },
            enabled: false,
          },
          {
            key: "writeupArchive",
            label: "Archive task",
            trigger: "stage.completed",
            actionType: "archive-task",
            config: { removeWorktree: true, force: false },
          },
        ],
      },
    ],
  },
];
