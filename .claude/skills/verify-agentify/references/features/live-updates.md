# Live updates

Every screen stays current through a per-workspace server-sent event stream, so changes from agents, other tabs or the API show up without a reload.

## Sub-features

- stream: `GET /api/workspaces/<id>/events` sends `ready` immediately, a `ping` every 15s, then `task.changed`, `workflow.changed`, `run.changed`, `timeline.appended` and `run.log`.
- batching: structural events mark queries dirty and flush after 100ms (tasks, workflows, workflow usage, a task's detail and artifacts, a run's log).
- log streaming: `run.log` lines are appended straight into a cached run log, so chats and inline logs grow live.
- watchdog: 40s of silence counts as a dead stream and triggers a reconnect. Errors retry after 2s.
- indicator: the sidebar shows **Live** or **Offline** ("Reconnecting to the server…").
- tab title: the needs-you count in the title updates from the same data.

## How to get to it (user POV)

It works without any action from the user. Watch the Live dot in the sidebar footer.

## Driving it

- Two-tab check: open the same board in a second tab (`tabs_create` → `navigate`), move a card in tab 1, and confirm tab 2 updates without a reload.
- API-driven check: `POST .../tasks` via curl, then confirm the card appears on the open board.
- Disconnect: `preview_stop` the dev server and expect **Offline**. Restart it and expect **Live** again within a few seconds.

## Gotchas

- Forms with unsaved edits (Details tab, workflow editor) do not take live data. The editor shows the stale-version callout instead.
- A restarted server can leave a proxied stream half-open with no error, and the 40s watchdog exists for that case.
- Each workspace has its own stream, and switching workspace re-subscribes.
