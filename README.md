# Agentify

Local, single-user app for moving tasks through workflow stages that fire actions
(coding agents, shell commands, artifacts, JIRA/Linear/Notion updates). Design: [docs/DESIGN.md](docs/DESIGN.md).

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:2712`. Data lives in `%USERPROFILE%\.agentify` (an existing `%USERPROFILE%\.workflow-manager` from before the
rename is still used when `.agentify` doesn't exist).

This is a trusted, single-user local application. It listens on loopback only, unless you turn
on remote access (below), and then only devices you pair on your own network or tailnet get in.
Don't put it behind a public tunnel: it refuses requests from public addresses anyway.
Autonomous agents and shell actions run with your OS account's access, including access to the
local API. Workspaces and approval steps organize work; they do not isolate a hostile local
process. Use a separate OS account or VM for untrusted repositories and agents. See
[the security review](docs/SECURITY-2026-09-24.md). The [filesystem follow-up](docs/SECURITY-2026-09-25.md)
documents additional link and temporary-file protections, including restrictions on linked
carry-over paths and static assets.

| Env var | Default | |
|---|---|---|
| `WM_DATA_DIR` | `~/.agentify` | database, artifacts, transcripts, worktrees |
| `WM_PORT` | `2712` | `2711` under `npm run dev`, where Vite holds 2712 |
| `WM_REMOTE_HOST` | `0.0.0.0` | the address remote access listens on, e.g. only your Tailscale IP |

`npm start` builds the web app and serves it, with the API, from that address.

## Use it from your phone

On this computer, open **Devices** in the sidebar and turn on **Remote access**. The page lists
the addresses another device can open, and **Connect a device** shows a QR code and a code to type.

- **Same Wi-Fi:** scan the QR code with the phone's camera. The first time remote access is on,
  Windows Firewall asks whether Node.js may accept connections: allow it on private networks only.
- **Away from home:** install [Tailscale](https://tailscale.com) on this computer and the phone,
  then run `tailscale serve --bg 2712` here once. Devices then offers an
  `https://<computer>.<tailnet>.ts.net` address that works wherever the phone has Tailscale.

A paired device can do everything except turn remote access on or off and pair or remove devices,
which stay on this computer; it can sign itself out. It stays paired until you remove it or it goes
30 days unused. Your own browser on this computer never pairs.

Under `npm run dev` the page comes from Vite, which only listens locally: start the web half with
`npm run dev -w web -- --host` to reach it from a phone.

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

**Models and reasoning effort are chosen from dropdowns, never typed.** The options come from the
CLIs themselves — `codex debug models` gives your account's Codex models and the effort levels each
supports, `opencode models --verbose` lists whatever providers you have configured with each model's
variants, `cursor-agent models` lists your Cursor account's models (pick a thinking variant there;
Cursor has no separate effort setting), and Claude offers its documented aliases and `--effort`
levels. The same lists are checked
when a workflow is saved, so a model the agent doesn't accept, or an effort that model doesn't offer,
is rejected there rather than halfway through a workflow.

Set a **default model and effort per agent** on the Agents page, and a **default agent, model and
effort per stage** in the workflow editor. A run takes the first choice it finds: the retry dialog,
then the task's overrides, then the action, then its stage's default, then that agent's default,
then the CLI's own. A model or effort set for one agent is never handed to another, and an effort
goes with the model it was chosen alongside, so a default's effort never lands on a model picked
somewhere else.

**Watching an agent.** Click a coding-agent run to open its chat: the agent's messages, each tool
call paired with what it returned (click one to expand it), the questions it asked with your
answers, and a raw log you can copy. The sidebar lists every agent run on the task — earlier
attempts, retries, other stages — so you can go back to a previous chat. While the agent works the
view follows along; scroll up and it stays put. Agents run headlessly, so a chat is mostly for
reading — you can type into it at the two moments the agent is listening: a question it stopped to
ask, and the approval it waits on when it has finished, where what you send resumes the same session.

## Workflows

Shell commands cannot use `{{...}}` interpolation: task text could otherwise become executable
shell code. Use the supplied `WM_*` environment variables as data instead, such as
`Write-Output $env:WM_TASK_TITLE` in PowerShell or `printf '%s\n' "$WM_TASK_TITLE"` in Bash.
For cmd.exe workflows, a script that reads `process.env.WM_TASK_TITLE` avoids cmd expansion
pitfalls. Existing saved commands using interpolation must be updated before retrying.

