# Quota waits, queue & restarts

How runs wait: for a subscription usage limit to reset, for a free concurrency slot, or after the server stopped in the middle of a run.

## Sub-features

- usage-limit detection: Claude's `rate_limit_event`, plus prose from any CLI ("usage limit", "hit your limit", "limit reached … resets", "out of usage credits"), with the reset time parsed when given.
- quota-wait: the run status becomes `quota-wait` with `resumeAt`. The task badge reads "Resets 2:40 AM" (title "Waiting for a usage limit to reset"), and the Stopped counter lists it with "<agent> resets <time>".
- agent hold: once one run hits an agent's limit, later runs of that agent in the same workspace wait with it instead of spending a request to find out. Calls already in flight are not stopped.
- auto-resume: the runner arms a timer for the earliest reset and requeues runs that are due.
- **Try now**: in the run row or chat header, it retries before the reset time.
- switching agent while parked: a task override can switch agents during a wait. The old session is discarded, and the previous answer is kept as context.
- queue: the **Agents at once** limit (Agents → Concurrency, 1–50) applies across all workspaces. Extra runs are `queued`, and a freed slot wakes queued work in any workspace.
- restart: runs that were in flight when the server stopped are marked `interrupted` ("Server stopped while this action was running") on the next start, with a timeline event. Retry or Skip them.

## How to get to it (user POV)

These states appear on their own. Look for the hourglass badge, the Stopped counter, "Queued" cards, or an "Interrupted" row after a restart.

## Driving it

- Interrupted: start a long shell action (`node -e "setTimeout(()=>{},600000)"`), restart the dev server with `preview_stop` then `preview_start`, and expect the row to read Interrupted with **Retry** and **Skip** available.
- Queue: set **Agents at once** to 1 (`PUT /api/settings/concurrency {maxConcurrentAgents:1}`) and start two agent runs. The second shows Queued.
- Quota: there is no fake switch in the UI. `server/test/quota.test.ts` covers the engine. In the UI, verify only from a real limit, or mark it unreachable.

## Gotchas

- Queued tasks are not counted in the sidebar.
- The concurrency cap counts coding-agent runs only, including one blocked on a question. Shell actions don't take a slot. The cap is stored in the default workspace's settings.
- A limit whose reset time can't be read still counts. The caller then picks a time to try again.
