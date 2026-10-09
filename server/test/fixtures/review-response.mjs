// Shared protocol behavior for fake agents; normal author prompts still echo their input.
export function reviewResponse(prompt) {
  const decisions = { decisions: [{
    decision: "Acceptance criteria", options: [
      { option: "Explicit acceptance criteria", basis: "documented" },
      { option: "Implicit acceptance criteria", basis: "possible" },
    ], chosen: "Explicit acceptance criteria", rationale: "Make the requested behavior verifiable.",
    evidence: "Final build and independent review", status: "current",
  }] };
  if (prompt.startsWith("Review the following document independently")) {
    if (prompt.includes("[review:invalid]")) return "Looks good to me";
    return JSON.stringify(prompt.includes("[review:changes]") && !prompt.includes("Document:\n# Revised plan")
      ? { decision: "changes_requested", feedback: "Add acceptance criteria" }
      : { decision: "approved", feedback: "", decisions });
  }
  if (prompt.startsWith("Revise your document to address")) {
    return "# Revised plan\n\nAcceptance criteria: all requested behavior is verified.";
  }
  if (prompt.startsWith("Review the implementation independently")) {
    return JSON.stringify({ decision: "approved", feedback: "", summary: "Final implementation with reviewer fixes and passing checks.", decisions });
  }
  return null;
}
