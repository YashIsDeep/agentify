# Activity & artifacts

The drawer's **Activity** and **Artifacts** tabs: what happened to the task, and the files its actions wrote.

## Sub-features

- activity: the timeline grouped by stage visit, newest first. Each group is a collapsible header showing stage name, "attempt N", a "current" tag and relative time. The current visit starts folded, because the stage panel above shows it. General events (such as task creation) are listed below the groups.
- event types: created, stage entered/exited/completed, actions started, approval waiting, approved, sent back, changes requested, skipped, run started/succeeded/failed/cancelled/interrupted/quota-wait/resumed/retried, feedback (rendered as a quote), archived.
- event links: **Open chat** for agent runs. **Show output** / **Hide output** opens an inline log for other runs. Approvals have no output link.
- noise filter: a "run started" event is hidden once the same run has a later event.
- artifacts: a file list (name, size), with the first file selected and previewed. Markdown is rendered (links open in a new tab), and other files show as preformatted text. The header shows "updated <relative>".
- empty: "No artifacts yet". Actions write files like `requirements.md` here, and artifacts are kept after the task is archived.
- review artifacts: the same files appear as an **Artifacts** list inside review cards, and each opens in an xl dialog.

## How to get to it (user POV)

Open a task and pick a tab below the description. Activity is the default tab.

## Driving it

- `find "Activity"` / `find "Artifacts"` (the tablist is named "Task").
- API: `GET .../tasks/<taskId>` (`timeline`), `GET .../tasks/<taskId>/artifacts`, and `GET .../tasks/<taskId>/artifact?name=<file>`.
- To produce an artifact cheaply, add a **Write artifact** action (file name + templated content) to a stage. Files are stored in `<dataDir>/tasks/<taskId>/artifacts/`.

## Gotchas

- Artifact content refetches when `modifiedAt` changes, so a rewrite by a later action shows up live.
- After archiving, transcripts and logs are gone ("Transcripts are removed when a task is archived."), but the timeline and artifacts remain.
- Artifact paths are sandboxed: symlinks and paths outside the task's directory are refused.
