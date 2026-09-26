# Agentify — Design

A local, single-user web app for moving tasks through configurable workflows whose
stages fire actions (coding agents, JIRA/Linear/Notion updates, shell commands, artifacts).

Status: design agreed through grilling rounds 1–4 (round 3 decided by Claude on request);
remaining open items in §8.

---

## 1. Core concepts

| Concept | What it is |
|---|---|
| **Workflow** | Ordered list of stages. Many workflows exist; edited in the UI; stored in SQLite; defaults seeded on first run. |
| **Stage** | A column. Has an ordered list of **actions**, run top to bottom. Optional WIP limit (warning only). |
| **Action** | One entry in a stage's list (a *binding* in code): action type + config, enabled, *continue if this fails*. A coding agent can be told to wait for your approval; a standalone **Approval** is a checkpoint that follows no agent. |
| **Task** | The thing that moves. Bound to one workflow at creation, forever. |
| **Stage visit** | One stay of a task in a stage. Re-entering a stage creates a new visit (`attempt 2`) whose actions run again. A visit's runs, config included, are created when its actions start, so workflow edits apply from the next visit. |
| **Timeline** | Append-only per-task event log, grouped by stage visit. |
| **Action run** | One execution of an action. Status: `waiting · queued · running · awaiting-approval · quota-wait · succeeded · failed · cancelled · interrupted · skipped`. |
| **Outputs** | Structured values an action run returns; stored on the task; referenceable later. |
| **Artifacts** | Files under the task's artifact dir. Survive archival. |
| **Connection** | Named credential set (`work-jira`, `personal-linear`) stored outside the DB. |

### Task fields
Title, markdown description, workflow, optional repo (`repoPath`, `baseBranch`),
`useWorktree` (default on; off = `ensure-worktree` skips and agents, commands and
`open-merge-request` work in the repo's own checkout on its current branch; can't be turned off
once the worktree exists), derived `branch` / `worktreePath`, external links (`[{type, idOrUrl}]` — set in the New task
dialog — first there, since a ticket link can draft the title and description (§3.5) — or the Details tab; a pasted Jira/Linear/Notion/GitHub/GitLab URL picks its type), tags (Details tab only — not asked for on the New task dialog),
optional **agent**, **model** and **effort overrides** (see §3), `lastFeedback`.
No custom fields in v1.

---

## 2. Engine semantics

### Ordered actions
Step 9 replaced phases and triggers (`stage.entered`, `phase.started`, `manual`, `action.succeeded`, …):
an action's place in the flow was spread over its trigger, its phase and an "after" link, so a stage
couldn't be read at a glance. A stage is now just a list.

1. Task enters stage → new visit → one run per **enabled** action, in list order (one batch).
2. The first run is queued; each later one waits until the run above it **settles** — succeeded,
   skipped, or failed with *continue if this fails*. One action per visit runs at a time; different
   tasks run concurrently.
3. A run that waits for you sits `awaiting-approval` with its instructions rendered and the task
   badged *needs you*, until **Approve** (the list carries on) or **Send back** (optional note →
   `task.lastFeedback`; the task moves to that stage and nothing after the run starts). Two kinds
   reach that state: a **coding agent** with *wait for my approval* on — its process has already
   exited, so it holds no concurrency slot — and a standalone **Approval**, which never reaches the
   runner at all. An agent's approval adds **Request changes**: the **same run row** is queued again
   with your note as its prompt, resuming the session it just used, so one run stays one
   conversation however many rounds it takes. Each round's tokens and cost are added to the run's
   `usage`, and its time kept as `usage.priorMs`, so the run reports all its rounds, not the last.
   Runs awaiting you survive a server restart; sending back to the same stage runs it again as a new attempt.

   `task.lastFeedback` is only a Send back's note, and **approving any gate clears it**. A Request
   changes note is not saved there: it went to that agent, and a later stage's prompt reading
   `{{task.lastFeedback}}` would otherwise take it as feedback on its own work (the 24 Sep QA found
   an implementer told to "remove the Open questions section" of the requirements).
4. When every run has settled the visit is **complete**. Moving on is itself an action (`move-stage`,
   usually last); a stage with no actions (Backlog) just holds tasks until they're dragged.

No timers or external signals (webhooks/polling of JIRA, MR merged) in v1.

### Manual moves (drag anywhere, any direction)
- Dialog: "Run its actions" (checked by default). Unchecked, the new visit starts with nothing run,
  the task is badged *needs you*, and the drawer offers **Start**.
- Running actions in the stage being left are cancelled after confirmation
  (AbortSignal → process kill / API cancel).

### Failure
Action → `failed`; the actions below it stay `waiting`. Card shows a red badge; error on the timeline.
Buttons: **Retry** (success resumes the list) and **Skip** (status `skipped`; the list carries on).
An action marked *continue if this fails* records the failure and lets the list carry on — the seeded
Jira/Linear updates are. No auto-retry in v1.

