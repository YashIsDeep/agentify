import { randomUUID } from "node:crypto";
import { type AgentId, APPROVAL_ACTION } from "@wm/shared";
import { count } from "drizzle-orm";
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

const codingAgent = ({
  approval,
  sendBackTo,
  ...config
}: {
  autonomy: "read-only" | "autonomous";
  prompt: string;
  continueSession?: boolean;
  saveResultAs?: string;
  /** Present: the agent waits for your sign-off when it finishes, showing this while it waits. */
  approval?: string;
  /** Offers a Send back to this stage beside Approve; changes go to the agent, not a stage. */
  sendBackTo?: string;
}) => ({
  agent: "claude",
  model: "",
  continueSession: false,
  saveResultAs: "",
  requireApproval: approval !== undefined,
  approvalInstructions: approval ?? "",
  sendBackTo: sendBackTo ? `${STAGE_REF}${sendBackTo}` : "",
  ...config,
});

/**
 * Carries `.env` over by default: it is the one gitignored path nearly every repository has, it is
 * small enough to copy, and an agent without it works against a checkout that cannot even start.
 * Heavier paths such as node_modules are left to you, since linking them shares one directory
 * between the worktree and the repository.
 */
const worktree = (key: string): SeedBinding => ({
  key,
  label: "Ensure worktree",
  actionType: "ensure-worktree",
  config: { branchPrefix: "wm/", carryOver: ".env" },
});

const next = (key: string): SeedBinding => ({
  key,
  label: "Move to next stage",
  actionType: "move-stage",
  config: { target: "next" },
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

/**
 * Integration actions ship switched off: they need a connection, and the workflow editor refuses
 * to enable one without it. A tracker update failing shouldn't hold up the code work, so they carry on.
 */
const jira = (key: string, label: string, status: string): SeedBinding => ({
  key,
  label,
  actionType: "jira-transition",
  config: { connectionId: "", issue: "{{task.links.jira}}", transition: status, comment: "" },
  enabled: false,
  continueOnFailure: true,
});

const submitMr = (): SeedStage => ({
  name: "Submit MR",
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
    jira("jiraInReview", "Jira → In Review", "In Review"),
    approval("merged", "Merged", { instructions: "Approve once {{outputs.openMr.mrUrl}} is merged; that archives the task." }),
    {
      key: "submitArchive",
      label: "Archive task",
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
    icon: "✨",
    description: "Requirements → implementation → review → test → merge request.",
    stages: [
      { name: "Backlog" },
      { name: "To Pick" },
      {
        name: "Solidify Reqs",
        bindings: [
          worktree("solidifyWorktree"),
          {
            key: "draftRequirements",
            label: "Draft requirements",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "read-only",
              saveResultAs: "requirements.md",
              approval: "Read requirements.md under Artifacts. Ask for changes and the agent redrafts it.",
              prompt: `You are solidifying requirements for a software task. Do not modify any files.

Task: {{task.title}}

{{task.description}}

${FEEDBACK_BLOCK}

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
          next("solidifyNext"),
        ],
      },
      {
        name: "Implement Reqs",
        bindings: [
          jira("jiraInProgress", "Jira → In Progress", "In Progress"),
          worktree("implementWorktree"),
          {
            key: "implement",
            label: "Implement",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "autonomous",
              continueSession: true,
              approval: "Look over the change in {{task.worktreePath}} before it goes to review.",
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
        bindings: [
          approval("reviewDiff", "Review diff", {
            instructions: "Review the diff on {{task.branch}} against {{task.baseBranch}}.",
            sendBackTo: "Implement Reqs",
          }),
          next("reviewNext"),
        ],
      },
      {
        name: "Test Imp",
        bindings: [
          /**
           * Also switched off, because only you know how this repository installs. It is seeded
           * anyway so the step is visible: a worktree is a clean checkout, so unless the worktree
           * action carries node_modules across, the tests below run against an empty one and fail
           * for a reason that has nothing to do with the task.
           */
          {
            key: "installDeps",
            label: "Install dependencies",
            actionType: "shell",
            config: { command: "npm ci", cwd: "worktree" },
            enabled: false,
          },
          /**
           * Ships switched off: there's no way to know this repository's test command, and a stage
           * that quietly echoes a placeholder would sign a task off as tested when nothing ran.
           * The placeholder exits non-zero too, so enabling it before editing it fails loudly.
           */
          {
            key: "runTests",
            label: "Run tests",
            actionType: "shell",
            config: {
              command: 'echo No test command configured. Edit the "Run tests" action for this workflow. && exit 1',
              cwd: "worktree",
            },
            enabled: false,
          },
          approval("manualQa", "Manual QA", {
            // Says plainly what did and didn't happen: with the two actions above off, no test has run.
            instructions:
              "Try the change in {{task.worktreePath}}. Automated tests only run here once Install dependencies and Run tests are set up and switched on for this workflow. Approving opens the merge request.",
            sendBackTo: "Implement Reqs",
          }),
          next("testNext"),
        ],
      },
      submitMr(),
    ],
  },
  {
    name: "Bugfix",
    icon: "🐛",
    description: "Reproduce → fix → review → merge request.",
    stages: [
      { name: "Backlog" },
      {
        name: "Reproduce",
        bindings: [
          worktree("reproduceWorktree"),
          {
            key: "investigate",
            label: "Investigate",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "read-only",
              saveResultAs: "reproduction.md",
              approval: "Read reproduction.md under Artifacts. Ask for changes and the agent digs further.",
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
        bindings: [
          {
            key: "linearInProgress",
            label: "Linear → In Progress",
            actionType: "linear-update",
            config: { connectionId: "", issue: "{{task.links.linear}}", state: "In Progress", comment: "" },
            enabled: false,
            continueOnFailure: true,
          },
          worktree("fixWorktree"),
          {
            key: "fix",
            label: "Fix",
            actionType: "coding-agent",
            config: codingAgent({
              autonomy: "autonomous",
              continueSession: true,
              approval: "Look over the fix in {{task.worktreePath}} before it goes to review.",
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
        bindings: [
          approval("reviewFix", "Review diff", {
            instructions: "Review the diff on {{task.branch}} against {{task.baseBranch}}.",
            sendBackTo: "Fix",
          }),
          next("reviewNext"),
        ],
      },
      submitMr(),
    ],
  },
];
