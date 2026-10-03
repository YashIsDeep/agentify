import { useQuery } from "@tanstack/react-query";
import type { TaskDiff, TaskDiffFile, TaskSummary } from "@wm/shared";
import { ChevronDown, ChevronRight, Copy, FileDiff, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useApi } from "../api-context";
import { diffLineClass, splitPatch } from "../lib/diff";
import { cls } from "../lib/format";
import { IconButton, useToast } from "../ui";

const STATUS_LETTER: Record<TaskDiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

/** The change a review stage asks about: the files first, each one's hunks when you want them. */
export function DiffPanel({ task }: { task: TaskSummary }) {
  const api = useApi();
  const toast = useToast();
  // A task with no repository has no diff to ask the server for.
  const diff = useQuery({ queryKey: ["diff", task.id], queryFn: () => api.taskDiff(task.id), enabled: !!task.repoPath && !!task.branch });
  // Only a code task has a diff; the branch arrives with the worktree.
  if (!task.repoPath || !task.branch) return null;

  const path = task.worktreePath ?? task.repoPath;
  const copyPath = () =>
    navigator.clipboard.writeText(path).then(() => toast("Copied the path"), () => toast("Could not copy", "error"));

  return (
    <div className="diff-panel">
      <div className="diff-head">
        <FileDiff size={14} />
        {/* The branch is in the drawer header already; here it's the tooltip. */}
        <strong title={task.branch}>Changes</strong>
        {diff.data &&
          (diff.data.files.length === 0 ? (
            <span className="muted small">none against {diff.data.baseBranch} yet</span>
          ) : (
            <span className="muted small">
              {diff.data.files.length} file{diff.data.files.length === 1 ? "" : "s"}, +{diff.data.insertions} −
              {diff.data.deletions}
            </span>
          ))}
        <span className="spacer" />
        {/* Worth having even when the diff is too big to read here — the path is the way into it. */}
        <IconButton label={`Copy ${path}`} icon={Copy} size="sm" onClick={copyPath} />
        <IconButton label="Read the diff again" icon={RefreshCw} size="sm" disabled={diff.isFetching} onClick={() => void diff.refetch()} />
      </div>
      {diff.isLoading ? (
        <p className="muted small">Reading the diff…</p>
      ) : diff.error ? (
        <p className="error small">{diff.error.message}</p>
      ) : diff.data ? (
        <DiffFiles diff={diff.data} />
      ) : null}
    </div>
  );
}

function DiffFiles({ diff }: { diff: TaskDiff }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const hunks = useMemo(() => splitPatch(diff.patch), [diff.patch]);

  // The header says "none"; an empty body would only repeat it.
  if (diff.files.length === 0) return null;

  return (
    <>
      <ul className="diff-files">
        {diff.files.map((file) => {
          const patch = hunks.get(file.path);
          const open = openPath === file.path;
          return (
            <li key={file.path}>
              <button
                type="button"
                className="diff-file"
                aria-expanded={open}
                disabled={!patch}
                title={patch ? undefined : "No hunks to show"}
                onClick={() => setOpenPath(open ? null : file.path)}
              >
                {patch ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="chevron-space" />}
                <span
                  className={cls("diff-status", `diff-status-${file.status}`)}
                  title={file.untracked ? "New, not added to git yet" : undefined}
                >
                  {STATUS_LETTER[file.status]}
                </span>
                <span className="diff-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="diff-counts">
                  {file.binary ? (
                    <span className="muted">binary</span>
                  ) : (
                    <>
                      <span className="diff-plus">+{file.insertions}</span>{" "}
                      <span className="diff-minus">−{file.deletions}</span>
                    </>
                  )}
                </span>
              </button>
              {open && patch && (
                <pre className="log diff-hunks">
                  {patch.split("\n").map((line, index) => (
                    <span key={index} className={diffLineClass(line)}>
                      {`${line}\n`}
                    </span>
                  ))}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
      {diff.truncated && <p className="muted small">Too large to show in full — the rest of it is in {diff.path}.</p>}
      {!diff.uncommitted && (
        <p className="muted small">
          {diff.branch} isn't checked out in {diff.path}, so uncommitted work isn't shown.
        </p>
      )}
    </>
  );
}

