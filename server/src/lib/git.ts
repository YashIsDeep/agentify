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
}

/** Runs git without a shell and returns trimmed output. Throws GitError on non-zero exit. */
export async function git(args: string[], options: GitOptions): Promise<string> {
  const result = await runProcess({
    command: "git",
    args,
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}
