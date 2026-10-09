import { z } from "zod";

const text = z.string().trim().min(1);
export const decisionReportSchema = z.object({
  decisions: z.array(z.object({
    decision: text,
    options: z.array(z.object({
      option: text,
      basis: z.enum(["documented", "possible"]),
    })).min(1),
    chosen: text,
    rationale: text,
    evidence: text,
    status: z.enum(["current", "superseded"]),
  }).refine((entry) => entry.options.some((option) => option.option === entry.chosen && option.basis === "documented"),
    "The chosen option must be listed as a documented option")),
  noDecisionsReason: text.optional(),
}).refine((report) => report.decisions.length > 0 || !!report.noDecisionsReason, "Explain when no decisions were found");

export type DecisionReport = z.infer<typeof decisionReportSchema>;

export const DECISION_INSTRUCTIONS = `When approving, also return a "decisions" object with this shape:
{"decisions":[{"decision":"the choice or question resolved","options":[{"option":"option name","basis":"documented"|"possible"}],"chosen":"exact name of the selected option","rationale":"brief reason and tradeoff; say not recorded if unknown","evidence":"build/review reference, user answer or file location supporting the selection","status":"current"|"superseded"}],"noDecisionsReason":"required only when there are no decisions"}.
This becomes decisions.md for the user's review. Consolidate ALL material decisions behind the final build, not just changes in this review: scope, behavior, design, implementation approach, constraints, assumptions and validation choices. Include decisions made by the author, reviewer and user.
Reconcile prior builds, reviews and the previous decision record against the FINAL build and this review. Preserve still-applicable decisions from earlier stages. Merge repeated decisions. Mark abandoned choices as superseded and explain the final replacement; never present an earlier rejected choice as current.
Include the chosen option among the options with basis "documented". Other options actually discussed in the supplied evidence use "documented". Plausible alternatives that were not discussed use "possible"; do not claim they were evaluated. Do not invent user decisions, evidence or reasons. If only the chosen option is known, say alternatives were not recorded in the rationale.
Check that every current choice agrees with the final build and the user's answers before approving. If no material decisions exist, return an empty array with a specific noDecisionsReason. Do not omit the decision record from an approval.`;

/** App-owned headings tie the agent's record to the exact run and accepted version. */
export function renderDecisions(report: DecisionReport, source: string): string {
  const entries = report.decisions.map((entry, index) => `## D${index + 1}. ${entry.decision}

**Status:** ${entry.status === "current" ? "Current" : "Superseded"}

**Options:**

${entry.options.map((option) => `- ${option.option} — ${option.basis === "documented" ? "documented" : "possible alternative; not recorded as considered"}`).join("\n")}

**${entry.status === "current" ? "Final choice" : "Former choice"}:** ${entry.chosen}

**Rationale:** ${entry.rationale}

**Evidence:** ${entry.evidence}`);
  return `# Decisions\n\n${source}\n\nConsolidated against the final build and independent review. Ready for your review.\n\n${entries.length ? entries.join("\n\n") : report.noDecisionsReason}\n`;
}
