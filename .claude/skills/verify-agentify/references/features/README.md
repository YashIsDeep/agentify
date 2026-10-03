# Agentify feature map

This is an inventory of what Agentify does, described as behaviour. Agents use it to work out where a
feature lives, how a user reaches it and what counts as evidence that it works. Humans can use it as
the regression checklist.

Each area has one file. Shared conventions are in this README, and cross-surface journeys are in one
file at the end.

## Baseline preconditions

- Dev server via `preview_start { name: "workflow-manager-dev" }`: UI on `localhost:2712`, API on `127.0.0.1:2711`, data in `<repo>/.wm-data`.
- A fresh data dir seeds two workflows, **Feature** and **Bugfix**, in the **My workspace** (`default`) workspace.
- The sidebar is the only navigation. There is no top bar, and pages are not reachable from anywhere else.
- Prefer ARIA labels and visible text over class names. Most icon buttons have an `aria-label`, which is also their tooltip.
- Live updates arrive over SSE. Wait for the end state; don't sleep.
- Coding agents use the person's real CLI logins. Use shell, approval and move-stage actions to exercise the engine unless the change is about agents.
- Desktop layout is above 899px. At 899px and below the sidebar becomes a slide-in drawer behind a ☰ toggle. The task drawer goes full width and the chat list becomes a select at 720px and below, the workflow editor's stage list becomes a select at 760px and below, and further phone rules start at 599px.

## Proof and skip reporting

The relevant feature file defines what has to be covered for a fix or a feature. If the change crosses
surfaces (board ↔ drawer ↔ chat ↔ conversations), also read `multi-surface-journeys.md`.

