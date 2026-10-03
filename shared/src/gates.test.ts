import { describe, expect, it } from "vitest";
import { actionGate, APPROVAL_ACTION, CODING_AGENT_ACTION, isApprovalOnly, runGate } from "./gates";

describe("approval gates", () => {
  it("makes a standalone Approval wait instead of running, with its own instructions and Send back", () => {
    expect(actionGate(APPROVAL_ACTION, { instructions: "Check {{task.title}}", sendBackTo: "s1", askForNote: false })).toEqual({
      when: "instead",
      conversational: false,
      instructionsTemplate: "Check {{task.title}}",
      sendBackTo: "s1",
      askForNote: false,
    });
    expect(actionGate(APPROVAL_ACTION, {})).toMatchObject({ sendBackTo: "", askForNote: true });
  });

  it("holds a coding agent open after its work only when told to wait, using its sign-off field", () => {
    expect(actionGate(CODING_AGENT_ACTION, { requireApproval: false, sendBackTo: "s1" })).toBeNull();
    expect(actionGate(CODING_AGENT_ACTION, { requireApproval: true, prompt: "Build it", instructions: "ignored", approvalInstructions: "Read the diff", sendBackTo: "s1" })).toEqual({
      when: "after",
      conversational: true,
      instructionsTemplate: "Read the diff",
      sendBackTo: "s1",
      askForNote: true,
    });
  });

  it("gives other actions no gate", () => {
    expect(actionGate("shell", { requireApproval: true, instructions: "x" })).toBeNull();
  });

  it("reads a run's gate through its overrides, with the instructions as rendered", () => {
    const run = { actionType: CODING_AGENT_ACTION, config: { requireApproval: false }, overrides: { requireApproval: true }, outputs: { instructions: "Rendered" } };
    expect(runGate(run)).toMatchObject({ when: "after", instructions: "Rendered" });
    expect(runGate({ ...run, outputs: null })?.instructions).toBe("");
    expect(isApprovalOnly({ actionType: APPROVAL_ACTION, config: {} })).toBe(true);
    expect(isApprovalOnly(run)).toBe(false);
  });
});
