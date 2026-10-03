# Stage panel

The top of the drawer's scroll area. It shows the current stage's actions top to bottom, each with its status and the controls it allows.

## Sub-features

- section heading: shown only when the visit is attempt > 1 ("attempt N" tag) or complete ("complete" tag).
- run rows: "N. <label>" with a status icon (Waiting, Queued, Running, Ready for review, quota hourglass, Succeeded, Failed, Cancelled, Interrupted, Skipped). The meta column shows duration · cost, or "resets <time>", or the status. The tooltip gives the full label, the agent/model or action type, and the token usage.
- agent rows: a chat icon. Clicking opens the chat instead of expanding a log.
- other rows: a chevron that expands an inline `RunLog`. Running and failed rows start expanded.
- needs-you highlight: rows waiting on approval or a question get `run-needs-you`.
- controls: **Try now** (quota-wait), **Cancel action** (active, not waiting for you; asks first), **Retry** (failed/cancelled/interrupted; agents open the Retry dialog to switch agent/model/effort), **Skip** ("Carry on with the next action").
- not-started list: before Start, the enabled actions show as "Not started" rows.
- switched off: "Switched off: A, B" for disabled actions.
- standalone approval: instructions, a Review artifacts list, a Changes diff panel, **Approve & continue**, and **Send back to <Stage>** (a note dialog, unless the action's `askForNote` is off).
- dialogs: `Cancel action` ("Stops it now…", **Keep running** / **Cancel action**), `Retry <label>` (Agent / Model / Effort, **Retry**), `Send back to <Stage>` (Note → `{{task.lastFeedback}}`).

## How to get to it (user POV)

Open a task that is not archived and whose current stage has actions. The panel is right under the stepper.

## Driving it

- Rows: `read_page` inside `aside "Task details"`, under `ol.actions`. Buttons by text: `Retry`, `Skip`, `Try now`, or by label `Cancel action`.
- To cheaply force a failure, use a shell action with `node -e "process.exit(1)"`, then Retry or Skip.
- API: `POST /api/workspaces/<id>/runs/<runId>/{retry|resume|cancel|skip|approve|send-back}`. Retry takes `{overrides:{agent,model,effort}}` and send-back takes `{note}`.
- A run log is at `GET .../runs/<runId>/log` and streams via SSE `run.log`.

## Gotchas

- Skip works only on failed, cancelled or interrupted runs. Otherwise it returns 409.
- Agent questions and agent reviews are handled in the chat, not in the row. The row only highlights.
- When the inline log is open the error isn't repeated separately, because the log already ends with it.
- A stage with no actions at all renders no panel.
