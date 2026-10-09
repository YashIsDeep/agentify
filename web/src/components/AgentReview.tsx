import { actionList, loopPolicy, runGate, type RunView, type StageDef, type TaskDetail } from "@wm/shared";
import { ArrowRight, Check, Hand, Send, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { agentChats, isAwaitingApproval } from "../lib/runs";
import { Button, Field, Tag } from "../ui";
import { SendBackDialog } from "./dialogs";
import { ReviewArtifacts } from "./ArtifactsPanel";
import { DiffPanel } from "./DiffPanel";

/** Follows the transcript throughout the draft → revise → review loop. */
export function AgentReview({
  run,
  detail,
  stages,
  onOpenRun,
}: {
  run: RunView;
  detail: TaskDetail;
  stages: StageDef[];
  /** Opens another agent's chat: after an approval, the one that started next. */
  onOpenRun?: (runId: number) => void;
}) {
  const api = useApi();
  const action = useTaskAction();
  const [sendingBack, setSendingBack] = useState(false);
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
  const policy = loopPolicy({ ...run.config, ...(run.overrides ?? {}) });
  // A read-only run can't have changed the code, so its review has no diff to show.
  const readOnly = (typeof run.outputs?.autonomy === "string" ? run.outputs.autonomy : policy.autonomy) === "read-only";
  const ciPassed = ready && !!run.outputs?.ci;
  const reviewed = ready && (!!run.outputs?.review || ciPassed);
  const revisions = detail.timeline.filter((event) => event.runId === run.id && event.type === "run.changes-requested").length;
  const visit = detail.visits.find((entry) => entry.id === run.visitId);
  const next = visit && actionList(visit.runs).find((entry) => entry.batchId === run.batchId && entry.batchPosition > run.batchPosition);
  const gate = runGate(run);
  const instructions = gate?.instructions ?? "";
  const working = run.status === "running" || run.status === "queued" || run.status === "quota-wait";
  const approved = run.status === "succeeded" && run.outputs?.decision === "approved";
  const sendBackTo = gate?.sendBackTo || null;
  const sendBackName = sendBackTo ? (stages.find((stage) => stage.id === sendBackTo)?.name ?? "another stage") : null;
  if (run.visitId !== detail.task.currentVisitId && !approved) return null;

  if (approved) {
    // The oldest chat that started after this one: what your approval set going.
    const following = agentChats(detail).filter((chat) => chat.run.id > run.id).at(-1)?.run;
    return (
      <div className="agent-review-status" role="status">
        <Check size={15} /> Approved. The workflow can continue.
        {following && onOpenRun && (
          <>
            <span className="spacer" />
            <Button variant="link" onClick={() => onOpenRun(following.id)}>
              Follow {following.label} <ArrowRight size={12} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    );
  }
  if (!ready && !working) return null;
  if (!ready && !gate) {
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
    <>
      <form className="approval-card agent-review" onSubmit={send} aria-label="Review agent work">
        <header className="approval-card-head" aria-live="polite">
          <Hand size={15} />
          <strong>{ready ? reviewed ? "Final work ready for approval" : "Ready for review" : run.status === "quota-wait" ? "Waiting for usage limit" : policy.mode === "ci" ? "Checking CI and fixing failures…" : policy.review ? "Preparing and reviewing…" : revisions ? "Revising…" : "Preparing first draft…"}</strong>
          <span className="spacer" />
          <Tag>{ciPassed ? "CI passed" : reviewed ? "Agent reviewed" : revisions ? `Revision ${revisions}` : "First draft"}</Tag>
        </header>
        {/* While the agent works or asks, its question is the one thing to answer; a draft waits here. */}
        {ready && (
          <>
            {instructions && <p className="approval-text agent-review-instructions">{instructions}</p>}
            <ReviewArtifacts taskId={detail.task.id} />
            {!readOnly && <DiffPanel task={detail.task} previewLimit={10} />}
            <Field label="What would you like changed?" tip="Ctrl+Enter (⌘+Enter on a Mac) sends it.">
              <textarea
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
            </Field>
            <div className="approval-card-actions">
              {/* The main action follows the box: approving while it's empty, sending once you've typed. */}
              <Button type="submit" size="sm" variant={note.trim() ? "primary" : "secondary"} icon={Send} disabled={!note.trim()} loading={action.isPending}>
                Request revision
              </Button>
              <span className="spacer" />
              {sendBackName && (
                <Button size="sm" icon={Undo2} disabled={action.isPending} onClick={() => setSendingBack(true)}>
                  Send back to {sendBackName}
                </Button>
              )}
              <Button
                size="sm"
                variant={note.trim() ? "secondary" : "primary"}
                icon={Check}
                disabled={action.isPending || !!note.trim()}
                title={note.trim() ? "Send or clear your feedback before approving" : next ? `Approving starts “${next.label}”` : "Approving completes this action"}
                onClick={approve}
              >
                Approve & continue
              </Button>
            </div>
          </>
        )}
      </form>
      {sendingBack && sendBackName && <SendBackDialog run={run} stageName={sendBackName} onClose={() => setSendingBack(false)} />}
    </>
  );
}
