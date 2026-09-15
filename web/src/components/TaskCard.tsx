import type { TaskSummary } from "@wm/shared";
import { GitBranch, Link2 } from "lucide-react";
import { age, cls } from "../lib/format";
import { linkTypeLabel } from "../lib/links";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";
import { StatusBadge } from "./StatusBadge";

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
      {(task.branch || task.links.length > 0 || task.tags.length > 0) && (
        <div className="card-meta">
          {task.branch && (
            <span className="chip" title={task.branch}>
              <GitBranch size={11} />
              {task.branch.replace(/^wm\//, "")}
            </span>
          )}
          {task.links.map((link) => (
            <span key={`${link.type}:${link.value}`} className="chip" title={link.value}>
              {hasBrandIcon(link.type) ? <BrandIcon brand={link.type} size={11} /> : <Link2 size={11} />}
              {linkTypeLabel(link.type)}
            </span>
          ))}
          {task.tags.map((tag) => (
            <span key={tag} className="chip chip-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
