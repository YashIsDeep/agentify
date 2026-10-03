# Multi-surface journeys

End-to-end paths that cross the board, the drawer, chats, conversations, the sidebar and other tabs. Run these last in a full sweep, and whenever a change touches state shared between surfaces.

## Sub-features

- **Cheap happy path (no agent):** in a scratch workflow, set up stage A with a `shell` action (`node -e "console.log('ok')"`) and a `move-stage` action, and stage B with an `approval` action that sends back to A. Create a task in A. It runs, moves itself to B, and shows **Needs you · Ready for review**. Approve it from the Open conversations page. The badge clears, the counter drops, the timeline gains `run.approved` and `stage.completed`, and the tab title loses `(1)`.
- **Send back loop:** on a fresh task waiting at B's approval (not the one you just approved, whose approval is gone and would answer 409), use **Send back to A** with a note. The task returns to A as "attempt 2", `{{task.lastFeedback}}` / `WM_LAST_FEEDBACK` carries the note, and the timeline shows the feedback quote. Approving later clears `task.lastFeedback`.
- **Manual move without actions:** drag a card to a stage with actions and untick **Run its actions**. The task becomes Needs you with "Start <stage>'s actions". **Start** works from the drawer header and from Open conversations.
- **Failure handling:** use a shell action that fails on something outside the workflow, such as `node -e "process.exit(require('fs').existsSync(process.env.WM_ARTIFACT_DIR+'/ok')?0:1)"`. The task appears under the **Stopped** counter. Create the `ok` file and check that **Retry** succeeds. Retry reuses the failed run's own command, so editing the command in the workflow does not fix a retry. Also check **Skip** (continues with the next action), and that **Continue if this fails** lets the later actions run while still showing the failure.
- **Agent review round (costs quota):** a coding agent with the approval gate. Open its board card and click **Review** in the drawer header to get the chat. Request a revision with Ctrl+Enter. Then draft more feedback, close the chat and reopen it (the draft persists). Clear it, approve, and **Follow** the next agent.
- **Two tabs:** with the board in tab 1 and the drawer in tab 2, approve in tab 2. Tab 1's card badge and the sidebar counters update without a reload.
- **Unsaved edits across navigation:** edit Details, click another card, and expect the confirm. Cancel and confirm that the URL and drawer are unchanged. Then edit the workflow editor, press back, and expect the confirm and history to be restored.
- **Workspace isolation:** create workspace B and a task in it. Workspace A's board, counters and conversations never show it, and switching back clears `task` / `view`.
- **Restart mid-run:** see `quota-queue-restart.md`. The run is Interrupted, and Retry works.
- **Narrow layout:** at mobile width, open the sidebar drawer, go to a board, open a task (full-width drawer at 720px and below), open a chat (the chat list becomes a select when the task has two or more chats), answer or approve, and close back out.

## How to get to it (user POV)

Each journey starts from the board or the sidebar, as described above.

## Driving it

- Build the scratch workflow through the API so each run starts from a known state: `POST .../workflows {"name":"Scratch"}`, then `PUT .../workflows/<id>` with the whole workflow, as below. Stage and binding `id`s are any non-empty strings; reuse the ids from `GET .../workflows/<id>` for stages you keep. `key` must be an identifier and unique in the workflow. Send the `updatedAt` you last read, or leave it out to skip the stale-save check. Each type's config field names come from `GET .../action-types`.

  ```json
  {
    "name": "Scratch",
    "stages": [
      { "id": "a", "name": "A", "bindings": [
        { "id": "a-shell", "key": "hello", "label": "Say ok", "actionType": "shell",
          "config": { "command": "node -e \"console.log('ok')\"" } },
        { "id": "a-move", "key": "next", "label": "Move on", "actionType": "move-stage", "config": { "target": "next" } }
      ] },
      { "id": "b", "name": "B", "bindings": [
        { "id": "b-ok", "key": "signoff", "label": "Sign off", "actionType": "approval", "config": { "sendBackTo": "a" } }
      ] }
    ]
  }
  ```

- `move-stage` requires `target` (`"next"` or a stage id), and the approval's `sendBackTo` is a stage id. Delete the workflow afterwards with `DELETE .../workflows/<id>?force=true`.
- Record each journey as (action → observable end state). Prefer API JSON for engine state and screenshots for visual state.

## Gotchas

- Use a fresh `WM_DATA_DIR` (the `workflow-manager-e2e` launch config) when a journey needs a clean slate. Don't wipe `.wm-data` that someone else is using.
- Real-agent journeys spend the person's subscription. Do them only when the change is about agents, and say that you did.
