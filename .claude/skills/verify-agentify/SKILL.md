---
name: verify-agentify
description: Drive Agentify (this repo's web app) in the Browser pane and over its local API to reproduce bugs and prove UI changes work. Use when verifying a change, reproducing a report ("the review button does nothing", a screenshot), or sweeping for regressions. Read references/features/ first to find where a feature lives and how to reach it.
---

# Verify Agentify

Agentify is a local, single-user React + Hono app. Tasks move through workflow stages, and each stage
fires actions such as coding agents, shell commands, approvals and Jira/Linear/Notion updates. This
skill covers how to drive it. The **feature map** in `references/features/` says what exists and how a
user reaches it.

## Orientation

- Start with `references/features/README.md`. It indexes every feature file and gives the regression order.
- Each feature file answers four questions: what sub-features exist, how a user gets there, how to drive
  it here, and what tends to go wrong.
- Use the map to find the right screen, then read source only for the behaviour you are changing.

## Quick start

1. `preview_start { name: "workflow-manager-dev" }` runs `npm run dev`. Vite serves the UI on
   `http://localhost:2712`, and the API runs on `127.0.0.1:2711`. Data goes in `<repo>/.wm-data`, never in
   the real `~/.agentify`. To start from a clean slate, delete `.wm-data` and restart.
2. For an isolated dataset, use `workflow-manager-e2e` (`WM_DATA_DIR=C:/code/wm-e2e-data`). For the built
   app on its own port, use `workflow-manager-ux-review` (2814) or `workflow-manager-poker-e2e` (2813).
   For a full sweep, use `workflow-manager-qa` (2816) after `node .claude/skills/verify-agentify/scripts/new-sandbox.mjs`;
   see "Full sweep" in `references/features/README.md`.
3. Check `read_console_messages { onlyErrors: true }` and `preview_logs { serverId, level: "error" }`
   before you start, so you know which errors were already there.

## Driving it

**UI (Browser pane).** Read text with `read_page` / `find` / `get_page_text`, and click by `ref`. Prefer
ARIA names: the app labels its icon buttons (`aria-label="Close task"`, `"Archive task"`, `"New task"`,
`"What runs in <Stage>"`), and landmarks have names (`nav "Workspace navigation"`, `aside "Task details"`,
`group "Tasks by status"`, `nav "Chats in this task"`). Class names (`.card`, `.run`, `.chat-window`) are
the fallback.

**Deep links.** All navigation state is in the query string, so `navigate` can land on any screen:

```
/?workspace=<id>&workflow=<id>&view=<board|archive|agents|workflows|connections|conversations|ui-kit>&task=<id>
```

Omitted params fall back to `workspace=default`, the first workflow, and `view=board`.

**API (curl).** The browser goes through `/api/workspaces/<workspaceId>/...`. Hit the API directly to
seed state or read the ground truth after a UI action:

```bash
curl -s http://127.0.0.1:2711/api/workspaces/default/workflows
```

```bash
curl -s "http://127.0.0.1:2711/api/workspaces/default/tasks?status=active"
```

```bash
curl -s -X POST http://127.0.0.1:2711/api/workspaces/default/tasks -H "content-type: application/json" -d "{\"workflowId\":\"<id>\",\"title\":\"Probe\"}"
```

The examples use the dev API port. A built server (every launch config except `workflow-manager-dev` and
`workflow-manager-e2e`) serves the UI and the API on its one port, so swap `2711` for that port.

The localhost guard rejects non-local `Host` headers and foreign `Origin`s, and a plain curl to 127.0.0.1
passes it. Routes are defined in `server/src/api/app.ts` (per-workspace) and `server/src/workspaces.ts`
(workspaces and concurrency).

**Live state.** `GET /api/workspaces/<id>/events` is an SSE stream (`task.changed`, `run.changed`,
`timeline.appended`, `run.log`, `workflow.changed`). Most screens refresh from it, so wait for the
observable end state (a badge, a toast, a row) rather than sleeping.

**Agents without spending quota.** A real coding-agent run uses the person's own CLI login and
subscription. Prefer a shell action (`node -e "..."`) or a `move-stage` / `approval` action to exercise
engine paths. Run a real agent only when the change is about agents, and say that you did.

## Proof bar

A screenshot of the page loading is not proof. Run the production user path for the changed
behaviour and show the observable result a skeptical reviewer would accept: the badge that changed,
the timeline event, the API response after the click. Cover the entry points, empty/error/success paths
and persistence (reload, back/forward) that the feature file lists for the area you touched. If a path
can't be reached (needs a Jira account, a real agent login, a phone), name it and cover the closest
real path that remains.

## Keeping the map true

The feature map is maintained like code. A change that adds, renames, moves or removes something a user
can see or do updates the matching file in `references/features/` in the same change. That includes a
label, an ARIA name, a route param, a dialog, a keyboard chord or a gotcha you discovered while
verifying. A new area gets a new file and a line in the README index. Keep entries at the level of
behaviour, grounded in visible labels or selectors, and short enough to run without reading source.
