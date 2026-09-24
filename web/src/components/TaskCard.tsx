import type { TaskSummary } from "@wm/shared";
import { age, cls } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { TaskMeta } from "./TaskMeta";

export function TaskCardView({
  task,
  now,
  selected = false,
  overlay = false,
}: {
  task: TaskSummary;
  now: number;
  selected?: boolean;
  overlay?: boolean;
}) {
  const { done, total } = task.actionProgress;
  return (
    <div className={cls("card", `card-${task.badge}`, selected && "card-selected", overlay && "card-overlay")}>
      <div className="card-top">
        <StatusBadge badge={task.badge} detail={task.badgeDetail} />
        {task.enteredStageAt && (
          <span className="card-age" title="Time in this stage">
            {age(task.enteredStageAt, now)}
          </span>
        )}
      </div>
      <div className="card-title">{task.title}</div>
      {total > 0 && (
        <div className="progress-dots" title={`${done} of ${total} actions done`}>
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              className={cls(
                "progress-dot",
                index < done && "progress-dot-done",
                index === done && `progress-dot-current progress-dot-${task.badge}`,
              )}
            />
          ))}
        </div>
      )}
      <TaskMeta task={task} compact />
    </div>
  );
}
