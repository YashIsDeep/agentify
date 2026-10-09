# Agent review

A card under the chat transcript for a coding agent with **Wait for my approval when it finishes**. From it you request revisions in the same session, send the work back, or approve it so the workflow continues.

## Sub-features

- status heading while working: "Preparing first draft…", "Preparing and reviewing…" (loop with review), "Revising…", "Checking CI and fixing failures…", or "Waiting for usage limit".
- status heading when ready: "Ready for review", or "Final work ready for approval" once an automatic review or CI pass ran. Tags: "First draft", "Revision N", "Agent reviewed", "CI passed".
- instructions: a standard line for the loop mode ("Read plan.md under Artifacts…", "Review the changes…"); workflows saved with their own **Approval instructions** keep them.
- review artifacts + diff: the task's artifacts list, and a **Changes** diff panel (hidden for read-only runs).
- diff panel: "N files, +a −d" or "none against <base> yet". Each file row shows a status letter, the path (old → new for renames) and counts, and expands to its hunks. **Copy <path>** and **Read the diff again** sit in the panel header. Notes say when the diff is truncated or uncommitted work isn't shown.
- feedback: "What would you like changed?" textarea (max 10,000). **Ctrl+Enter** / **⌘+Enter** sends.
- **Request revision**: the agent resumes its own session with your note. The run goes back to working, and the timeline gets `run.changes-requested`.
- **Approve & continue**: disabled while the box has text (title "Send or clear your feedback before approving"). The tooltip names the next action it starts.
- **Send back to <Stage>**: shown when the action has a send-back stage. Opens the note dialog.
- after approval: "Approved. The workflow can continue." with **Follow <next label> →** to jump to the next agent's chat.
- no gate: "This action continues automatically when finished. To review future runs, enable “Wait for my approval” in the workflow editor."
- draft persistence: unsent feedback is kept in `sessionStorage` per workspace and run (`agent-review:<eventsUrl>:<runId>`), so it survives closing the chat or switching tasks.

## How to get to it (user POV)

When a task shows **Needs you · Ready for review**, click **Review** in the drawer header, or review it inline on Open conversations (the Needs you counter takes you there).

## Driving it

- `form "Review agent work"`. Type into the textarea, then `key "ctrl+Enter"`, or click **Request revision**.
- API: `POST .../runs/<runId>/request-changes {note}`, `POST .../runs/<runId>/approve`, `POST .../runs/<runId>/send-back {note?}`.
- Diff: `GET .../tasks/<taskId>/diff` → `{files[], insertions, deletions, patch, truncated, uncommitted, dirty, baseBranch, branch, path}`.

## Gotchas

- Review feedback stays in the transcript and is never written over the saved document.
- A loop's automatic review runs whether or not the approval gate is on. With the gate on, you see only the final work.
- Already-started runs keep their original gate. Changing the setting in the editor affects the next stage visit.
- The diff needs both `repoPath` and `branch`. Tasks without a repository show no diff.
