# Agent chat

A coding-agent run shown as a conversation. Most of the time it is read-only. It becomes interactive in two cases: when the agent asks a question, and when it waits for your approval.

## Sub-features

- window: a bare dialog titled "<label> transcript" (`.chat-window`).
- chat list: `nav "Chats in this task"` lists every agent run on the task (earlier stages, retries). Each entry shows a status icon, label, a question mark icon if it is waiting on you, the stage, "· retry", the agent·model·effort, and when it started. At 720px and below it becomes a `select "Chats in this task"`, shown only when the task has at least two chats.
- header: status icon, label, then "agent · model · effort · autonomy · status · resets … · duration · usage". Buttons: **Try now** (quota-wait), **Cancel** (active and not awaiting approval), **Retry**, and **Close chat**.
- transcript: a collapsed **Prompt** row (click to expand the full prompt), agent messages as Markdown bubbles, and tool rows (wrench icon, tool name and detail, running / ✓ / failed, expandable to input and result). Questions and your answers appear as bubbles, along with notices, errors and output blocks.
- working: "Working… <duration>" with animated dots while running and not blocked.
- follow-tail: it pins to the bottom while you're at the bottom. If you scroll up, it stays where you put it. A new round (status change or new question) snaps back to the bottom.
- footer: **Raw log** / **Conversation** toggle, "N lines", **Copy** (copies the transcript text; the label changes to "Copied").
- below the transcript: the question card (`agent-questions.md`) and the review card (`agent-review.md`).

## How to get to it (user POV)

Click an agent row in the stage panel, **Open chat** on a timeline event, or **Review** / **Answer** in the drawer header.

## Driving it

- `find "Chats in this task"` to switch runs. `find "Close chat"` to close.
- Log source: `GET .../runs/<runId>/log` (an array of `{stream, kind, text, tool?, ok?}`). Live lines arrive as SSE `run.log`.
- To check follow-tail, scroll `.chat-body` up via `computer scroll`, wait for new lines, and confirm `scrollTop` did not jump (`javascript_tool`).

## Gotchas

- Archived tasks keep the list, but the transcripts are empty ("Transcripts are removed when a task is archived."), and there is no review card and no action buttons.
- A blocked agent is still `running` to the engine. The header shows "Waiting on you" instead.
- Siblings must have their own keys. A shared key used to leave the previous run's transcript mounted.
- Escape closes the chat first. A second Escape closes the drawer, or raises the unsaved-changes confirm if Details has edits.