### Usage limits (quota wait)
A coding agent refused by its subscription's usage limit doesn't fail: the run goes to
`quota-wait` with a `resume_at` time, and the actions after it simply wait (no failure, no
concurrency slot held). The runner keeps a timer for the earliest `resume_at` and
requeues the **same run row**, so its transcript continues; if the parked attempt had started a
session, the agent resumes it with a short "carry on" prompt instead of the original one.

- **Detection** (Claude Code and Codex only; OpenCode's "Insufficient balance" is billing, and
  Cursor's wording is unknown): Claude Code's stream-json `rate_limit_event` with
  `status: "rejected"` and `resetsAt`, else the error prose — Codex's *"try again at Sep 6th, 2026
  2:40 AM"*, Claude's *"resets 3pm (Europe/London)"*, epoch or *"in 2h 30m"* forms. A limit with no
  readable time waits 30 minutes; a time already past waits one.
- **Per agent:** the limit belongs to the account, so the agent service holds the reset time in
  memory and any other run of that agent parks straight away instead of spending a request.
- **Try now** requeues a waiting run immediately and lifts the agent's hold; **Cancel** works as
  for any active run. Waiting runs survive a restart.

### Concurrency
Tasks run in parallel (isolated by worktrees). Global cap on concurrent long-running
actions (default 10; set on the Agents page, shared by all workspaces). Excess runs are `queued` and visible on the timeline.

### Restart
On server start: runs in `running` whose process belonged to the previous server are
marked `interrupted` (treated like failed → Retry available). `queued` runs resume.
Agent runs whose CLI supports resume show **Retry (continue session)** so an interrupted
run picks up where it left off. Future remote actions (e.g. Cursor Cloud) resume polling instead.

### Data flow / templating
Mustache-style interpolation (no logic) in any string field of action config:

```
{{task.title}} {{task.description}} {{task.branch}} {{task.baseBranch}} {{task.worktreePath}}
{{task.links.jira}} {{task.links.linear}} {{task.lastFeedback}}
{{artifacts["requirements.md"]}}      # file contents
{{artifactPath["requirements.md"]}}   # absolute path
{{outputs.<bindingKey>.<field>}}      # latest successful run's outputs
{{stage.name}} {{visit.attempt}} {{run.label}}
```

Shell actions receive the same data as env vars (`WM_TASK_TITLE`, `WM_ARTIFACT_DIR`,
`WM_WORKTREE`, `WM_OUTPUT_FILE`, …). Writing JSON to `$WM_OUTPUT_FILE` sets outputs.

---

## 3. Actions (plugin interface)

```ts
interface ActionType<Config, Outputs> {
  type: string;                        // "coding-agent"
  label: string;
  configSchema: ZodType<Config>;       // the authority on what is valid
  fields: ActionField[];               // widgets + defaults for the editor form
  connectionType?: string;             // "jira" | "linear" | "notion" | ...
  longRunning?: boolean;               // counts against the concurrency cap
  run(ctx: ActionContext<Config>): Promise<Outputs>;
}

interface ActionContext<Config> {
  config: Config;                      // already template-rendered
  task: TaskView; visit: VisitView;
  artifactDir: string; worktreePath?: string;
  connection?: Record<string, string>;
  log(event: TimelineEvent): void;     // streamed to timeline + transcript
  writeArtifact(name: string, content: string | Buffer): Promise<string>;
  signal: AbortSignal;                 // cancellation
}
```

### Built-in v1 set
| Type | Does |
|---|---|
| `coding-agent` | Runs a headless coding-agent CLI in the task worktree via an adapter (§3.1). Config: agent, model, reasoning effort, prompt, autonomy, **wait for my approval** (+ instructions, optional Send back stage), continue-session, save-result-as artifact, **inactivity timeout** (default 5 min). |
| `shell` | Runs a command (cwd = worktree or artifact dir). Exit 0 = success. Outputs via `$WM_OUTPUT_FILE` or regex extraction from stdout. |
| `ensure-worktree` | Creates `git worktree` + branch `wm/<task-slug>` from `baseBranch` if missing. |
| `write-artifact` | Writes templated content to a named artifact. |
| `approval` | A checkpoint that follows no agent ("approve once the MR is merged"). Pauses the list until you approve (§2). Config: instructions (templated, shown on the task), optional Send back stage, ask for a note. Settled by the engine; never run. To sign off an agent's work, use that agent's own approval instead. |
| `open-merge-request` | Optionally commits, pushes, and opens an MR/PR: github.com remotes use `gh pr create`, anything else uses GitLab push options. Output `mrUrl`. |
| `move-stage` | `target: "next" \| <stageId>`. |
| `archive-task` | Removes worktree (branch kept) and the links carry-over made in it, without following them; purges transcripts + sync state, moves to archive. The Archive dialog warns before archiving a worktree with uncommitted changes. |
| `jira-transition` | Resolves the transition by name on the issue's current status, applies it, optional comment (converted to ADF). Outputs `issueKey`, `status`. |
| `linear-update` | Finds the issue by `TEAM-123` (or URL), moves it to a named state in its own team, optional comment. Outputs `identifier`, `url`, `state`. |
| `notion-append` | Appends Markdown-derived blocks to a page, or creates a page in a database under its own title property. Outputs `pageId`, `url`. |

Later: Cursor adapter (CLI or Cloud Agents API), `http-request`, timers, inbound signals.

**Editor forms** come from `fields`, published at `GET /api/action-types`, rather than from
reflecting on the Zod schema: each field carries a widget (`text` · `textarea` · `number` ·
`boolean` · `select` · `stage` · `agent` · `key-value`), a default, help text and whether it is
template-interpolated. The schema still decides what is *valid* — saving parses every config
through it, filling defaults and dropping unknown keys.

### 3.4 Choose, don't type

A recurring defect class: a value typed freely into a form, accepted by the server, and only
rejected when something finally ran it — a wrong model mid-agent-run, a mistyped repo path
mid-`ensure-worktree`. Every such field is now a picker backed by a real source, and validated
where it is entered rather than where it is used.

| Field | Source of the options | Checked when |
|---|---|---|
| Coding agent model + effort | the CLIs (`codex debug models`, `opencode models --verbose`, documented aliases) | workflow save, task/retry override, agent default, run |
| Repository | repositories other tasks use, plus manual entry | task create / update |
| Base branch | `git for-each-ref` on the chosen repository | task create / update |
| Task link type | `LINK_TYPES` | lower-cased on write |
| Stage / connection / agent / autonomy | the workflow, saved connections, the registry | workflow save |

Two rules keep it honest. A value the list doesn't contain is still **shown** rather than silently
rewritten — flagged as unrecognised, so an existing workflow is never quietly changed. And fields
that are template-interpolated (`{{task.title}}.md`) skip shape checks, because their real value
isn't known until the run.

The remaining free-text fields are ones with no closed set: titles, descriptions, prompts, tags,
commands, branch prefixes, and the Jira/Linear status names (those *are* validated, but only at run
time and against the issue's own workflow, which is where the authoritative list lives).

### 3.3 Connections

Integration actions declare a `connectionType` and take a `connection`-kind field, so the editor
offers only the credentials that can actually authenticate them.

Credentials live in `secrets.json` beside the database, never in it — the database stays safe to
copy, inspect and export, and duplicating a workflow never carries a token with it. Secret fields
are **write-only**: the API reports which ones are set, never their values, and an update that omits
a secret keeps it (sending `""` clears it). Values the adapter doesn't declare are dropped.

One adapter per service owns its fields, its authentication and a cheap identity call behind the
**Test** button (Jira `/myself`, Linear `viewer`, Notion `/users/me`). `fetch` is injected, so the
adapters and the actions built on them are tested end-to-end without a network.

Errors are reported in the service's own words: each API describes failures differently
(`errorMessages`, GraphQL `errors[]`, `message`), so a wrong token says so rather than "request failed".
Linear needs special care — GraphQL reports authentication failures with HTTP 200 and an `errors` array.

An integration action may sit unconfigured while it is **disabled**; enabling one needs a live
connection, checked when the workflow is saved and again when the action runs.

**Unlinked tasks are a no-op.** `jira-transition` and `linear-update` default their issue to
`{{task.links.jira}}` / `{{task.links.linear}}`, which renders empty on a task with no such link.
An empty reference succeeds with "no issue linked" on the timeline rather than failing, so the
actions can be bound workflow-wide; a reference that is present but unparseable still fails, so a
typo never passes silently.

### 3.5 Drafting a task from its ticket

Links come first on the New task dialog, because a Jira or Linear link holding an issue key can fill
in the title and description: on its own once the link settles while both are still blank, or with
**Fill in from ticket**, which replaces them (after a confirm when either has text). Text typed while
an automatic draft is on its way is kept.

1. The ticket is read through a saved connection — a model can't open a private tracker. Each
   connection of the link's type is tried, the one whose site matches the link's URL first. Jira's
   ADF description is flattened to Markdown.
2. The agent in the **Ticket drafting** setting (Agents view; default Codex `gpt-5.6-luna` at `low`)
   rewrites it as `{title, description}` JSON, read-only in a throwaway directory, with the ticket
   fenced off as data and cut at 12k characters.
3. When that agent can't (usage limit, not installed, a reply that isn't the JSON) the ticket's own
   summary and description are copied and the dialog says why. With no agent set it always copies.

A missing connection, an unsupported link type or an unreadable key fails before any request is made.

### 3.2 Editing a live workflow

Workflows are editable while tasks are running because the runtime keeps its own copies:
stage visits snapshot the stage name, and a visit's runs (config included) are created when its
actions start. Edits therefore apply from a task's **next** stage visit, and history never changes
underneath a task.

The editor sends the whole workflow back as one document; the server diffs it against the
database by id (client-generated, so a new action can reference a new stage before either is
saved). A stage's list order is its actions' order. It refuses a save that would:

- delete a stage that active tasks are standing in (they would be stranded),
- leave a dangling reference — a `move-stage` destination or an approval's Send back stage outside
  the workflow,
- duplicate an action key (`{{outputs.<key>}}` must be unambiguous),
- enable an integration action with no connection chosen, or one since deleted,
- set a coding-agent model the chosen agent doesn't accept, or an effort level that model doesn't offer,
- fail an action's own config schema, or
- overwrite a version saved since the editor loaded it (`updatedAt` precondition).

Deleting a workflow that tasks — active or archived — still reference is refused unless forced.
Forcing deletes those tasks with it: their runs are stopped, their worktrees removed (branches
kept), and their rows, transcripts and artifacts deleted. They don't go to the Archive.

### 3.1 Coding agents

**Agents:** Claude Code · Codex · OpenCode · Cursor Agent. One adapter per agent:

```ts
interface AgentAdapter {
  id: "claude" | "codex" | "opencode" | "cursor";
  detect(): Promise<{ path: string; version: string } | null>;
  buildCommand(opts: {
    prompt: string; model?: string; autonomy: "read-only" | "autonomous";
    resumeSessionId?: string; cwd: string;
  }): { cmd: string; args: string[] };
  parseLine(line: string): AgentEvent[];   // → normalized timeline events
}
type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; name: string; phase: "started" | "completed"; detail?: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: "result"; text: string; ok: boolean };
```

| | Claude Code | Codex | OpenCode | Cursor Agent |
|---|---|---|---|---|
| Headless | `claude -p --output-format stream-json --verbose` | `codex exec --json -o <result-file> -C <dir> -` | `opencode run <msg> --format json --dir <dir>` | `cursor-agent -p --output-format stream-json --trust --workspace <dir> <msg>` |
| Prompt via | stdin | stdin | argv (+ attached file) | argv (long: file + `--add-dir`) |
| Resume | `--resume <id>` | `codex exec resume <id>` | `--session <id>` | `--resume <id>` |
| Model | `--model` | `-m` | `-m provider/model` | `--model` |
| Effort | `--effort` | `-c model_reasoning_effort="…"` | `--variant` | — (thinking variants are model ids) |
| read-only | restricted `--tools` + `--permission-prompts none` + `--allowedTools WebFetch,WebSearch` | `-s read-only` (resume: `-c sandbox_mode="read-only"`) | `--agent plan` | `--mode ask` |
| autonomous | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto` | `--force` |

Flags were verified against each installed CLI (Claude 2.1.267, Codex 0.154.0, OpenCode 1.18.30,
Cursor Agent 2026.09.10); the Claude, Codex and OpenCode parsers were written against captured real
output, not documentation.

Cursor Agent notes:

- **Resolution.** Its launcher is a `.cmd` → `.ps1` pair that runs the newest
  `versions/<YYYY.MM.DD-commit>/index.js` with the `node.exe` bundled beside it, so `resolve.ts`
  does the same (newest complete version, re-resolved per run so auto-updates apply). The adapter
  looks for `cursor-agent` rather than the generic `agent` alias the installer also adds.
- **Models** come from `cursor-agent models` (text: `<id> - <name> (current, default)`). There is no
  effort setting: the `--model 'x[effort=high]'` overrides in its help text are, per Cursor staff,
  not supported, so thinking levels are picked as model ids (`…-thinking-high`).
- **Auth** is the CLI's own `cursor-agent login` or a `CURSOR_API_KEY` the user sets; it is not
  stripped, and the Cursor editor's session is never read.
- **No questions and no usage:** MCP servers only come from `mcp.json` files (no per-run flag), and
  the `result` event carries duration but no token counts.
- **Known Windows bug** (builds from Aug 2026): with `--force` the process can hang after an
  `editToolCall` write with no further events; the inactivity timeout ends such a run as failed.

Two implementation notes:

- **Claude read-only uses a restricted tool set, not plan mode.** Plan mode delivers its answer
  through `ExitPlanMode` rather than the final `result` event, which would break *save result as
  artifact*. A read-only tool allowlist gives the same safety with a usable result.
- **Prompts never go through a shell.** npm installs CLIs as `.cmd`/`.ps1` shims that Node cannot
  spawn directly, and routing through `cmd.exe` mangles multi-line prompts — so `resolve.ts`
  follows each shim to its real `.exe` or node script and spawns that.

**Selection precedence:** Retry-dialog choice → task override → binding → stage default → the
agent's saved default → the CLI's own. For each of agent, model and effort the first layer that sets one wins
(`resolveAgentChoice` in `shared`, so the server and the run chips agree), with two rules:

- A model or effort only comes from a layer naming the resolved agent, or naming none — a Codex
  model set on the binding never reaches a Claude retry.
- **An effort belongs to its model.** Once a layer supplies the model, efforts further down stop
  applying; an effort set *above* it still does. So a task override of `low` lowers the default
  model's effort, but an agent default of `gpt-5.5 · high` doesn't hand `high` to a binding that
  picks `gpt-6-astra`.

A blank choice anywhere means "defer", including in the Retry dialog.

**Agent defaults:** model + effort per agent, set on the Agents page, stored in `settings` next to
the executable override, and validated like any other choice.

**Stage defaults:** agent + model + effort per stage (`stages.default_*`), edited with the stage in
the workflow editor and saved and copied with the workflow. A binding's Agent field defaults to
blank, "Stage default", falling back to Claude Code when the stage names none; existing bindings
keep their explicit agent. Unlike binding config, stage defaults are read when a run starts rather
than snapshotted, so an edit applies from the next run, retries included. Workflow save validates
the stage's own choice, and checks a binding that leaves its agent blank against the stage's agent
(against any agent when neither names one, as for a task override).

**Auth:** each CLI's own login (Claude & Codex subscriptions; DeepSeek key inside OpenCode;
Cursor login or `CURSOR_API_KEY`).
The app stores no agent credentials and **strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`**
from the child environment so subscriptions are always used.

**Model and effort:** **dropdowns**, never free text, everywhere one can be chosen (binding config,
task override, retry dialog, stage defaults, agent defaults). Blank defers to the next layer.

The lists come from `GET /api/agent-models`, which asks each CLI what it accepts: Codex via
`codex debug models` (the account's catalog, hidden internal models dropped, with each model's
`supported_reasoning_levels`; falls back to `--bundled` offline), OpenCode via
`opencode models --verbose` (whatever providers the user configured, each model's `variants` being
its effort levels), while Claude falls back to its documented aliases and the `--effort` levels
from `claude --help`. Effort levels are per model where the CLI declares them; with no model
chosen, Claude offers its fixed list, Codex every level any model supports, OpenCode nothing. A
model without levels shows a disabled effort picker, and changing agent or model clears an effort
the new choice doesn't offer. There is deliberately **no second copy in the browser** — two lists
that drifted apart are what let an invalid model be typed in the first place. Results are cached
per process and dropped when an executable override changes.

The same lists validate a model and its effort **when a workflow is saved**, when a task or retry
override or an agent default is set, and once more before a run — so a typo can't sit in a workflow
until the agent finally runs.
Each adapter also declares a `modelPattern` (`claude-*`, `gpt*`, `provider/model`) so a model
released after the list was written is still accepted.

**Autonomy:** two levels only — `read-only` and `autonomous` (bypass, confined by
convention to the disposable task worktree). No middle level (behaves inconsistently
across CLIs).

**Save result as artifact:** the agent's final `result` text is written to a named artifact,
so read-only agents can produce `requirements.md` etc.

**Sessions:** `continuePreviousSession` (default on) resumes the task's last session for
this binding **if the agent is unchanged**. If the agent changed, start fresh and prepend the
previous run's final result to the prompt. Session IDs are stored on `action_runs`.

**Completion:** success on a `result` event with ok, **or** clean exit code 0 (OpenCode can
exit before its final event). Failure on non-zero exit, `result` not ok, or inactivity timeout.

**Usage:** tokens + cost per run where reported, task totals; cost labelled *estimated*
for subscription agents. No budgets in v1.

**Transcript:** each run's log is JSON lines in `tasks/<taskId>/runs/<runId>.jsonl`. Plain actions
write text on a stream (`stdout` / `stderr` / `info`); the coding agent writes **structured
entries** — `message`, `tool` and `tool-result` (paired by the CLI's own call id), `question`,
`answer`, `notice` — so a run can be replayed as the conversation it was. The browser groups them
for reading: a call and its result become one expandable row, a message stays whole however many
lines it spans, and unstructured output coalesces into a log block. Questions reach the transcript
because the action lends its log writer to the question service for the life of the run.

**Chat view:** clicking a coding-agent run opens its transcript in a modal rather than expanding a
log inline. A sidebar lists every coding-agent run on the task, newest first, so earlier attempts
and retries stay one click away. Runs are headless and one-shot, so the chat is read-only; the only
channel back to a working agent is a question it asks, answered in a live form at the bottom.

**Questions:** Claude Code and Codex get a per-run MCP endpoint offering one tool, `ask_user`, which
blocks until the question is answered (or skipped) in the UI. Their CLIs time tool calls out after
60s by default, so each run raises that: Claude Code via `timeout` in the `--mcp-config` server
entry, Codex via `-c mcp_servers.workflow.tool_timeout_sec` (set, not yet tested in a live run). If
the agent asks again while an earlier question is still pending — its call was abandoned — the new
question replaces the old one instead of being refused. OpenCode can't be pointed at an MCP server
per run, so it never asks.

A choice question also takes typed text: on its own it is the answer (the "none of these" case),
beside a picked option it goes as `option — note`. The tool's description invites rounds of related
questions, recommendation first, and asks the agent to ask again if a call times out.

*Known limitation (2026-09-11, still true 2026-09-24 on Claude Code 2.1.267):* the call ends after
~340–353s with "The operation timed out.", despite the raised `timeout`. Some further limit applies
and hasn't been found. In practice the agent asks again, the new question replaces the old one, and
an answer you were typing stays in the form.

**Saved results** drop a line or two of chat before the document's first heading ("Here's the
plan."), so an artifact starts with its content; a longer lead-in, or one that looks like content,
is kept.

---

## 4. Default workflows

### Feature (from the sketch)
| Stage | Actions, in order |
|---|---|
| Backlog | — |
| To Pick | — |
| Solidify Reqs | `ensure-worktree` → `coding-agent` (read-only, settles decisions with you through `ask_user` before writing, save result as `requirements.md`, waits for your approval — Request changes redrafts it in the same session) → `move-stage next` |
| Implement Reqs | `jira-transition` In Progress (off) → `ensure-worktree` → `coding-agent` (autonomous, continue session, waits for your approval) with `{{artifacts["requirements.md"]}}` and `{{task.lastFeedback}}` → `move-stage next` |
| Review Imp | Approval *Review diff* (Send back to Implement Reqs, with a note) → `move-stage next` |
| Test Imp | `shell` *Install dependencies* (off) → `shell` *Run tests* (off, placeholder) → Approval *Manual QA* (says tests only run once those are set up, and that approving opens the MR; Send back to Implement Reqs) → `move-stage next` |
| Submit MR | `open-merge-request` → `jira-transition` In Review (off) → Approval *Merged* → `archive-task` |

JIRA/Linear actions are included but **switched off** until a connection exists, and marked
*continue if this fails*: Feature gets `jira-transition` first in *Implement Reqs* and after the MR
opens, Bugfix a `linear-update` first in *Fix*.

### Bugfix
Backlog → Reproduce → Fix → Review → Submit MR.

Only these two are seeded. Anything else — a research spike, say — is built in the workflow editor.

---

## 5. UI

Components, tokens and the rules screens follow are in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

- **Board** (per workflow): columns = stages; dnd-kit drag anywhere; WIP warning.
  **Card**: title, action progress dots, status badge (running spinner / needs-you amber /
  quota-wait teal "Resets 2:40 AM" / failed red / queued grey), link icons, time in stage.
- **Header counts**: needs you (bell-ring) · running (loader-circle) · failed or waiting on a usage
  limit (triangle-alert), over active tasks in every workflow. A count of zero is left out, and with
  nothing active the group disappears; queued is never counted — it only waits for a slot. Each task
  counts once, under its card badge, so header and board agree; precedence is question → approval →
  running → quota → failed → queued → not started. A usage-limit wait shares the failed count (the
  task is stopped either way) but keeps its own card badge carrying the reset time. A count opens a
  list of its tasks (what it is about, workflow · stage), failures before limit waits and those by
  soonest reset; picking one opens it on its board. The tab title carries the needs-you count.
- **Task drawer**: header fields with an Archive button, stage stepper, the stage's numbered actions (Approve / Request changes /
  Send back on a run awaiting you, Retry / Skip on a failure, Start when nothing has run),
  timeline grouped by visit (live-streamed action logs, collapsible), artifacts
  (markdown preview), outputs. A run blocked on a question shows an **Answer** prompt in place.
  A review gate shows the branch's diff against its base, uncommitted and brand-new (untracked)
  files included — the latter diffed on a scratch copy of the index, so the worktree's staging area
  is untouched.
- **Agent chat** (modal, from any coding-agent run): sidebar of the task's agent runs; header with
  agent · model · effort · autonomy, status, duration, usage, cancel / retry; the transcript as messages,
  tool rows paired with their results, question and answer turns, and notices; the live question
  form at the bottom, and — when the agent is holding for your sign-off — an approval card with
  *Send changes* (⌘/Ctrl+Enter) and *Approve*; raw-log toggle and copy. See §3.1 *Transcript* and *Chat view*.
- **Workflow editor**: stage columns (reorder, add, rename), each listing its numbered actions
  (reorder with the arrows that show on hover); clicking a stage or action (or adding one) opens a
  dialog that edits it — stage (name, WIP limit, coding-agent defaults) or action (action type →
  generated config form with template-variable hints, enabled; the key, "continue if this fails" and
  any field the action marks `advanced` fold away under *Advanced*, open when one of them isn't at
  its default). New / Duplicate / Delete
  per workflow; deleting one that tasks use lists them and needs a tick to delete them too. Edits
  are a local draft until **Save**; deleting a stage with active tasks in it is refused. The ✕ on
  the page chip, or the brand, returns to the board.
- **Connections**: one card per saved credential, with the fields the server declares for its type,
  a **Test** button reporting who we authenticated as, and add/delete. Secrets show as *saved* and
  stay blank unless you type a replacement.
- **Agents**: detected path + version per CLI (path overridable), default model + effort, "Test"
  button running a tiny prompt with those defaults. The install or login command shows on the card
  whenever the CLI isn't ready; the rest of the setup folds out below it.
- **Retry dialog**: agent + model + effort dropdowns prefilled from the failed run.
- **Archive**: searchable list; read-only timeline summary + artifacts.
- Live updates via **Server-Sent Events**.

---

## 6. Architecture

```
workflow-manager/
  server/   Hono on Node 24, better-sqlite3 + Drizzle, engine, action plugins
  web/      React + Vite + TanStack Query + dnd-kit
  shared/   types, Zod schemas
```

- npm workspaces (pnpm not installed).
- Engine: in-process event bus; `action_runs` table is the durable queue; concurrency limiter.
- Data dir: `%USERPROFILE%\.agentify\` (falls back to a pre-rename `.workflow-manager\` when that exists and `.agentify\` doesn't)
  - `db.sqlite`
  - `secrets.json` (connections; never exported with workflows)
  - `tasks/<taskId>/artifacts/` (kept)
  - `tasks/<taskId>/runs/<runId>.jsonl` (transcripts; purged on archive)
  - `worktrees/<taskSlug>/` (removed on archive)
- **Security**: binds `127.0.0.1` only; rejects requests whose `Origin`/`Host` isn't the
  local app (the `shell` action makes a reachable server equivalent to RCE — blocks
  DNS-rebinding / CSRF from other browser tabs).

### Tables (sketch)
`workflows` · `stages` · `action_bindings` · `tasks` · `stage_visits` · `action_runs` ·
`timeline_events` · `settings`

Migration 0007 dropped `phases` and `phase_states`. Its data half, `src/db/flatten-phases.ts`, runs
before migrating: each stage's list follows the old order (entry actions; per phase its start
actions, an Approval where it waited for you, its completion actions; then completion actions), a
success chain goes straight after its parent, a manual Send back becomes the preceding approval's,
and leftovers (exit hooks, failure chains, other buttons) are kept switched off at the end and logged.
Active tasks restart their current stage as a new attempt with nothing started.

---

## 7. Environment facts (checked 2026-09-10)

- Node v24.19.0, npm, git 2.55 present. pnpm, `gh`, `glab` absent.
- All three CLIs installed globally during step 3 and confirmed working end-to-end:
  Claude Code 2.1.267 (logged in via claude.ai), Codex 0.154.0 (ChatGPT), OpenCode 1.18.30
  (OpenCode Go credentials). npm needed `--allow-scripts=@anthropic-ai/claude-code,opencode-ai`
  for their postinstall steps.
- **OpenCode billing:** the OpenCode Go account reports *"Insufficient balance"* on paid models,
  and `opencode-go/deepseek-v4-flash` refuses to run without an explicit China-hosting opt-in.
  Free `opencode/*` models work today (verified with `opencode/mimo-v2.5-free`).
- MR creation uses GitLab push options, so no `glab` dependency.
- Cursor Agent 2026.09.10-fd3934a installed 2026-09-11 with Cursor's Windows installer into
  `%LOCALAPPDATA%\cursor-agent` (added to the user PATH).

## 8. Build status

| Step | Scope | Status |
|---|---|---|
| 1. Foundation | schema + migrations, engine, runner, `shell` / `write-artifact` / `move-stage` / `ensure-worktree` / `open-merge-request` / `archive-task`, seeded workflows, REST + SSE API, localhost guard | ✅ done (20 tests) |
| 2. Board | web app: board with drag-to-move, task drawer (stage panel, timeline, artifacts, details), move / retry / send-back / archive dialogs, archive view, SSE live updates; server serves the built UI | ✅ done |
| 3. Agents | `coding-agent` + Claude / Codex / OpenCode adapters, shim-aware CLI resolution, session resume, usage capture, Agents view (status / path override / test prompt), `settings` table | ✅ done (45 tests) |
| 4. Workflow editor | whole-document save with diffing + referential validation, action-field catalogue, stage/phase/action editing, create / duplicate / delete workflows | ✅ done (67 tests) |
| 5. Integrations | connection store in `secrets.json` + adapters, `jira-transition` / `linear-update` / `notion-append`, Connections view, connection-aware editor field and save guard | ✅ done (87 tests) |
| 6A. Effort + agent defaults | reasoning effort for all three CLIs (per-model levels from Codex/OpenCode catalogs), task effort override, per-agent default model + effort, layered `resolveAgentChoice` | ✅ done (121 tests) |
| 6B. Stage defaults | agent + model + effort per stage (read at run start), blank "Stage default" agent on bindings, stage form in the editor, save-time validation | ✅ done (125 tests) |
| 7. Cursor Agent | fourth adapter (`cursor-agent`): versioned-launcher resolution, stream-json parser, `models` list, ask/force autonomy, resume | ✅ built; live run pending `cursor-agent login` |
| 8. Status counts + quota wait | `badgeDetail` on task summaries, header counts with task lists and tab-title count; `quota-wait` runs (limit detection for Claude Code / Codex, per-agent hold, timed requeue, session resume, Try now) | ✅ done (131 tests); Claude's limit prose not yet seen live |
| 9. Ordered actions | phases and triggers replaced by one ordered list per stage; `approval` action (Approve / Send back); Skip, Start, *continue if this fails*; migration 0007 converting existing workflows | ✅ done (132 server + 26 web tests) |

| 10. Agent approvals | approval folded into `coding-agent` (*wait for my approval*, instructions, optional Send back) with **Request changes** resuming the same run and session; `awaiting-approval` status for both kinds of gate; chat composer; migration 0009 | ✅ done (143 server + 28 web tests) |

The Feature workflow's **Run tests** action is a placeholder `echo` until a real command is configured.

### API (pickers)
`GET /api/repos` (repositories tasks already use) · `GET /api/repos/branches?path=`

### API (step 1)
`GET /api/health` · `GET /api/workflows[/:id]` · `GET|POST /api/tasks` · `GET|PATCH /api/tasks/:id` ·
`POST /api/tasks/:id/move {stageId, runActions}` ·
`POST /api/tasks/:id/archive` · `GET /api/tasks/:id/artifacts` · `GET /api/tasks/:id/artifact?name=` ·
`GET /api/runs/:id/log` · `POST /api/runs/:id/retry {overrides?}` · `POST /api/runs/:id/cancel` ·
`POST /api/runs/:id/resume` (Try now on a `quota-wait` run) ·
`GET /api/events` (SSE: `task.changed`, `run.changed`, `timeline.appended`, `run.log`)

### API (step 3)
`GET /api/agents` (installed / version / login / path per agent) · `GET /api/agent-models`
(models and effort levels each CLI accepts, for the dropdowns and validation) ·
`PUT /api/agents/:id {path}` (executable override, stored in `settings`) ·
`PUT /api/agents/:id/defaults {model, effort}` (saved default, also in `settings`) ·
`POST /api/agents/:id/test {model?, effort?}` (one-line read-only prompt in a temp dir)

### API (step 4)
`GET /api/action-types` (catalogue + editor fields) · `POST /api/workflows {name, copyFromWorkflowId?}` ·
`PUT /api/workflows/:id` (whole workflow; `updatedAt` precondition) · `DELETE /api/workflows/:id[?force=true]` (force also deletes its tasks) ·
`GET /api/workflows/:id/usage` (task counts, per stage)

### API (step 5)
`GET /api/connection-types` (per-service field metadata) · `GET /api/connections` (secret values
omitted; `secretsSet` lists which are held) · `POST /api/connections` · `PUT /api/connections/:id`
(only the fields sent are changed) · `DELETE /api/connections/:id` · `POST /api/connections/:id/test`

### API (ordered actions)
`POST /api/tasks/:id/start` (runs the stage's actions after a move that didn't) · `POST /api/runs/:id/skip` ·
`POST /api/runs/:id/approve` · `POST /api/runs/:id/send-back {note?}` ·
`POST /api/runs/:id/request-changes {note}` (an agent's approval only; requeues the same run with your note)

### API (questions)
`POST /api/questions/:id/answer {answers, skip}` (409 once answered or abandoned) · `ALL /mcp/:token`
(the run's own MCP endpoint, offering only `ask_user`; the token is minted per run and dies with it)

### API (ticket drafting)
`POST /api/tickets/draft {link}` (reads the ticket, drafts `{title, description}`; see §3.5) ·
`GET|PUT /api/settings/ticket-draft {agent, model, effort}` (a null agent copies the ticket; the model is validated)

## 9. Decided later rounds

1. Git host: chosen per repo from the remote URL (github.com → `gh`, otherwise GitLab push options).
2. Workflow export/import: not in v1; the workflow format stays plain and self-contained so it's easy to add.
