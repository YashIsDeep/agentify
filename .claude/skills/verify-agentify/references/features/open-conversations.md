# Open conversations

A page that queues everything waiting on you (questions, reviews, approvals, unstarted stages) and works through them one at a time.

## Sub-features

- queue: `nav "Waiting on you"` lists needs-you tasks, oldest created first. Each shows an icon (question / start ▶ / hand), the title, the reason line and "workflow · stage".
- current item: header with the task title, the action label · agent, **Start** (for an unstarted stage) and **Open task** (opens the drawer).
- body: the transcript plus the review card for agent runs, the `ApprovalDecision` for a standalone Approval, or a one-liner for an unstarted stage.
- advance: answering removes the item, and the item that moves into the same position becomes current. A new arrival elsewhere in the queue does not move you.
- empty: "Nothing needs you right now". Later arrivals show up on their own.
- fresh state per item: a half-typed answer never carries over to the next item.

## How to get to it (user POV)

Click **Needs you** in the sidebar footer. There is no other link. The deep link is `?view=conversations`.

## Driving it

- `navigate` to `/?view=conversations`. Pick items by clicking the buttons in `nav "Waiting on you"`.
- Check that approving item 1 makes item 2 current. Assert `aria-current="true"` moved.
- Same data as the counters: `GET .../tasks?status=active`, filtered to `badge == "needs-you"`.

## Gotchas

- The Needs you counter stays visible at 0 while you are on this page, so you can see it emptied.
- The queue sorts by task creation time, not by when the task started needing you.
- **Open task** keeps you on this page with the drawer open over it.
