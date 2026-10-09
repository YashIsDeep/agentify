# Workflow editor

The **Workflows** page. It edits a workflow's metadata, its stages and their order, and each stage's ordered list of actions. Edits stay a local draft until you save.

## Sub-features

- overview: an emoji icon picker ("Change workflow icon", searchable), the **Editing workflow** select, counts ("N stages · N actions · N active tasks"), and a `Workflow actions` ⋯ menu (**Duplicate workflow**, **Delete workflow**). Below them, **Name** and **Description** fields.
- stage nav: `nav "Workflow stages"` holds a numbered stage list with action counts and **Add stage**. At 760px and below it is the **Select stage** dropdown.
- stage detail: "Stage N of M", the stage name, a **Stage settings** button, active task count and WIP limit, **Move stage earlier** / **Move stage later**, and **Delete <stage>**. Delete is disabled for the last stage or while tasks are in it, with the reason in a tooltip. The stage's agent defaults line appears if set.
- actions list: "Actions N" with an info tip, then **Add action** (a menu: loop presets first, then every action type with its description). Rows show an index, an icon (hand / bot / terminal / zap), the label, the type or loop label, and an "Off" tag. Each row has **Move <label> up** / **down**.
- Stage settings dialog: **Name**, **WIP limit** (warning only), **Stay here when done** (off: the task moves to the next stage when the stage's actions finish), and **Coding agent defaults** (Agent / Model / Effort) used by this stage's agents that leave those blank.
- Action settings dialog: **Action** type (changing it resets config) and type-specific fields (`action-types.md`). On/off is the power button on the action's row (`Switch <name> off` / `on`). **Advanced** contains **Name** and **Key** (validated live: letters/digits/underscore, unique in the workflow; read later as `{{outputs.<key>.…}}`), advanced fields, and **Continue if this fails** (not offered for a standalone Approval). **Delete action** sits in the footer.
- dialogs edit the draft in place. **Done** closes them, with the reminder "Save the workflow to keep these changes."
- save bar: "Unsaved changes" or "All changes saved", **Discard**, **Save workflow**. Toast `Saved “<name>”`.
- stale draft: if another tab or the API saved meanwhile, a callout offers "Load the saved version". With no local edits, it adopts the saved version silently.
- server refusals (shown as a danger callout): deleting a stage with active tasks, an action pointing at a missing stage, a duplicate key, a model or effort the agent doesn't accept, or an enabled integration without a connection.
- new/duplicate: a `New workflow` / `Duplicate <name>` dialog with an icon and **Name**.
- delete: if the workflow is in use, a danger callout lists the active and archived tasks, and you must tick **Delete the tasks as well** to get **Delete workflow and tasks**.

## How to get to it (user POV)

Sidebar → **Workflows**. It opens on the workflow whose board you came from.

## Driving it

- `navigate` to `/?view=workflows&workflow=<id>`. Click a stage in `nav "Workflow stages"`, then **Add action** → pick an item → fill in the `dialog "Action settings"` → **Done** → **Save workflow**.
- API: `GET/PUT .../workflows/<id>`, `POST .../workflows {name, icon, copyFromWorkflowId}`, `DELETE .../workflows/<id>?force=true` (required when tasks use it), `GET .../workflows/<id>/usage`, and `GET .../action-types`.
- The unsaved guard is in `deep-links-and-guards.md`.

## Gotchas

- Action settings are copied into runs when a stage's actions start, so saved changes apply the next time a task enters the stage. Retry reuses the failed run's copy. Stage agent defaults are read when each run starts, so editing them can affect later runs and retries in a visit already under way. History is never rewritten.
- New coding-agent actions have **Wait for my approval when it finishes** on by default.
- The **Editing workflow** select replaces the URL (`replace: true`). Switching asks first if the draft is dirty.
- Stage reorder and delete are local until saved. Delete is pre-disabled to match the server's refusal.
