import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../api-context";
import { Checkbox, Field, FieldRow } from "../ui";

const OTHER = "\u0000other";

/**
 * Repository and base branch as pickers rather than remembered strings. Both used to be free
 * text whose mistakes only surfaced when `ensure-worktree` ran, part-way through a workflow.
 * The repo list comes from repositories other tasks already use, with a manual entry for the
 * first one; branches come from the chosen repo.
 */
export function RepoFields({
  repoPath,
  baseBranch,
  optional = false,
  onChange,
}: {
  repoPath: string;
  baseBranch: string;
  optional?: boolean;
  onChange: (patch: { repoPath?: string; baseBranch?: string }) => void;
}) {
  const api = useApi();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, staleTime: 30_000 });
  const known = repos.data ?? [];
  // Stay on the free-text entry while it is being typed, even before it matches a known repo.
  // Only an explicit "Another repository…" sets this: deciding it from the list before the list
  // had loaded used to put every saved repository into the text box.
  const [typing, setTyping] = useState(false);

  const branches = useQuery({
    queryKey: ["branches", repoPath],
    queryFn: () => api.branches(repoPath),
    enabled: repoPath !== "",
    retry: false,
    staleTime: 30_000,
  });

  const listed = known.some((repo) => repo.path === repoPath);
  // Until the list arrives, show the saved path as it is rather than guessing it's unlisted.
  const pending = repoPath !== "" && !listed && !repos.isSuccess;
  const selectValue = typing || (repoPath !== "" && !listed && !pending) ? OTHER : repoPath;

  return (
    <FieldRow>
      <Field label="Repository" optional={optional} grow error={repoPath !== "" && branches.isError ? branches.error.message : undefined}>
        <select
          value={selectValue}
          onChange={(event) => {
            const next = event.target.value;
            setTyping(next === OTHER);
            // Switching repositories invalidates the branch chosen from the old one.
            onChange({ repoPath: next === OTHER ? "" : next, baseBranch: "" });
          }}
        >
          <option value="">No repository</option>
          {pending && <option value={repoPath}>{repoPath}</option>}
          {known.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repo.path}
              {repo.exists ? "" : " — missing"}
            </option>
          ))}
          <option value={OTHER}>Another repository…</option>
        </select>
        {selectValue === OTHER && (
          <input
            // Focus only follows the user's own pick; a saved path mustn't pull the drawer's scroll down to it.
            autoFocus={typing}
            value={repoPath}
            placeholder="C:\code\my-app"
            onChange={(event) => onChange({ repoPath: event.target.value })}
          />
        )}
      </Field>

      <Field label="Base branch" optional={optional}>
        <select
          value={baseBranch}
          disabled={repoPath === "" || branches.isError}
          onChange={(event) => onChange({ baseBranch: event.target.value })}
        >
          <option value="">{repoPath === "" ? "No repository" : "The repo's current branch"}</option>
          {(branches.data ?? []).map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
          {/* Keep a branch that has since been deleted visible rather than silently switching it. */}
          {baseBranch !== "" && !(branches.data ?? []).includes(baseBranch) && (
            <option value={baseBranch}>{baseBranch} — not in this repo</option>
          )}
        </select>
      </Field>
    </FieldRow>
  );
}

/** Whether the task gets its own git worktree and branch, or works in the repository's checkout. */
export function WorktreeCheck({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      label="Use a worktree"
      tip={
        disabled
          ? "The worktree already exists; archiving the task removes it."
          : "Work happens on a new branch in a separate checkout, so tasks on the same repository don't collide. Off, agents and commands work in the repository's own checkout."
      }
    />
  );
}
