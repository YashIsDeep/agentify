# Workflow Manager — Design

A local, single-user web app for moving tasks through configurable workflows whose
stages fire actions (coding agents, JIRA/Linear/Notion updates, shell commands, artifacts).

Status: design agreed through grilling rounds 1–4 (round 3 decided by Claude on request);
remaining open items in §8.

---

## 1. Core concepts

| Concept | What it is |
|---|---|
| **Workflow template** | Ordered list of stages. Many templates exist; edited in the UI; stored in SQLite; defaults seeded on first run. |
| **Stage** | A column. Has ordered **phases** and **action bindings**. Optional WIP limit (warning only). |
| **Phase** | Sequential sub-step of a stage. Completion mode `auto` (all its actions succeeded) or `manual` (user ticks). A phase with no actions is always manual. Any phase can be force-completed. |
| **Task** | The thing that moves. Bound to one template at creation, forever. |
| **Stage visit** | One stay of a task in a stage. Re-entering a stage creates a new visit (`attempt 2`) with fresh phases. Phase definitions are snapshotted at entry, so template edits apply from the next visit. |
| **Timeline** | Append-only per-task event log, grouped by stage visit. |
| **Action binding** | `trigger → action type + config`, attached to a stage (optionally a phase). |
| **Action run** | One execution of a binding. Status: `queued · running · succeeded · failed · cancelled · interrupted`. |
| **Outputs** | Structured values an action run returns; stored on the task; referenceable later. |
| **Artifacts** | Files under the task's artifact dir. Survive archival. |
| **Connection** | Named credential set (`work-jira`, `personal-linear`) stored outside the DB. |

### Task fields
Title, markdown description, template, optional repo (`repoPath`, `baseBranch`),
derived `branch` / `worktreePath`, external links (`[{type, idOrUrl}]`), tags,
optional **agent override** and **model override** (see §3), `lastFeedback`.
No custom fields in v1.

---

## 2. Engine semantics

### Triggers
`stage.entered` · `stage.exited` · `phase.started` · `phase.completed` · `stage.completed`
· `manual` (button on task) · `action.succeeded` / `action.failed` (chaining, reference a sibling binding).

No timers or external signals (webhooks/polling of JIRA, MR merged) in v1.

### Lifecycle
1. Task enters stage → new visit → `stage.entered` → first phase starts → `phase.started`.
2. Phase `auto`: completes when all its bound actions succeed. Phase `manual`: waits for user.
3. Phase completes → `phase.completed` → next phase starts.
4. Last phase completes → `stage.completed`.
5. Moving is **only** done by the `move-stage` action (default template binds it to
   `stage.completed`) or by the user dragging.

### Batches
All bindings matched by one trigger firing form a **batch** and run **sequentially** in
position order (e.g. `ensure-worktree` then `coding-agent`). A failure skips the rest of
the batch; retrying the failed run successfully resumes the skipped ones. Different
batches (and different tasks) run concurrently. A phase's completion is judged on the
latest attempt of every run tagged to it, including `action.*` chains spawned from them.

### Manual moves (drag anywhere, any direction)
- Dialog: "Run entry actions?" (checked by default).
- Running actions in the stage being left are cancelled after confirmation
  (AbortSignal → process kill / API cancel).
- `stage.exited` fires for the old stage, then entry for the new one.

### Failure
Action → `failed`; its phase → `failed`; `action.succeeded` chains stop; `action.failed`
bindings fire. Card shows a red badge; error on timeline. Buttons: **Retry**, **Mark done anyway**.
No auto-retry in v1.

### Concurrency
Tasks run in parallel (isolated by worktrees). Global cap on concurrent long-running
actions (default 3; configurable). Excess runs are `queued` and visible on the timeline.

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
{{stage.name}} {{phase.name}} {{visit.attempt}}
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
| `coding-agent` | Runs a headless coding-agent CLI in the task worktree via an adapter (§3.1). Config: agent, model, prompt, autonomy, continue-session, save-result-as artifact, **inactivity timeout** (default 5 min). |
| `shell` | Runs a command (cwd = worktree or artifact dir). Exit 0 = success. Outputs via `$WM_OUTPUT_FILE` or regex extraction from stdout. |
| `ensure-worktree` | Creates `git worktree` + branch `wm/<task-slug>` from `baseBranch` if missing. |
| `write-artifact` | Writes templated content to a named artifact. |
| `open-merge-request` | Optionally commits, pushes, and opens an MR/PR: github.com remotes use `gh pr create`, anything else uses GitLab push options. Output `mrUrl`. |
| `move-stage` | `target: "next" \| <stageId>`. |
| `archive-task` | Removes worktree (branch kept), purges transcripts + sync state, moves to archive. |
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
| Coding agent model | the CLIs (`opencode models`, documented aliases) | template save, task/retry override, run |
| Repository | repositories other tasks use, plus manual entry | task create / update |
| Base branch | `git for-each-ref` on the chosen repository | task create / update |
| Task link type | `LINK_TYPES` | lower-cased on write |
| Stage / connection / agent / autonomy | the workflow, saved connections, the registry | template save |

