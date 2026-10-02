/**
 * Loop modes of the coding-agent action, and everything each one implies. The server, the seed and
 * the editor all ask here rather than re-deriving a mode's autonomy, review or presets themselves.
 */
import type { Autonomy } from "./index";

export const LOOP_MODE_IDS = ["single", "plan", "implementation", "ci"] as const;
export type LoopMode = (typeof LOOP_MODE_IDS)[number];

export const isLoopMode = (value: unknown): value is LoopMode => LOOP_MODE_IDS.includes(value as LoopMode);

export interface LoopModeInfo {
  id: LoopMode;
  label: string;
  hint: string;
  /** Config a newly added action of this mode starts with, over the action's field defaults. */
  preset: Record<string, unknown>;
}

const loopPreset = (loopMode: LoopMode, prompt: string, saveResultAs = "") => ({
  loopMode,
  requireApproval: true,
  maxCorrections: 3,
  saveResultAs,
  prompt,
});

export const LOOP_MODES: readonly LoopModeInfo[] = [
  {
    id: "single",
    label: "Single run",
    hint: "One agent run, no automatic review.",
    preset: { loopMode: "single" },
  },
  {
    id: "plan",
    label: "Plan loop",
    hint: "Draft, review and revise until the plan is accepted.",
    preset: loopPreset(
      "plan",
      "Plan {{task.title}}.\n\n{{task.description}}\n\nExplore the repository and return only the complete Markdown plan.",
      "plan.md",
    ),
  },
  {
    id: "implementation",
    label: "Implement loop",
    hint: "Implement, review and fix before you approve the changes.",
    preset: loopPreset(
      "implementation",
      'Implement {{task.title}} using the approved plan:\n\n{{artifacts["plan.md"]}}\n\nRun relevant checks and summarize the changes.',
    ),
  },
  {
    id: "ci",
    label: "CI loop",
    hint: "Run local or remote checks, fix failures and rerun until green.",
    preset: loopPreset("ci", "Resolve CI failures for {{task.title}}.\n\n{{task.description}}"),
  },
];

export interface LoopPolicy {
  mode: LoopMode;
  label: string;
  /** What the author's own runs may do to the repository. */
  autonomy: Autonomy;
  /**
   * The independent review the run goes through before it finishes, whether or not it then waits
   * for your approval: a document is sent back to its author, code is fixed by the reviewer.
   */
  review: "document" | "code" | null;
  /** Whether the agent may stop to ask you something. A CI loop's check command does the deciding. */
  asksQuestions: boolean;
}

/** What a coding agent's config means. A missing or unknown mode is a single run. */
export function loopPolicy(config: { loopMode?: unknown; autonomy?: unknown }): LoopPolicy {
  const mode = isLoopMode(config.loopMode) ? config.loopMode : "single";
  const label = LOOP_MODES.find((info) => info.id === mode)!.label;
  switch (mode) {
    case "single":
      return { mode, label, autonomy: config.autonomy === "autonomous" ? "autonomous" : "read-only", review: null, asksQuestions: true };
    case "plan":
      return { mode, label, autonomy: "read-only", review: "document", asksQuestions: true };
    case "implementation":
      return { mode, label, autonomy: "autonomous", review: "code", asksQuestions: true };
    case "ci":
      return { mode, label, autonomy: "autonomous", review: null, asksQuestions: false };
  }
}
