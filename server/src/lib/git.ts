import { runProcess, stripAnsi, tail } from "./process";

export class GitError extends Error {
  override name = "GitError";
}

export interface GitOptions {
  cwd: string;
  signal?: AbortSignal;
  onLine?: (text: string, stream: "stdout" | "stderr") => void;
  /** Return stdout + stderr (remote messages such as merge request links land on stderr). */
  includeStderr?: boolean;
  /** Extra environment, e.g. GIT_INDEX_FILE to work on a scratch index. */
  env?: Record<string, string>;
}

/** Runs git without a shell and returns trimmed output. Throws GitError on non-zero exit. */
export async function git(args: string[], options: GitOptions): Promise<string> {
  const result = await runProcess({
    command: "git",
    args,
    cwd: options.cwd,
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
    signal: options.signal,
    // Stripped here so every git-invoking action logs plain text, whatever the repo's colour config says.
    onLine: options.onLine && ((text, stream) => options.onLine?.(stripAnsi(text), stream)),
  });
  if (result.aborted) throw new GitError("git was cancelled");
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (exit ${result.code}): ${tail(result.output, 10)}`);
  }
  return (options.includeStderr ? result.output : result.stdout).trim();
}

export async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  const result = await runProcess({ command: "git", args, cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.code === 0;
}

const SLUG_LENGTH = 40;

/** Lower-case words joined by hyphens, at most 40 characters, cut between words where it can be. */
export function slugify(text: string): string {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_LENGTH) return full || "task";
  // One character more, so a word ending exactly at the limit still counts as whole.
  const boundary = full.slice(0, SLUG_LENGTH + 1).lastIndexOf("-");
  // A single long word would leave almost nothing; cut through it instead.
  const slug = boundary >= SLUG_LENGTH / 2 ? full.slice(0, boundary) : full.slice(0, SLUG_LENGTH);
  return slug.replace(/-+$/g, "") || "task";
}
