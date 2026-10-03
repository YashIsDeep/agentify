# Board

A workflow's kanban board. It shows one column per stage with the active tasks in it, oldest arrival first.

## Sub-features

- heading: workflow icon + name (h1), "N active tasks", and a primary **New task** button (label hidden on narrow screens, `aria-label "New task"`).
- columns: `section` named after the stage (`aria-label=<stage>`, `data-stage-id`). The header shows the stage name, a count tag, and a "count/limit" tag that turns warn-toned with the title "Over the WIP limit".
- what-runs popover: an icon button `"What runs in <Stage>"`, present only if the stage has enabled actions. It lists "Runs in order on entry": each action's label, type, "Waits for you", "Can send back to X", the pinned agent/model/effort, "Continues if it fails", and finally "Switched off: …".
- task-card: a status badge (hidden when idle), time in stage, title, progress dots (done/total actions with the current one tinted by badge), then tags for branch (without `wm/`), links and tags.
- badges: Running, Quota wait → "Resets 2:40 AM", Queued, Failed / Cancelled, Needs you / "Ready for review", Archived.
- drag-and-drop: dnd-kit with a 6px pointer threshold so clicks still open the card. Dropping on another column opens the Move dialog (`move-task.md`).
- keyboard: card `aria-label "<title>. Press Enter to open, Space to move."`. Space picks up, arrows move, Space drops, Escape cancels.
- first-work reveal: on first load of a wide board, it scrolls horizontally to the first column with tasks, once per board.
- empty: "No tasks yet" in the first column when the board is empty.
- no workflows: a "No workflows yet" splash with **Create workflow**.

## How to get to it (user POV)

Click a workflow under **Boards** in the sidebar, or the Agentify brand for the current board.

## Driving it

- `find "New task"` to create. `find "<task title>. Press Enter"` for a card. Click it to open the drawer, which sets `?task=`.
- Drag: `left_click_drag` from the card to another column's header area, then expect `dialog "Move task"`.
- Keyboard move: focus the card, `key "space"`, repeat `key "ArrowRight"` until the next column is the drop target, then `key "space"`. Each arrow press moves the card 25px and columns are at least 240px wide, so one press is not enough. Escape cancels.
- Read columns with `read_page` and look for `region`/`section` names that match the stages.
- Ground truth: `GET /api/workspaces/<id>/tasks?workflowId=<id>&status=active` (`currentStageId`, `badge`, `actionProgress`).

## Gotchas

- Dropping on the same column does nothing, so no dialog appears.
- Card ages tick every 30s (`useNow(30_000)`), so don't assert exact ages.
- The WIP limit only warns. It never blocks a move.
- Archived tasks never appear on the board. Look in the Archive page.