The **Workflows** tab edits a workflow's shape: its stages and their order, and each stage's
list of actions. A task entering a stage runs its actions top to bottom, one at a time. A coding
agent can be told to **wait for your approval** when it finishes, so nothing below it runs until you
approve — or you ask for changes and the same agent picks them up. A standalone **Approval** action
is for checkpoints that follow no agent, and moving on is just a *Move to stage* action at the end. Edits are a local draft until you press **Save**.

**Loop modes.** Every coding agent runs in one loop mode, chosen under **Loop** in its settings.
**Workflows → Add action** also offers each loop as a ready-made preset:

- **Single run:** one agent run with no automatic review. **Autonomy** decides whether it may edit the repository.
- **Plan loop:** draft → independent review → revise → re-review, read-only. Requested corrections go back to the author, and the revised document is reviewed again. The preset saves the accepted document as `plan.md`.
- **Implement loop:** implement → independent review → the reviewer fixes the code and runs relevant checks → repeat until accepted.
- **CI loop:** publish (optional) → check → fix failures → publish → check again. Only a zero exit status from the check command counts as passing.

A loop's review happens whether or not the action waits for your approval; with **Wait for my
approval** on, only the final work reaches you. Review feedback stays in the transcript and is
never saved over the document. Invalid reviews or blocked fixes fail the action instead of asking
you to approve unfinished work. Loops default to three correction attempts (configurable from
1–10); reaching the limit fails the action with the remaining feedback. Quota waits keep the phase
and attempt count.

Coding agents saved before loop modes are converted when the server starts: one that waited for
your approval with its automatic review on becomes a plan loop if it was read-only, otherwise an
implement loop; any other becomes a single run. An autonomous agent that saved an artifact used to
get a document review and now gets a code review; the server logs each one it converts that way.

For **CI check command**, use the repository's local test/build commands, a remote CI check command,
or a script combining both. The script must propagate failures, wait for remote checks on the current
commit, and fail if required checks are absent. **CI publish command** optionally commits and pushes
before every check; leave it blank for local checks or a branch already published by an earlier action.
Use repeatable commands and `WM_*` environment variables for task values; command templates are rejected.
New default workflows include a disabled CI loop after opening the merge request. Configure the
repository-specific commands before enabling it. Passing CI never merges the request automatically.

**Reviewing and revising agent work.** Open the task and click **Review & revise** when the result
is ready. The feedback box stays below the chat: type what you want changed and click **Request
revision**. The agent resumes its session, updates the result, and returns for review. Repeat as
often as needed; only **Approve & continue** releases the next workflow action. Send or clear any
unsent feedback before approving. You can draft feedback while the agent works, and closing the
chat keeps that draft in this browser tab. New coding-agent actions added in the editor have
**Wait for my approval when it finishes** enabled by default. For an existing action, enable that
option and save the workflow before its next stage visit; already-started runs keep their original settings.

Editing a workflow that tasks are using is safe. A task's actions are copied when they start, so
changes take effect from the next stage visit and nothing rewrites history. The server refuses
saves that would strand work — deleting a stage with active tasks in it, leaving an action
pointing at a stage that no longer exists, or duplicating an action key.

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
stays safe to copy and a duplicated workflow never carries a token with it. Secrets are write-only:
once saved, the browser is only told that they are set.

Jira URLs must use HTTPS (a bare hostname defaults to HTTPS). Integration requests refuse
redirects; configure the final API host directly. API request bodies are limited to 2 MiB.

An integration action can sit unconfigured while it is disabled; enabling one needs a connection,
and the workflow editor refuses to save until you pick one.

The Jira and Linear actions take their issue from the task's `jira` / `linear` link — set those in
the task drawer, using a key like `KAN-12` or `ENG-7` (a pasted issue URL works too). A task with no
such link skips the action instead of failing, so you can bind it to every stage; a link that is
present but unreadable is still an error.

## Develop

```bash
npm run dev          # Vite UI on http://localhost:2712 + API on :2711 (reloads)
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
  src/agents/    one adapter per CLI (spawn args + output parser), resolution; turns.ts (every call a
                 coding-agent run makes to its agent) and the loops built on it (loops.ts, review.ts, ci-loop.ts)
  src/integrations/  one adapter + API client per service (Jira, Linear, Notion)
  src/api/       Hono routes, localhost-only guard, SSE
  src/services/  workflows.ts (workflow editing + validation), connections.ts, archive, settings
  src/seed/      default workflows
  drizzle/       SQL migrations
```
