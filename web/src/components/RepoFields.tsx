import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../api-context";

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
  onChange,
}: {
  repoPath: string;
  baseBranch: string;
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
    <div className="field-row">
      <label className="field field-grow">
        <span>Repository</span>
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
        {repoPath !== "" && branches.isError && <span className="hint error">{branches.error.message}</span>}
      </label>

      <label className="field">
        <span>Base branch</span>
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
      </label>
    </div>
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
    <label className="field field-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>Use a worktree</span>
      <span className="hint">
        {disabled
          ? "The worktree already exists; archiving the task removes it."
          : checked
            ? "Work happens on a new branch in a separate checkout, so tasks on the same repo don't collide."
            : "Agents and commands work directly in the repository's checkout, on whatever branch it has."}
      </span>
    </label>
  );
}
