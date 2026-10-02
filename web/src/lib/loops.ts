import type { ActionTypeInfo } from "@wm/shared";

export const LOOP_LABELS: Record<string, string> = {
  plan: "Plan loop", implementation: "Implement loop", ci: "CI loop",
};

/** Presets share the coding-agent runtime, including its approvals, retries and quota handling. */
export function loopPresets(action: ActionTypeInfo): ActionTypeInfo[] {
  if (action.type !== "coding-agent") return [];
  return Object.entries(LOOP_LABELS).map(([mode, label]) => {
    const defaults: Record<string, unknown> = {
      loopMode: mode, requireApproval: true, reviewBeforeApproval: true, maxCorrections: 3,
      autonomy: mode === "plan" ? "read-only" : "autonomous",
      saveResultAs: mode === "plan" ? "plan.md" : "",
      prompt: mode === "plan"
        ? "Plan {{task.title}}.\n\n{{task.description}}\n\nExplore the repository and return only the complete Markdown plan."
        : mode === "implementation"
          ? 'Implement {{task.title}} using the approved plan:\n\n{{artifacts["plan.md"]}}\n\nRun relevant checks and summarize the changes.'
          : "Resolve CI failures for {{task.title}}.\n\n{{task.description}}",
    };
    return {
      ...action, label,
      description: mode === "plan" ? "Draft, review and revise until accepted, then approve the plan."
        : mode === "implementation" ? "Implement, review and fix before approving the final changes."
          : "Run local or remote checks, fix failures and rerun until green.",
      fields: action.fields.map((field) => field.name in defaults ? { ...field, default: defaults[field.name] } : field),
    };
  });
}
