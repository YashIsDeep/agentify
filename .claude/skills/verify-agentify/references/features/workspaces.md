# Workspaces

Separate sets of workflows, tasks, agent settings and connections. Each workspace has its own database and secrets file. The agent concurrency cap is shared by all of them.

## Sub-features

- switcher: a menu at the top of the sidebar (`button "Workspace: <name>"`) showing an avatar letter and the name. Items: each workspace (current one ticked), then **New workspace**, **Clone workspace**, **Rename workspace**.
- create: the **New workspace** dialog has a **Workspace name** field and a **Create workspace** button. It switches to the new workspace.
- clone: the **Clone workspace** dialog defaults the name to "<name> copy". It copies workflows, agent settings and connections, credentials included, but not tasks.
- rename: the **Rename workspace** dialog, with **Save**.
- isolation: each workspace gets its own API client and query cache. A mutation that finishes after you leave a workspace never navigates the one you are in now.
- not-found: an unknown `?workspace=` shows a "Workspace not found." splash with **Back to My workspace**.

## How to get to it (user POV)

Click the workspace name under the Agentify brand in the sidebar.

## Driving it

- `find "Workspace:"`, click it, then click the menu item by its text.
- API: `GET /api/workspaces`, `POST /api/workspaces {name}`, `POST /api/workspaces/<id>/clone {name}`, `PATCH /api/workspaces/<id> {name}`.
- Per-workspace data is under `<dataDir>/workspaces/<id>/`. The `default` workspace uses the data dir root.
- Deep link: `?workspace=<id>`. Switching clears `workflow`, `view` and `task`.

## Gotchas

- Name max length is 80. An empty name keeps the submit button disabled.
- Clone carries credentials. The dialog says so in its field note, and that note is the one sentence the app deliberately keeps visible.
- Concurrency (Agents page) is global. Setting it in one workspace changes it everywhere.
- The catalogue refetches on window focus, so a workspace created in another tab appears when you return.
