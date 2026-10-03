# Task drawer

The side panel for one task. It shows what the task needs from you, where it is in the workflow, what is running and its history.

## Sub-features

- header: title (h2) and the needs-you button (**Answer** for a question, **Review** for an agent waiting on approval, **Start** for an unstarted stage). Then **Archive task** (hidden once archived) and **Close task**.
- meta row: a status badge (not shown for idle or needs-you), then tags for repository (full path, branch and worktree in the tooltip), links (clickable when they are URLs) and tags.
- stepper: `ol "Stages"`. The current stage is highlighted and has the title "In <Stage> since …", and visited stages are marked. Clicking another stage opens the Move dialog.
- stage-panel: the current stage's actions. See `stage-panel.md`.
- description: rendered Markdown, clamped with a fade and **Show more** / **Show less**.
- tabs: **Activity** (timeline), **Artifacts**, **Details** (kept mounted so edits survive tab switches).
- chat: any agent run opens `ChatModal` over the drawer. See `agent-chat.md`.
- escape: closes the drawer unless a dialog, menu or tooltip is on top.

## How to get to it (user POV)

Click a card on a board, a row in the Archive, a task in a Running/Stopped counter, or **Open task** on the Open conversations page.

## Driving it

- `aside "Task details"`. Close with `button "Close task"` or `key "Escape"`, and check that `?task=` is removed.
- Needs-you buttons: `find "Review"`, `find "Answer"`, `find "Start"` inside the drawer header.
- Ground truth: `GET /api/workspaces/<id>/tasks/<taskId>` → `{task, visits[{runs}], timeline}`.

## Gotchas

- The clock ticks every 1s while any run is running, otherwise every 30s.
- A 404 shows "This task no longer exists." with **Close**.
- An archived task's drawer has no stage panel, a disabled stepper, read-only Details, and chats that say transcripts were removed.
- The Needs you counter does not open the drawer. It goes to Open conversations. To reach the chat from the drawer, use **Review** or **Answer** in its header.
