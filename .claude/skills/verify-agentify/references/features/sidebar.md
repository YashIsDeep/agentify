# Sidebar

The app's only navigation. It holds the brand, the workspace switcher, the page links, one link per workflow board, status counters and a live indicator, with the theme toggle in the footer.

## Sub-features

- brand: **Agentify** button. It returns to the current workflow's board.
- workspace-switcher: see `workspaces.md`.
- page-links: **Workflows**, **Agents**, **Connections**, **Archive**, in that order (`PAGES` in `web/src/views.ts`). The active one has `aria-current="page"`.
- boards-list: a **Boards** label followed by one button per workflow (emoji icon + name, full name in `title`). Clicking one opens that workflow's board and closes any open task.
- status-counters: in the footer. See `status-counters.md`.
- live-indicator: **Live** (green dot) or **Offline**, with a tooltip of "Live updates connected" or "Reconnecting to the server…".
- theme-toggle: a `radiogroup "Theme"` with **Light theme** / **Dark theme** radios.
- narrow-drawer: at 899px and below, the sidebar leaves the grid and slides in over the page. A ☰ toggle opens it (`Open navigation` / `Close navigation`, `aria-expanded`) over a scrim.

## How to get to it (user POV)

Always visible on the left on desktop. On narrow screens, tap the ☰ button at the top left. Picking any destination closes the drawer.

## Driving it

- Landmark: `nav "Workspace navigation"`. Use `find "Workflows"` or `find "Archive"` for pages, and the workflow name for boards.
- Narrow mode: `resize_window { preset: "mobile" }`, click `button "Open navigation"`, and check that focus moved into the drawer. Tab cycles inside it, and Escape closes it and returns focus to the toggle.
- Theme: click `radio "Dark theme"`, then check `document.documentElement` in `javascript_tool` for the applied theme and confirm it survives a reload.
- Reset with `resize_window { preset: "desktop" }` when you are done.

## Gotchas

- There is no Conversations link and no UI-kit link by design. Conversations opens from the **Needs you** counter, and the UI kit is reachable only by URL.
- Selecting a page or board clears `task`, because an open task belongs to the page it was opened from.
- Escape in the narrow drawer is ignored while a dialog or menu is on top, because that layer handles its own Escape.
- Do not add a top bar or header navigation. It was deliberately removed.
