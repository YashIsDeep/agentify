/**
 * Approval gates: whether an action waits for you, and what you can do when it does. Two actions
 * have one. A standalone Approval waits *instead* of doing any work; a coding agent told to wait for
 * your approval holds its own run open *after* the work, and you can ask it for changes in its chat.
 * The engine, the task drawer and the workflow's stage summaries all ask here rather than checking
 * action types and config field names themselves.
 */

import { loopPolicy } from "./loops";

/**
 * The action type for a gate that follows no agent — "approve once the merge request is merged".
 * The engine handles it itself: an approval never reaches the runner, it goes straight to
 * `awaiting-approval` and sits there until someone decides. A coding agent whose work you want to
 * sign off doesn't need one of these; it holds its own run open instead.
 */
export const APPROVAL_ACTION = "approval";

export const CODING_AGENT_ACTION = "coding-agent";

export interface Gate {
  /** `instead`: the run goes straight to waiting for you and never reaches the runner. `after`: it waits once its work succeeds. */
  when: "instead" | "after";
  /** Request changes sends your note back to the agent in the same chat. */
  conversational: boolean;
  /** The instructions shown while it waits, as configured (a template, rendered when the wait starts). */
  instructionsTemplate: string;
  /** A stage id in the same workflow, or "" when the gate offers no Send back. */
  sendBackTo: string;
  /** Whether Send back asks for a note to save as the task's feedback. */
  askForNote: boolean;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The gate an action's config declares, or null when it carries on by itself. */
export function actionGate(actionType: string, config: Record<string, unknown>): Gate | null {
  if (actionType === APPROVAL_ACTION) {
    return {
      when: "instead",
      conversational: false,
      instructionsTemplate: text(config.instructions),
      sendBackTo: text(config.sendBackTo),
      askForNote: config.askForNote !== false,
    };
  }
  if (actionType === CODING_AGENT_ACTION && config.requireApproval === true) {
    return {
      when: "after",
      conversational: true,
      instructionsTemplate: text(config.approvalInstructions) || signOffLine(config),
      sendBackTo: text(config.sendBackTo),
      askForNote: true,
    };
  }
  return null;
}

/** What an agent's sign-off says while it waits, unless the workflow was saved with a line of its own. */
function signOffLine(config: Record<string, unknown>): string {
  const policy = loopPolicy(config);
  if (policy.autonomy === "autonomous") return "Review the changes. Request changes and the agent revises them.";
  const result = text(config.saveResultAs);
  return `Read ${result ? `${result} under Artifacts` : "the agent's answer"}. Request changes and the agent redrafts it.`;
}

export interface GatedRun {
  actionType: string;
  config: Record<string, unknown>;
  overrides: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
}

export interface RunGate extends Gate {
  /** The instructions as rendered when the run started waiting; "" before then. */
  instructions: string;
}

/** A run's gate, with any retry overrides applied and the instructions as you were shown them. */
export function runGate(run: GatedRun): RunGate | null {
  const gate = actionGate(run.actionType, { ...run.config, ...(run.overrides ?? {}) });
  return gate && { ...gate, instructions: text(run.outputs?.instructions) };
}

/** A standalone Approval: nothing runs, so there is no log or chat, only the decision. */
export const isApprovalOnly = (run: Pick<GatedRun, "actionType" | "config">) => actionGate(run.actionType, run.config)?.when === "instead";
