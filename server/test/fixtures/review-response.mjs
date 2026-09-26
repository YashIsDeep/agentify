// Shared protocol behavior for fake agents; normal author prompts still echo their input.
export function reviewResponse(prompt) {
  if (prompt.startsWith("Review the following document independently")) {
    if (prompt.includes("[review:invalid]")) return "Looks good to me";
    return JSON.stringify(prompt.includes("[review:changes]")
      ? { decision: "changes_requested", feedback: "Add acceptance criteria" }
      : { decision: "approved", feedback: "" });
  }
  if (prompt.startsWith("Revise your document to address")) {
    return "# Revised plan\n\nAcceptance criteria: all requested behavior is verified.";
  }
  if (prompt.startsWith("Review the implementation independently")) {
    return JSON.stringify({ decision: "approved", feedback: "", summary: "Final implementation with reviewer fixes and passing checks." });
  }
  return null;
}
