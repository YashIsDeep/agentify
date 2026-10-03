# Status counters

Counts at the foot of the sidebar of active tasks across every workflow in the workspace, grouped by what they are waiting on.

## Sub-features

- needs-you: the **Needs you** button (bell icon, `aria-label "Needs you: N"`) opens the Open conversations page. It stays visible at 0 while that page is open, and is `aria-current="page"` there.
- running: the **Running** menu (spinning icon) lists running tasks with a hint line such as "<what> · <workflow> · <stage>".
- stopped: the **Stopped** menu (`aria-label "Failed, or waiting for a usage limit: N"`) lists failed and quota-wait tasks: failures first, then quota waits by soonest reset.
- tab-title: the document title becomes `(N) Agentify` while N tasks need you.
- hint text: "Question from <agent>", "Approve: <action>", "Start <stage>'s actions", "<action> failed/cancelled", "<agent> resets 2:40 AM".

## How to get to it (user POV)

Look at the bottom of the sidebar. A counter appears only when its count is above zero. Click a task in the Running or Stopped menu to open it on its own board. Click Needs you to go to the conversations queue.

## Driving it

- `find "Tasks by status"` returns the group. Click a counter by its aria-label prefix.
- Menus open upward (`side="top"`). Use `read_page` after clicking to get the items.
- **Needs you** has no task menu. It opens Open conversations, where you pick the task and answer or review inline. Only Running and Stopped list tasks.
- Source of truth: `GET /api/workspaces/<id>/tasks?status=active` with each task's `badge` / `badgeDetail`.

## Gotchas

- Queued tasks are not counted. They are only waiting for a concurrency slot.
- A coding agent blocked on a question is still `running` to the engine, but its badge is `needs-you`.
- With a single workflow, the hint omits the workflow name.
- If the whole group is empty it renders nothing, so don't treat a missing group as a bug.
