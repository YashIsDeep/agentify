# Archive

The **Archive** page lists finished tasks, and also defines what archiving a task removes and keeps.

## Sub-features

- table: Task (title + tags), Workflow, Last stage, Archived (relative time, full date in the tooltip). Newest first. Rows are focusable, and Enter or click opens the read-only drawer.
- search: `Search the archive` ("Search titles, tags, workflows…") matches title, description, workflow, stage, branch and tags. It appears only when something is archived.
- empty states: "Nothing archived yet", or "No archived task matches “…”". A failed load shows an error with **Try again**, never an empty state.
- archive from the drawer: the **Archive task** icon opens a dialog listing what happens. It removes the git worktree (the branch is kept), deletes transcripts and logs, and keeps artifacts and the timeline.
- dirty worktree: a warn callout appears, and the button becomes **Discard changes and archive**. After a server error it becomes **Force archive**.
- archive action: the `archive-task` workflow action does the same unattended. The default Ship stage ends with it.
- archived drawer: a read-only Details fieldset, no stage panel, a disabled stepper, and empty transcripts.

## How to get to it (user POV)

Sidebar → **Archive**. To archive, open a task and click the archive icon in its header.

## Driving it

- `navigate` to `/?view=archive`. Type into `find "Search the archive"`, then click a row.
- API: `GET .../tasks?status=archived`, and `POST .../tasks/<taskId>/archive {force}`.
- After archiving, check that the worktree folder is gone and the branch still exists (`git branch --list wm/*` in the repo).

## Gotchas

- There is no UI or API operation to unarchive a task, and the board never shows archived tasks.
- Deleting a workflow that is in use deletes its archived tasks too. They do not stay in the Archive.
- The toast reads `Archived “<title>”`, and the drawer stays open in its read-only form.
