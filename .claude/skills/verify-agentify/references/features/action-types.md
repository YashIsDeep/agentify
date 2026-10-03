# Action types

Everything a stage can run, in registry order (`server/src/actions/registry.ts`). The editor builds each settings form from the field list the server declares (`GET .../action-types`).

## Sub-features

- **Coding agent** (`coding-agent`): runs Claude Code, Codex, OpenCode or Cursor Agent headlessly in the task's worktree. Fields: Loop, Prompt (templated), Agent ("Stage default (…)"), Model, Reasoning effort, Autonomy (Read-only / Autonomous), **Wait for my approval when it finishes**, Approval instructions, Send back to, Maximum correction attempts / CI fields (by loop). Advanced: Continue the previous session, Save result as artifact, Inactivity timeout, Total timeout. See `loop-modes.md` and `agent-review.md`.
- **Run shell command** (`shell`): Command; advanced Shell (System default / cmd.exe / PowerShell / bash (Git Bash on Windows) / sh), Run in (Task worktree / Repository / Artifact directory, falling back to the next one when the preferred directory doesn't exist), Timeout, Outputs from stdout (name → regex). Task data arrives as `WM_*` env vars (`WM_TASK_ID`, `WM_TASK_TITLE`, `WM_TASK_DESCRIPTION`, `WM_STAGE`, `WM_RUN_ID`, `WM_ATTEMPT`, `WM_REPO`, `WM_WORKTREE`, `WM_BRANCH`, `WM_BASE_BRANCH`, `WM_ARTIFACT_DIR`, `WM_LAST_FEEDBACK`). A JSON object written to `$WM_OUTPUT_FILE` becomes the action's outputs.
- **Write artifact** (`write-artifact`): File name + Content (both templated), written to the task's artifacts folder.
- **Approval** (`approval`): a checkpoint that waits for you. Instructions (templated), Send back to, **Ask for a note when sending back** (saved as `{{task.lastFeedback}}`).
- **Move to stage** (`move-stage`): Destination is "The next stage" or a specific stage.
- **Ensure worktree** (`ensure-worktree`): creates the task's git worktree and branch once (Branch prefix `wm/` + task slug). Does nothing without a repository. **Carry over from the repository**: gitignored paths that are copied (files) or linked (directories).
- **Open merge request** (`open-merge-request`): pushes the branch and opens a GitLab MR (push options) or a GitHub PR (`gh pr create`). Title / Description (templated), **Commit uncommitted changes as** (blank means fail when dirty), Remote, Host (auto / gitlab / github), **Open as draft**, **Require a merge request link**. Output `mrUrl`.
- **Jira: transition issue** (`jira-transition`): Connection, Issue (default `{{task.links.jira}}`), Transition to (blank means comment only), Comment.
- **Linear: update issue** (`linear-update`): Connection, Issue (default `{{task.links.linear}}`), Move to state, Comment.
- **Notion: write** (`notion-append`): Connection, What to do (Append to an existing page / Create a page in a database), Page or database, Page title, Content (Markdown blocks).
- **Archive task** (`archive-task`): **Remove the worktree** (default on), and **Remove it even with uncommitted changes** (otherwise it fails rather than discarding work).
- shared per action: Name, Enabled, Key, **Continue if this fails** (every type except Approval).
- templates: `{{task.title}}`, `{{task.description}}`, `{{task.links.<type>}}`, `{{task.lastFeedback}}`, `{{outputs.<key>.<field>}}`, `{{artifacts["<file>"]}}`.

## How to get to it (user POV)

Go to Workflows → a stage → **Add action**, or click an existing action row to open its settings.

## Driving it

- The cheapest end-to-end probe is a stage with a `shell` action like `node -e "require('fs').writeFileSync(process.env.WM_OUTPUT_FILE, JSON.stringify({ok:true}))"`. Then read `outputs.<key>.ok` in Details → Outputs.
- Integration actions need a connection (`connections.md`). When the Issue field renders empty (the default `{{task.links.jira}}` / `{{task.links.linear}}` on a task without that link), the action does nothing and finishes `succeeded`, not `skipped`. An Issue typed into the action runs regardless of the task's links.

## Gotchas

- Shell commands reject `{{…}}` interpolation. The engine refuses them. Retry reuses the failed run's own copy of the settings, so after editing the command in the workflow, move the task into the stage again to get runs with the new command.
- Integration HTTP refuses redirects, and Jira requires HTTPS. Incoming requests to Agentify's local API are capped at 2 MiB.
- An enabled integration action without a connection blocks saving the workflow. A disabled one can sit unconfigured.
- A template that resolves to nothing still renders as an empty string, and the timeline gains a `template.unresolved` entry naming it.
- An autonomous coding agent fails at once on a task with no repository, and on a task with **Use a worktree** on whose worktree doesn't exist yet. Put **Ensure worktree** above it.
- Ensure worktree's linked carry-over directories are shared, so installing in the worktree changes the repository's copy too.
