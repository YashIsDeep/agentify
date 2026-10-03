# Task details

The drawer's **Details** tab. It has the editable task form and read-only facts about git, outputs and history.

## Sub-features

- form: Title, Description, Repository / Base branch (same pickers as New task), **Use a worktree** (locked on once a worktree exists), Tags (comma-separated), Links.
- agent overrides: **Coding agent** ("No override" or an agent), **Model** (dropdown from the CLI's own model list) and **Effort**. They override every coding-agent action on this task, ahead of the action's and stage's choices, and the Retry dialog can override them again. Changing agent or model drops an effort the new pick doesn't offer.
- save: **Save changes** (disabled until dirty) and **Discard** (shown when dirty). Live updates refresh the form only while it isn't dirty.
- unsaved guard: leaving or closing asks "Discard your unsaved changes to “<title>”?".
- Git: Branch, Base, Worktree (monospace).
- Outputs: each action's latest outputs by key, with URLs as links (for example, `openMr.mrUrl`).
- History: Created, plus Archived when it applies.
- archived: the whole form is a disabled fieldset, with no save buttons.

## How to get to it (user POV)

Open a task, then click the **Details** tab under the description.

## Driving it

- `find "Details"` (tab) → edit fields → `find "Save changes"`. Expect the toast or the updated card title.
- API: `PATCH /api/workspaces/<id>/tasks/<taskId>` with any of `title, description, repoPath, baseBranch, useWorktree, tags, links, agentOverride, modelOverride, effortOverride`.
- Models come from `GET .../agent-models`. A non-empty model or effort in the PATCH is checked against the task's agent override, or against any agent when none is pinned. A PATCH that changes only the agent is not checked. The effective choice is checked again when a run starts.

## Gotchas

- Models and efforts are dropdowns, never free text, because the server validates against the CLI's lists.
- Link types are lower-cased, and prompts read them by exact name (`{{task.links.jira}}`).
- The tab stays mounted, so switching to Activity and back keeps unsaved edits.
