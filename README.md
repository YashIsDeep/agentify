# Workflow Manager

Local, single-user app for moving tasks through workflow stages that fire actions
(coding agents, shell commands, artifacts, JIRA/Linear/Notion updates). Design: [docs/DESIGN.md](docs/DESIGN.md).

## Run

```bash
npm install
npm start
```

The API listens on `http://127.0.0.1:4280`. Data lives in `%USERPROFILE%\.workflow-manager`.

| Env var | Default | |
|---|---|---|
| `WM_DATA_DIR` | `~/.workflow-manager` | database, artifacts, transcripts, worktrees |
| `WM_PORT` | `4280` | |
| `WM_MAX_CONCURRENT_AGENTS` | `3` | cap on concurrent long-running actions |

`npm start` builds the web app and serves it, with the API, from that address.

## Coding agents

`coding-agent` actions drive the CLIs you already have, headlessly. Install and log into
whichever ones you want:

```bash
npm i -g --allow-scripts=@anthropic-ai/claude-code,opencode-ai @anthropic-ai/claude-code @openai/codex opencode-ai
```

Then `claude auth login`, `codex login`, `opencode auth login`. The **Agents** tab shows each
CLI's version, executable and login state, lets you override the executable path, and sends a
one-line test prompt so you can confirm a working setup before a task depends on it.

Each CLI uses its own login. The app stores no agent credentials and strips `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` from the agents' environment, so your subscriptions are used rather than
pay-as-you-go API keys.

Pick the agent per run from the dropdown in the retry dialog, per task in the task drawer, or
leave it to the binding's default.

**Models are chosen from a dropdown, never typed.** The options come from the CLIs themselves —
`opencode models` lists whatever providers you have configured, and Claude and Codex offer their
documented aliases. The same list is checked when a template is saved, so a model the agent doesn't
accept is rejected there rather than halfway through a workflow. Leave it blank for the CLI default.

## Templates

The **Templates** tab edits the workflows themselves: stages and their order, the phases inside
each stage, and the actions bound to them. Edits are a local draft until you press **Save**.

Editing a template that tasks are using is safe. A task snapshots its stage's phases when it
enters, so changes take effect from the next stage visit and nothing rewrites history. The
server refuses saves that would strand work — deleting a stage with active tasks in it, leaving
an action pointing at a phase or stage that no longer exists, or duplicating an action key.

## Tasks

Repository and base branch are pickers, not typed paths: the repository list is built from
repositories your other tasks use (with manual entry for a new one), and branches come from that
repository. Both are checked when you save the task, so a wrong path fails there instead of
part-way through a workflow.

Link types are chosen from a list and stored lower-case, because prompts and integration actions
read them by exact name — `{{task.links.jira}}`.

## Connections

The **Connections** tab holds the credentials the Jira, Linear and Notion actions use:

| Service | What to paste | Where it comes from |
|---|---|---|
| Jira | site URL, account email, API token | Atlassian account → Security → API tokens |
| Linear | personal API key | Linear → Settings → Security & access |
| Notion | internal integration token | notion.so/my-integrations — then **share the page or database with the integration**, or the API answers 404 |

**Test** authenticates and tells you who you are, so a bad token fails here rather than mid-workflow.

Credentials are stored in `secrets.json` beside the database, never inside it — so the database
stays safe to copy and a duplicated template never carries a token with it. Secrets are write-only:
once saved, the browser is only told that they are set.

An integration action can sit unconfigured while it is disabled; enabling one needs a connection,
and the template editor refuses to save until you pick one.

The Jira and Linear actions take their issue from the task's `jira` / `linear` link — set those in
the task drawer, using a key like `KAN-12` or `ENG-7` (a pasted issue URL works too). A task with no
such link skips the action instead of failing, so you can bind it to every stage; a link that is
present but unreadable is still an error.

## Develop

```bash
npm run dev          # API on :4280 (reloads) + Vite UI on http://localhost:5173
npm test             # server + web vitest suites
npm run typecheck
npm run db:generate -w server   # after editing server/src/db/schema.ts
```

In dev mode the server keeps its data in `<repo>/.wm-data` (gitignored), so experiments never touch
your real tasks. Delete that folder to start fresh.

## Layout

```
shared/   request schemas + view types shared by server and web
web/      React + Vite UI: board (dnd-kit), task drawer, live updates over SSE (src/live.ts)
server/
  src/engine/    engine.ts (state transitions), runner.ts (executes runs), template.ts
  src/actions/   action plugins + registry
  src/agents/    one adapter per CLI (spawn args + output parser), resolution, run orchestration
  src/integrations/  one adapter + API client per service (Jira, Linear, Notion)
  src/api/       Hono routes, localhost-only guard, SSE
  src/services/  templates.ts (template editing + validation), connections.ts, archive, settings
  src/seed/      default workflow templates
  drizzle/       SQL migrations
```
