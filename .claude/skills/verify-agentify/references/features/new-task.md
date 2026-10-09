# New task

The dialog for creating a task on any workflow. It can fill itself in from a Jira or Linear ticket.

## Sub-features

- title (required, autofocused), description (optional, Markdown).
- links: a Links field with one empty row up front, a **Link type** select and a **Link** input ("PROJ-123 or paste a Jira / Linear URL"), plus **Remove link** per row and **Add link** for another row. Types are stored lower-case.
- ticket drafting: once the first Jira/Linear link with an issue key stops changing for 700ms on a blank form, the title and description fill from the ticket. **Fill in from ticket** re-drafts on demand and asks before overwriting. A callout shows "Copied from KEY.", "Drafted from KEY by <model>." or a warning/error. Typing wins during an automatic draft. A draft you asked for with **Fill in from ticket** replaces the title and description when it returns, even if you typed meanwhile.
- workflow: the **Workflow** select. **Repository** and **Base branch** start as the most recently used repository's.
- More: a fold holding **Start in** (the first stage is the default) and the worktree checkbox.
- repository: a **Repository** select of known repos (from other tasks, " — missing" if the path is gone), **No repository**, and **Another repository…** which reveals a path input. **Base branch** lists that repo's branches, with "The repo's current branch" as the default.
- worktree: the **Use a worktree** checkbox under More, shown only with a repository path, on by default.
- discard confirm: Escape, backdrop, X or Cancel on a dirty form asks "Discard this task? What you've entered will be lost."
- on create: a toast `Created “<title>”`, then navigates to the task's own board with its drawer open.

## How to get to it (user POV)

On any board, click **New task** in the heading.

## Driving it

- `find "New task"` → `dialog "New task"`. Type into the Title field, then submit with **Create task** (or Enter in the form).
- Ticket drafting needs a usable Jira/Linear connection in this workspace. Without one, expect the error callout and mark drafting as unreachable. If the drafting agent set on the Agents page fails, the form falls back to copying the ticket's own text and shows a warning.
- Drafting API: `POST .../tickets/draft {link:{type, value}}`. Repository pickers: `GET .../repos` and `GET .../repos/branches?path=<repoPath>`.
- API equivalent: `POST /api/workspaces/<id>/tasks {workflowId, title, description?, stageId?, repoPath?, baseBranch?, useWorktree?, links?}`. Repository and branch are validated server-side.

## Gotchas

- A bad repository path fails at save with the branch query's error under the field. It does not fail mid-workflow.
- Changing workflow resets **Start in**.
- Creating into a stage with enabled actions starts them straight away, subject to the concurrency queue.
- Only the newest draft request may fill the form, so stale responses are dropped.
