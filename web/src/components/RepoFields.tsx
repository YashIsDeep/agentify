import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

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
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, staleTime: 30_000 });
  const known = repos.data ?? [];
  // Stay on the free-text entry while it is being typed, even before it matches a known repo.
  const [typing, setTyping] = useState(() => repoPath !== "" && !known.some((repo) => repo.path === repoPath));

  const branches = useQuery({
    queryKey: ["branches", repoPath],
    queryFn: () => api.branches(repoPath),
    enabled: repoPath !== "",
    retry: false,
    staleTime: 30_000,
  });

  const listed = known.some((repo) => repo.path === repoPath);
  const selectValue = typing || (repoPath !== "" && !listed) ? OTHER : repoPath;

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
            autoFocus
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
