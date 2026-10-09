# Loop modes

Every coding-agent action runs in one loop mode, chosen under **Loop** in its settings. **Add action** also offers each loop as a ready-made preset.

## Sub-features

- single run: one agent run with no automatic review. **Autonomy** (Read-only / Autonomous) decides whether it may edit the repository.
- plan loop: draft → independent review → revise → re-review, read-only. Corrections go back to the author. The preset saves the accepted document as `plan.md`.
- Build–verify: the same cycle for any document, with **Verification criteria** in addition to the prompt. Both document loops preserve B1 → Review V1 → B2 → Review V2 in Artifacts. The normal artifact name holds the latest accepted build.
- implement loop: implement → independent review → the reviewer fixes the code and runs checks → repeat until accepted. The preset prompt reads `{{artifacts["plan.md"]}}`.
- CI loop: publish (optional) → check → fix failures → publish → check again. Only a zero exit status from **CI check command** counts as passing. It never merges.
- limits: **Maximum correction attempts** (default 3, range 1–10). Reaching the limit fails the action with the remaining feedback.
- CI fields: **CI check command**, plus advanced settings: **CI publish command**, **CI command shell** (System default / PowerShell / cmd.exe / Bash / sh), **CI command timeout (seconds)** (default 1800).
- review UI: the review-card tags "Agent reviewed" / "CI passed" and the "Final work ready for approval" heading (see `agent-review.md`).
- migration: agents saved before loop modes are converted at server start. Gated + review + read-only becomes a plan loop, gated + review + editing becomes an implement loop, and anything else becomes a single run. Conversions that change review kind are logged.

## How to get to it (user POV)

Go to Workflows, pick a stage, click **Add action**, and choose **Plan loop** / **Build–verify** / **Implement loop** / **CI loop**. Alternatively, open a coding-agent action's settings and change **Loop**.

## Driving it

- Editor: `find "Add action"` opens `menu "Choose an action"`, where the loop presets come first. The new action's settings dialog opens immediately.
- In the stage editor, a loop shows its loop label ("Plan loop") where a single run shows "Coding agent".
- A CI loop can be exercised without a real failing CI by setting **CI check command** to `node -e "process.exit(0)"`. A fresh CI loop whose first check passes finishes without an agent turn, so this costs no quota. The agent only runs after a failed check or a requested revision. The agent CLI must still resolve, and the task needs a repository (and its worktree, when **Use a worktree** is on).
- Run state: `run.outputs.loop` / `run.outputs.review` / `run.outputs.ci` in `GET .../tasks/<taskId>`.

## Gotchas

- Invalid reviews or blocked fixes fail the action instead of asking you to approve unfinished work.
- The reviewer's verdict is the last valid JSON verdict anywhere in its reply, so prose or a code fence around it is fine. A reply with none gets one "reply with only the JSON" turn in the reviewer's session before the action fails.
- The reviewer and the reviser are shown what you answered the author's `ask_user` questions in this run ("question → answer"), as the user's decisions.
- An implement loop's run keeps the **author's** session (`run.sessionId`); the reviewer's is in `run.outputs.review.sessionId`. **Request revision** and **Continue the previous session** resume the author.
- Quota waits keep the loop's phase and attempt count, so resuming continues where it stopped.
- Build/review numbering survives quota resumes and continues across revisions and new runs. Invalid reviews and builds from exhausted loops stay visible; they never replace the accepted artifact. A blank artifact name still retains document history under `steps/<action-key>.md`.
- The default workflows seed no CI loop; add one to Ship in the editor with a real check command.
- Shell commands (check and publish) can't use `{{…}}` templates. Use `WM_*` env vars.