- Exercise every entry point the change can affect: the board card, the drawer stepper, sidebar counters, Open conversations, a deep link.
- Cover the success, cancel, error, empty and persistence paths: reload, back/forward, and a second tab via SSE.
- Record the action taken and the final observable state, such as a badge, timeline event, toast or API JSON.
- If a path is unreachable (no Jira/Linear/Notion account, an agent CLI that isn't logged in, a real phone), name it, say what blocks it, and cover the closest real path.

## Full sweep

For a broad regression, walk this map from top to bottom, then finish with `multi-surface-journeys.md`.

**Preflight.** Do these in order, and stop if one fails.

1. Pin the target: `git status --short` is empty, and the report records `git rev-parse --short HEAD`.
2. `npm run typecheck` and `npm test` pass.
3. Build a clean sandbox: `node .claude/skills/verify-agentify/scripts/new-sandbox.mjs`. It creates `C:/code/wm-qa` with `repo` (tiny-cart: a deliberate `applyDiscount` bug and one failing `node --test`), `origin.git` (a plain bare remote) and an empty `data`. It refuses a directory that already exists, so every sweep starts from the current seed.
4. `preview_start { name: "workflow-manager-qa" }` builds the app and serves the UI and the API together on `127.0.0.1:2816`. Wherever this map says `2711` or `2712`, use `2816`.
5. Read `GET /api/workspaces/default/agents` and note which agents are `installed` and `loggedIn`. New tasks use `C:/code/wm-qa/repo` as their repository.

**Quota budget.** Everything that a shell, approval or move-stage action can prove is proved that way. Real agents run only for the "Agents at work" section, on the cheapest model of one logged-in agent (Claude Code `haiku`, effort `low`, unless the person names another), once per item: a single run with the approval gate, one `ask_user` round, a plan loop, an implement loop, and a CI loop's fix turn. A second agent is used only for the agent-switch paths. If an agent is out of quota, use that as the quota-wait test and don't retry it.

**Unreachable paths.** Check each of these at the start and list the ones that apply in the report, with the closest path covered instead:

- An agent CLI that is missing or not logged in: cover its Agents-page card (readiness, install and login commands) and the failed **Test agent**.
- No Jira / Linear / Notion credentials: cover add, save, the failing **Test**, delete, and the action's error with a bad connection. Drafting a task from a ticket is skipped.
- No `gh`, or a remote that isn't GitHub or GitLab (the sandbox origin is neither): cover the push and the **Require a merge request link** failure. Opening a real MR or PR is skipped.
- A real phone: cover the narrow layouts with `resize_window`.

**Report.** Write `docs/QA-<yyyy-mm-dd>.md` in the shape of the earlier QA reports: verdict, setup (commit, port, agents and models used), findings by priority with file links, what worked, what was skipped and why, and what is left on disk. Under it, one row per feature file in map order:

| Feature file | Result | Evidence |
|---|---|---|
| board | pass / fail (F-number) / partly skipped | the action taken → the observable end state |

A feature file with no row means the sweep isn't finished. Fix the map in the same change when a label, route or gotcha in it turns out to be wrong.

## Shell & navigation

- [sidebar](sidebar.md): Brand, page links, Boards list, live indicator, theme toggle, narrow-screen drawer.
- [workspaces](workspaces.md): Workspace switcher, new/clone/rename, per-workspace data isolation.
- [status-counters](status-counters.md): Needs you / Running / Stopped counters, tab-title count.
- [deep-links-and-guards](deep-links-and-guards.md): Query-string routing, back/forward, unsaved-changes guards.

## Board & tasks

- [board](board.md): Columns, WIP limits, task cards, drag-and-drop and keyboard moves, the "What runs" popover.
- [new-task](new-task.md): New task dialog, drafting from a Jira/Linear ticket, repository/branch pickers, worktree option.
- [move-task](move-task.md): Move dialog, reached by drag or by the drawer stepper, and "Run its actions".
- [task-drawer](task-drawer.md): Drawer header, the "needs you" button, stage stepper, description, tabs.
- [stage-panel](stage-panel.md): Current stage's action rows, Retry/Skip/Cancel/Try now, standalone Approval decision.
- [task-details](task-details.md): Details tab: editable fields, agent overrides, Git/Outputs/History.
- [activity-and-artifacts](activity-and-artifacts.md): Activity timeline grouped by stage visit; Artifacts tab.

## Agents at work

- [agent-chat](agent-chat.md): Chat window: chat list, transcript, tool rows, raw log, copy, follow-tail.
- [agent-review](agent-review.md): Review card: request revision, approve and continue, send back, diff, draft persistence.
- [agent-questions](agent-questions.md): The `ask_user` MCP tool and the question card (answer, Let it decide, Use recommended).
- [open-conversations](open-conversations.md): The queue page for everything waiting on you.
- [loop-modes](loop-modes.md): Single run, Plan loop, Implement loop, CI loop.
- [quota-queue-restart](quota-queue-restart.md): Usage-limit waits, the concurrency queue, runs interrupted by a restart.

## Configuration

- [workflow-editor](workflow-editor.md): Workflows page: stages, actions, settings dialogs, save bar, duplicate/delete.
- [action-types](action-types.md): Every action type, with its key fields and runtime behaviour.
- [agents-page](agents-page.md): Agent cards (readiness, defaults, test, path), Concurrency, Ticket drafting.
- [connections](connections.md): Jira / Linear / Notion credentials: add, save, test, delete.

## History & system

- [archive](archive.md): Archive page, search, read-only archived drawer, what archiving removes.
- [live-updates](live-updates.md): SSE stream, Live/Offline indicator, reconnect watchdog.
- [ui-kit](ui-kit.md): Design-system gallery at `?view=ui-kit`; light/dark themes.

## Multi-surface journeys

- [multi-surface-journeys](multi-surface-journeys.md): End-to-end paths that cross the board, the drawer, chat, conversations and other tabs.

## Entry contract

Every feature file uses the same four H2s:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it`
4. `Gotchas`

Keep entries at the level of behaviour, anchored on visible labels or ARIA names. Update the file in the
same change as the UI it describes.
