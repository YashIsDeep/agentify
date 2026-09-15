import type { RunView, TaskDetail } from "@wm/shared";
import { Check, Hand, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { actionList, isAwaitingApproval } from "../lib/runs";
import { DiffPanel } from "./DiffPanel";

/** Stays visible below the transcript throughout the draft → revise → review loop. */
export function AgentReview({ run, detail }: { run: RunView; detail: TaskDetail }) {
  const api = useApi();
  const action = useTaskAction();
  // Scoped to both workspace and run; closing a chat or switching tasks keeps unsent feedback.
  const draftKey = `agent-review:${api.eventsUrl}:${run.id}`;
  const [note, setNote] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  const updateNote = (value: string) => {
    setNote(value);
    try {
      if (value) sessionStorage.setItem(draftKey, value);
      else sessionStorage.removeItem(draftKey);
    } catch { /* The in-memory draft still works when browser storage is unavailable. */ }
  };
  const ready = isAwaitingApproval(run);
  const config = { ...run.config, ...(run.overrides ?? {}) };
  const revisions = detail.timeline.filter((event) => event.runId === run.id && event.type === "run.changes-requested").length;
  const visit = detail.visits.find((entry) => entry.id === run.visitId);
  const next = visit && actionList(visit).find((entry) => entry.batchId === run.batchId && entry.batchPosition > run.batchPosition);
  const instructions = typeof run.outputs?.instructions === "string" ? run.outputs.instructions : "";
  const working = run.status === "running" || run.status === "queued" || run.status === "quota-wait";
  const approved = run.status === "succeeded" && run.outputs?.decision === "approved";
  if (run.visitId !== detail.task.currentVisitId && !approved) return null;

  if (approved) return <div className="agent-review-status" role="status"><Check size={15} /> Approved. The workflow can continue.</div>;
  if (!ready && !working) return null;
  if (!ready && !config.requireApproval) {
    return <p className="agent-review-status muted">This action continues automatically when finished. To review future runs, enable “Wait for my approval” in the workflow editor.</p>;
  }

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || action.isPending || !note.trim()) return;
    action.mutate(async () => {
      const updated = await api.requestChanges(run.id, note.trim());
      // Clear a submitted draft even if the chat closed while the request was in flight.
      updateNote("");
      return updated;
    });
  };
  const approve = () => {
    if (!ready || action.isPending || note.trim()) return;
    action.mutate(async () => {
      const updated = await api.approveRun(run.id);
      updateNote("");
      return updated;
    });
  };

  return (
    <form className="approval-card agent-review" onSubmit={send} aria-label="Review agent work">
      <header className="approval-card-head" aria-live="polite">
        <Hand size={15} />
        <strong>{ready ? "Ready for review" : run.status === "quota-wait" ? "Waiting for usage limit" : revisions ? "Revising…" : "Preparing first draft…"}</strong>
        <span className="spacer" />
        <span className="chip">{revisions ? `Revision ${revisions}` : "First draft"}</span>
      </header>
      <p className="approval-text muted">
        {ready ? "Request as many revisions as you need. Each result comes back here for your review." : "You can draft feedback while the agent works. Send it once the result is ready for review."}
      </p>
      {ready && instructions && <p className="approval-text agent-review-instructions">{instructions}</p>}
      {ready && <DiffPanel task={detail.task} />}
      <label className="agent-review-label" htmlFor={`revision-${run.id}`}>What would you like changed?</label>
      <textarea
        id={`revision-${run.id}`}
        rows={2}
        value={note}
        maxLength={10_000}
        disabled={action.isPending}
        placeholder="Describe your revision…"
        onChange={(event) => updateNote(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") send(event);
        }}
      />
      <div className="approval-card-actions">
        <button type="submit" className="button small primary" disabled={!ready || action.isPending || !note.trim()}>
          <Send size={13} /> Request revision
        </button>
        <span className="spacer" />
        <button type="button" className="button small" disabled={!ready || action.isPending || !!note.trim()} onClick={approve}>
          <Check size={13} /> Approve & continue
        </button>
      </div>
      <p className="approval-text muted small">
        {note.trim() ? "Send or clear your feedback before approving." : next ? `Approval starts “${next.label}”.` : "Approval completes this action."}
      </p>
    </form>
  );
}
