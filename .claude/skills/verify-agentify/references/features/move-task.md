# Move task

Moves a task to another stage of its workflow, optionally running that stage's entry actions.

## Sub-features

- route: "From → To" tags, with the task title as the lead.
- active-runs warning: "Actions still running in <stage> will be cancelled." Shown when the current visit has active runs, including an agent blocked on a question.
- run-actions: the **Run its actions** checkbox (default on) with "In order: A → B → C." It is hidden when the target stage has no actions.
- submit: **Move to <Stage>** (autofocused).
- skipped actions: moving with **Run its actions** off leaves the stage unstarted. The task then shows **Needs you** with "Start <stage>'s actions", and the drawer and Open conversations offer **Start**.

## How to get to it (user POV)

Drag a card to another column on the board, or click a stage in the drawer's stepper (any stage except the current one).

## Driving it

- Stepper: in `aside "Task details"`, `ol "Stages"` buttons have the title "Move to <Stage>".
- Submit → wait for the card to appear in the target column, or check `currentStageId` via `GET .../tasks/<id>`.
- API: `POST /api/workspaces/<id>/tasks/<taskId>/move {stageId, runActions}`. `POST .../tasks/<taskId>/start` starts the unstarted actions.
- Timeline should gain `stage.exited` / `stage.entered`, and runs are created when **Run its actions** is on. `actions.started` appears only when you later **Start** an unstarted stage.

## Gotchas

- Moving back to a visited stage starts a new visit with "attempt N".
- Archived tasks have their stepper disabled.
- Moving cancels running work but keeps whatever it already changed.
