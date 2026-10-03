# Deep links & unsaved-changes guards

All navigation state is kept in the query string, and screens with unsaved edits refuse to be left silently.

## Sub-features

- params: `workspace` (default `default`), `workflow` (default: first), `view` (`board` when absent; also `archive`, `agents`, `workflows`, `connections`, `conversations`, `ui-kit`), `task` (opens the drawer over any page).
- history: each in-app navigation pushes a numbered history entry, and back/forward re-render (`web/src/lib/url-state.ts`).
- guards: the workflow editor ("Discard unsaved changes to this workflow?") and the task Details form ("Discard your unsaved changes to “<title>”?") register guards. In-app navigation, back/forward and the drawer's close all ask via `confirm`. Reload or tab close shows the browser's beforeunload prompt.
- refused back/forward: if you cancel the confirm, the app steps history back onto the current entry so the URL matches the screen.

## How to get to it (user POV)

Paste or bookmark a URL. Use the browser's back/forward buttons. Edit something and try to leave.

## Driving it

- `navigate` to `http://localhost:2712/?view=agents` or `?workflow=<id>&task=<id>` to land directly.
- Guard test: edit a workflow name in Workflows, click a sidebar board, and expect a `confirm` dialog. The Browser pane's dialog handling decides accept or dismiss. Then check `location.search` via `javascript_tool`.
- Back/forward: `navigate { url: "back" }` and check the screen and the URL agree.

## Gotchas

- An unknown `view` falls back to the board, and an unknown `workflow` falls back to the first workflow.
- `?task=` for a deleted task shows "This task no longer exists." inside the drawer, not a page error.
- Workspace-scoped navigation from a late mutation callback is dropped if you have switched workspace (`useWorkspaceNavigation`).
- The New task dialog has its own discard confirm ("Discard this task? …"). It is not a URL guard.
