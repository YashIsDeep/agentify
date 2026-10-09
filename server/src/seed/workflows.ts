import { randomUUID } from "node:crypto";
import { type AgentId, APPROVAL_ACTION, LOOP_MODES, type LoopMode } from "@wm/shared";
import { count } from "drizzle-orm";
import { codingAgentAction } from "../actions/coding-agent";
import { defaultConfig } from "../actions/types";
import type { Db, Sqlite } from "../db/client";
import * as s from "../db/schema";

/** One action in a stage's list; the list runs top to bottom. */
export interface SeedBinding {
  key: string;
  label: string;
  actionType: string;
  /** Strings of the form "@stage:<name>" resolve to that stage's id. */
  config: Record<string, unknown>;
  enabled?: boolean;
  continueOnFailure?: boolean;
}

export interface SeedStage {
  name: string;
  wipLimit?: number;
  agentDefaults?: { agent?: AgentId; model?: string; effort?: string };
  stayWhenDone?: boolean;
  bindings?: SeedBinding[];
}

export interface SeedWorkflow {
  name: string;
  description: string;
  /** An emoji for the board and the sidebar. */
  icon?: string;
  stages: SeedStage[];
}

const STAGE_REF = "@stage:";

export function insertWorkflow(db: Db, def: SeedWorkflow, createdAt = Date.now()): string {
  const workflowId = randomUUID();
  db.insert(s.workflows)
    .values({ id: workflowId, name: def.name, description: def.description, icon: def.icon ?? "", createdAt, updatedAt: createdAt })
    .run();

  const stageIds = new Map<string, string>();
  const keys = new Set<string>();

  def.stages.forEach((stage, position) => {
    if (stageIds.has(stage.name)) throw new Error(`${def.name}: duplicate stage "${stage.name}"`);
    const stageId = randomUUID();
    stageIds.set(stage.name, stageId);
    db.insert(s.stages)
      .values({
        id: stageId,
        workflowId,
        name: stage.name,
        position,
        wipLimit: stage.wipLimit ?? null,
        defaultAgent: stage.agentDefaults?.agent ?? null,
        defaultModel: stage.agentDefaults?.model ?? null,
        defaultEffort: stage.agentDefaults?.effort ?? null,
        stayWhenDone: stage.stayWhenDone ?? false,
      })
      .run();
    for (const binding of stage.bindings ?? []) {
      if (keys.has(binding.key)) throw new Error(`${def.name}: duplicate binding key "${binding.key}"`);
      keys.add(binding.key);
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

  for (const stage of def.stages) {
    (stage.bindings ?? []).forEach((binding, position) => {
      db.insert(s.actionBindings)
        .values({
          id: randomUUID(),
          workflowId,
          stageId: stageIds.get(stage.name)!,
          key: binding.key,
          label: binding.label,
          actionType: binding.actionType,
          config: resolveStageRefs(binding.config) as Record<string, unknown>,
          enabled: binding.enabled ?? true,
          continueOnFailure: binding.continueOnFailure ?? false,
          position,
        })
        .run();
    });
  }
  return workflowId;
}

/** Seeds the default workflows into an empty database. Returns false if workflows already exist. */
export function seedDefaultWorkflows(db: Db, sqlite: Sqlite): boolean {
  const existing = db.select({ n: count() }).from(s.workflows).get()?.n ?? 0;
  if (existing > 0) return false;
  const base = Date.now();
  sqlite.transaction(() => {
    DEFAULT_WORKFLOWS.forEach((workflow, index) => insertWorkflow(db, workflow, base + index));
  })();
  return true;
}

// ---------------------------------------------------------------- default workflows

/** A coding agent as the editor would add it in this loop mode, with the seed's own prompt, waiting for your sign-off. */
const codingAgent = ({ mode, ...config }: { mode: LoopMode; prompt: string; saveResultAs?: string }) => ({
  ...defaultConfig(codingAgentAction),
  ...LOOP_MODES.find((info) => info.id === mode)!.preset,
  agent: "claude",
  saveResultAs: "",
  requireApproval: true,
  ...config,
});

export const approval = (
  key: string,
  label: string,
  options: { instructions?: string; sendBackTo?: string; askForNote?: boolean } = {},
): SeedBinding => ({
  key,
  label,
  actionType: APPROVAL_ACTION,
  config: {
    instructions: options.instructions ?? "",
    sendBackTo: options.sendBackTo ? `${STAGE_REF}${options.sendBackTo}` : "",
    askForNote: options.askForNote ?? true,
  },
});

/** Opens the merge request, waits for you to say it merged, then archives. Review comments go back to `sendBackTo`. */
const ship = (sendBackTo: string): SeedStage => ({
  name: "Ship",
  bindings: [
    {
      key: "openMr",
      label: "Push & open MR",
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
    approval("merged", "Merged", {
      instructions: "Approve once {{outputs.openMr.mrUrl}} is merged; that archives the task.",
      sendBackTo,
    }),
    {
      key: "archive",
      label: "Archive task",
      actionType: "archive-task",
      config: { removeWorktree: true, force: false },
    },
  ],
});

const FEEDBACK_BLOCK = `Feedback from the merge request, when it was sent back (empty if none):
{{task.lastFeedback}}`;

/**
 * Only actions that run: nothing here needs setting up before a first task, and each stage moves
 * the task on by itself. Tracker updates, a test command or a CI loop are added in the editor by
 * whoever wants them, since only they know the connection or the command.
 */
export const DEFAULT_WORKFLOWS: SeedWorkflow[] = [
  {
    name: "Feature",
    icon: "✨",
    description: "Plan → build → ship.",
    stages: [
      { name: "Backlog" },
      {
        name: "Plan",
        bindings: [
          {
            key: "draftRequirements",
            label: "Draft requirements",
            actionType: "coding-agent",
            config: codingAgent({
              mode: "plan",
              saveResultAs: "requirements.md",
              prompt: `You are solidifying requirements for a software task. Do not modify any files.

Task: {{task.title}}

{{task.description}}

Explore the repository first. Then settle every decision that would change what gets built by
asking me with the ask_user tool: group related questions, give each 2-4 concrete options with your
recommendation first, and ask another round when my answers open new decisions. Don't ask what the
code can tell you. Without an ask_user tool, list those decisions under Open questions instead, each
with your recommendation.

Then reply with only the Markdown requirements document, nothing before it, containing:
## Goal
## Scope (in / out)
## Decisions (each with the answer I gave)
## Functional requirements (numbered, testable)
## Edge cases
## Open questions (only what is still unsettled; "None" otherwise)`,
            }),
          },
        ],
      },
      {
        name: "Build",
        bindings: [
          {
            key: "implement",
            label: "Implement",
            actionType: "coding-agent",
            config: codingAgent({
              mode: "implementation",
              prompt: `Implement the following task in this repository.

Task: {{task.title}}

Requirements:
{{artifacts["requirements.md"]}}

${FEEDBACK_BLOCK}

Keep changes focused, run the relevant tests, and commit your work with a clear message.
Finish with a short summary of what changed.`,
            }),
          },
        ],
      },
      ship("Build"),
    ],
  },
  {
    name: "Bugfix",
    icon: "🐛",
    description: "Investigate → fix → ship.",
    stages: [
      { name: "Backlog" },
      {
        name: "Investigate",
        bindings: [
          {
            key: "investigate",
            label: "Investigate",
            actionType: "coding-agent",
            config: codingAgent({
              mode: "plan",
              saveResultAs: "reproduction.md",
              prompt: `Investigate this bug. Do not modify any files.

Bug: {{task.title}}

{{task.description}}

Reply with only a Markdown report: reproduction steps, expected vs actual behaviour, likely root cause (with file references), and a proposed fix.`,
            }),
          },
        ],
      },
      {
        name: "Fix",
        bindings: [
          {
            key: "fix",
            label: "Fix",
            actionType: "coding-agent",
            config: codingAgent({
              mode: "implementation",
              prompt: `Fix this bug in the repository.

Bug: {{task.title}}

Investigation:
{{artifacts["reproduction.md"]}}

${FEEDBACK_BLOCK}

Add a regression test, keep the change minimal, and commit with a clear message. Finish with a short summary.`,
            }),
          },
        ],
      },
      ship("Fix"),
    ],
  },
];