Two rules keep it honest. A value the list doesn't contain is still **shown** rather than silently
rewritten — flagged as unrecognised, so an existing template is never quietly changed. And fields
that are template-interpolated (`{{task.title}}.md`) skip shape checks, because their real value
isn't known until the run.

The remaining free-text fields are ones with no closed set: titles, descriptions, prompts, tags,
commands, branch prefixes, and the Jira/Linear status names (those *are* validated, but only at run
time and against the issue's own workflow, which is where the authoritative list lives).

### 3.3 Connections

Integration actions declare a `connectionType` and take a `connection`-kind field, so the editor
offers only the credentials that can actually authenticate them.

Credentials live in `secrets.json` beside the database, never in it — the database stays safe to
copy, inspect and export, and duplicating a template never carries a token with it. Secret fields
are **write-only**: the API reports which ones are set, never their values, and an update that omits
a secret keeps it (sending `""` clears it). Values the adapter doesn't declare are dropped.

One adapter per service owns its fields, its authentication and a cheap identity call behind the
**Test** button (Jira `/myself`, Linear `viewer`, Notion `/users/me`). `fetch` is injected, so the
adapters and the actions built on them are tested end-to-end without a network.

Errors are reported in the service's own words: each API describes failures differently
(`errorMessages`, GraphQL `errors[]`, `message`), so a wrong token says so rather than "request failed".
Linear needs special care — GraphQL reports authentication failures with HTTP 200 and an `errors` array.

An integration action may sit unconfigured while it is **disabled**; enabling one needs a live
connection, checked when the template is saved and again when the action runs.

**Unlinked tasks are a no-op.** `jira-transition` and `linear-update` default their issue to
`{{task.links.jira}}` / `{{task.links.linear}}`, which renders empty on a task with no such link.
An empty reference succeeds with "no issue linked" on the timeline rather than failing, so the
actions can be bound template-wide; a reference that is present but unparseable still fails, so a
typo never passes silently.

### 3.2 Editing a live template

Templates are editable while tasks are running because the runtime keeps its own copies:
stage visits snapshot the stage name, phase states snapshot the phase definitions at entry,
and action runs snapshot their config. Edits therefore apply from a task's **next** stage
visit, and history never changes underneath a task.

The editor sends the whole template back as one document; the server diffs it against the
database by id (client-generated, so a new action can reference a new phase before either is
saved). It refuses a save that would:

- delete a stage that active tasks are standing in (they would be stranded),
- leave a dangling reference — a phase trigger with no phase, a chain whose target is gone,
  a `move-stage` destination outside the template,
- duplicate an action key (`{{outputs.<key>}}` must be unambiguous),
- enable an integration action with no connection chosen, or one since deleted,
- set a coding-agent model the chosen agent doesn't accept,
- create a loop of `action.succeeded` / `action.failed` chains,
- fail an action's own config schema, or
- overwrite a version saved since the editor loaded it (`updatedAt` precondition).

A template can only be deleted once no task — active or archived — still references it.

### 3.1 Coding agents

**Agents (v1):** Claude Code · Codex · OpenCode. One adapter per agent:

```ts
interface AgentAdapter {
  id: "claude" | "codex" | "opencode";
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

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Headless | `claude -p --output-format stream-json --verbose` | `codex exec --json -o <result-file> -C <dir> -` | `opencode run <msg> --format json --dir <dir>` |
| Prompt via | stdin | stdin | argv (+ attached file) |
| Resume | `--resume <id>` | `codex exec resume <id>` | `--session <id>` |
| Model | `--model` | `-m` | `-m provider/model` |
| read-only | restricted `--tools` + `--permission-prompts none` | `-s read-only` (resume: `-c sandbox_mode="read-only"`) | `--agent plan` |
| autonomous | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto` |

Flags were verified against each installed CLI (Claude 2.1.267, Codex 0.154.0, OpenCode 1.18.30);
the parsers were written against captured real output, not documentation.

Two implementation notes:

- **Claude read-only uses a restricted tool set, not plan mode.** Plan mode delivers its answer
  through `ExitPlanMode` rather than the final `result` event, which would break *save result as
  artifact*. A read-only tool allowlist gives the same safety with a usable result.
- **Prompts never go through a shell.** npm installs CLIs as `.cmd`/`.ps1` shims that Node cannot
  spawn directly, and routing through `cmd.exe` mangles multi-line prompts — so `resolve.ts`
  follows each shim to its real `.exe` or node script and spawns that.

**Selection precedence:** Retry-dialog choice → task override → binding default. Same for model.

**Auth:** each CLI's own login (Claude & Codex subscriptions; DeepSeek key inside OpenCode).
The app stores no agent credentials and **strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`**
from the child environment so subscriptions are always used.

**Model:** a **dropdown**, never free text, in all four places one can be chosen (binding config,
task override, retry dialog, agent test). Blank = the CLI's own default.

The list comes from `GET /api/agent-models`, which asks each CLI what it accepts: OpenCode
enumerates its own via `opencode models` (the provider set is whatever the user configured), while
Claude and Codex fall back to their documented aliases. There is deliberately **no second copy in
the browser** — two lists that drifted apart are what let an invalid model be typed in the first
place. Results are cached per process and dropped when an executable override changes.

The same list validates a model **when a template is saved**, when a task or retry override is set,
and once more before a run — so a typo can't sit in a template until the agent finally runs.
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

---

## 4. Default templates

### Feature (from the sketch)
| Stage | Phases (mode) | Bindings |
|---|---|---|
| Backlog | — | — |
| To Pick | — | — |
| Solidify Reqs | Draft requirements (auto) → Approve requirements (manual) | `phase.started[Draft]` → `ensure-worktree`, then `coding-agent` (read-only, save result as `requirements.md`) "produce requirements for {{task.title}}…"; `stage.completed` → `move-stage next` |
| Implement Reqs | Implement (auto) → Self-check (manual) | `phase.started[Implement]` → `coding-agent` (autonomous, continue session) with `{{artifacts["requirements.md"]}}` and `{{task.lastFeedback}}`; `stage.completed` → `move-stage next` |
| Review Imp | Review diff (manual) | `manual` "Send back" (prompts for a note → `task.lastFeedback`) → `move-stage Implement Reqs`; `stage.completed` → `move-stage next` |
| Test Imp | Run tests (auto) → Manual QA (manual) | `phase.started[Run tests]` → `shell` (placeholder test command); `stage.completed` → `move-stage next` |
| Submit MR | Open MR (auto) → Merged (manual) | `phase.started[Open MR]` → `shell` `git push -u origin {{task.branch}} -o merge_request.create -o merge_request.target={{task.baseBranch}}` with regex output `mrUrl`; `stage.completed` → `archive-task` |

JIRA/Linear/Notion bindings are included but **disabled** until a connection exists: Feature gets
`jira-transition` on entering *Implement Reqs* and again when the MR opens, Bugfix a `linear-update`
on entering *Fix*, Spike a manual `notion-append` that publishes `findings.md`.

### Bugfix
Backlog → Reproduce → Fix → Review → Submit MR.

### Spike
Backlog → Research (`coding-agent` read-only, result saved as `findings.md`) → Write-up (manual; optional `notion-append`) → archive.

---

## 5. UI

- **Board** (per template): columns = stages; dnd-kit drag anywhere; WIP warning.
  **Card**: title, phase progress dots, status badge (running spinner / needs-you amber /
  failed red / queued grey), link icons, time in stage.
- **Task drawer**: header fields, stage stepper, phases with checkboxes, manual action buttons,
  timeline grouped by visit (live-streamed action logs, collapsible), artifacts
  (markdown preview), outputs.
- **Template editor**: stage columns (reorder, add, rename); a detail panel below edits the
  selected stage (name, WIP limit, phases) or action (trigger → phase / preceding action →
  action type → generated config form with template-variable hints). New / Duplicate / Delete
  per template. Edits are a local draft until **Save**; deleting a stage with active tasks in
  it is refused.
- **Connections**: one card per saved credential, with the fields the server declares for its type,
  a **Test** button reporting who we authenticated as, and add/delete. Secrets show as *saved* and
  stay blank unless you type a replacement.
- **Agents**: detected path + version per CLI (path overridable), "Test" button running a tiny prompt.
- **Retry dialog**: agent + model dropdowns prefilled from the failed run.
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
- Data dir: `%USERPROFILE%\.workflow-manager\`
  - `db.sqlite`
  - `secrets.json` (connections; never exported with templates)
  - `tasks/<taskId>/artifacts/` (kept)
  - `tasks/<taskId>/runs/<runId>.jsonl` (transcripts; purged on archive)
  - `worktrees/<taskSlug>/` (removed on archive)
- **Security**: binds `127.0.0.1` only; rejects requests whose `Origin`/`Host` isn't the
  local app (the `shell` action makes a reachable server equivalent to RCE — blocks
  DNS-rebinding / CSRF from other browser tabs).

### Tables (sketch)
`workflows` · `stages` · `phases` · `action_bindings` · `tasks` · `stage_visits` ·
`phase_states` · `action_runs` · `timeline_events`

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

## 8. Build status

| Step | Scope | Status |
|---|---|---|
| 1. Foundation | schema + migrations, engine, runner, `shell` / `write-artifact` / `move-stage` / `ensure-worktree` / `open-merge-request` / `archive-task`, seeded templates, REST + SSE API, localhost guard | ✅ done (20 tests) |
| 2. Board | web app: board with drag-to-move, task drawer (stage panel, timeline, artifacts, details), move / retry / send-back / archive dialogs, archive view, SSE live updates; server serves the built UI | ✅ done |
| 3. Agents | `coding-agent` + Claude / Codex / OpenCode adapters, shim-aware CLI resolution, session resume, usage capture, Agents view (status / path override / test prompt), `settings` table | ✅ done (45 tests) |
| 4. Template editor | whole-document save with diffing + referential validation, action-field catalogue, stage/phase/action editing, create / duplicate / delete templates | ✅ done (67 tests) |
| 5. Integrations | connection store in `secrets.json` + adapters, `jira-transition` / `linear-update` / `notion-append`, Connections view, connection-aware editor field and save guard | ✅ done (87 tests) |

The Feature template's **Run tests** action is a placeholder `echo` until a real command is configured.

### API (pickers)
`GET /api/repos` (repositories tasks already use) · `GET /api/repos/branches?path=`

### API (step 1)
`GET /api/health` · `GET /api/workflows[/:id]` · `GET|POST /api/tasks` · `GET|PATCH /api/tasks/:id` ·
`POST /api/tasks/:id/move {stageId, runActions}` · `POST /api/tasks/:id/phases/:phaseStateId/complete` ·
`POST /api/tasks/:id/stage/complete` · `POST /api/tasks/:id/bindings/:bindingId/trigger {feedback?}` ·
`POST /api/tasks/:id/archive` · `GET /api/tasks/:id/artifacts` · `GET /api/tasks/:id/artifact?name=` ·
`GET /api/runs/:id/log` · `POST /api/runs/:id/retry {overrides?}` · `POST /api/runs/:id/cancel` ·
`GET /api/events` (SSE: `task.changed`, `run.changed`, `timeline.appended`, `run.log`)

### API (step 3)
`GET /api/agents` (installed / version / login / path per agent) · `GET /api/agent-models`
(models each CLI accepts, for the dropdowns and validation) · `PUT /api/agents/:id {path}`
(executable override, stored in `settings`) · `POST /api/agents/:id/test {model?}` (one-line
read-only prompt in a temp dir)

### API (step 4)
`GET /api/action-types` (catalogue + editor fields) · `POST /api/workflows {name, copyFromWorkflowId?}` ·
`PUT /api/workflows/:id` (whole template; `updatedAt` precondition) · `DELETE /api/workflows/:id` ·
`GET /api/workflows/:id/usage` (task counts, per stage)

### API (step 5)
`GET /api/connection-types` (per-service field metadata) · `GET /api/connections` (secret values
omitted; `secretsSet` lists which are held) · `POST /api/connections` · `PUT /api/connections/:id`
(only the fields sent are changed) · `DELETE /api/connections/:id` · `POST /api/connections/:id/test`

## 9. Decided later rounds

1. Git host: chosen per repo from the remote URL (github.com → `gh`, otherwise GitLab push options).
2. Template export/import: not in v1; the template format stays plain and self-contained so it's easy to add.
