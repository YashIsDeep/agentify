import type { TaskSummary } from "@wm/shared";
import { FolderGit2, GitBranch, Link2 } from "lucide-react";
import { linkTypeLabel } from "../lib/links";
import { Tag, TagList } from "../ui";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";

const linkIcon = (type: string) => (hasBrandIcon(type) ? <BrandIcon brand={type} size={11} /> : Link2);

/**
 * A task's repository, branch, links and tags as a row of tags. `compact` is the board card's
 * version: no repository, the branch without its `wm/` prefix, and links named but not clickable
 * (the card itself is the click target). The full version names the repository and keeps the
 * branch, a long slug of the title, in its tooltip.
 */
export function TaskMeta({ task, compact = false }: { task: TaskSummary; compact?: boolean }) {
  const repoName = compact ? undefined : task.repoPath?.split(/[\\/]/).filter(Boolean).pop();
  if (!repoName && !task.branch && task.links.length === 0 && task.tags.length === 0) return null;
  const repoTitle = [task.repoPath, task.branch, task.worktreePath].filter(Boolean).join("\n");

  return (
    <TagList>
      {repoName && (
        <Tag icon={FolderGit2} title={repoTitle}>
          {repoName}
        </Tag>
      )}
      {task.branch && !repoName && (
        <Tag icon={GitBranch} title={task.worktreePath ? `${task.branch}\n${task.worktreePath}` : task.branch} className="task-branch">
          {compact ? task.branch.replace(/^wm\//, "") : task.branch}
        </Tag>
      )}
      {task.links.map((link) => {
        const url = /^https?:\/\//.test(link.value);
        return (
          <Tag key={`${link.type}:${link.value}`} icon={linkIcon(link.type)} href={!compact && url ? link.value : undefined} title={link.value}>
            {linkTypeLabel(link.type)}
            {!compact && !url && `: ${link.value}`}
          </Tag>
        );
      })}
      {task.tags.map((tag) => (
        <Tag key={tag} tone="accent">
          {tag}
        </Tag>
      ))}
    </TagList>
  );
}
