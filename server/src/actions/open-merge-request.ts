import { z } from "zod";
import { git } from "../lib/git";
import { runProcess, tail } from "../lib/process";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  remote: z.string().min(1).default("origin"),
  /** auto: github.com remotes use `gh pr create`, everything else uses GitLab push options. */
  host: z.enum(["auto", "gitlab", "github"]).default("auto"),
  title: z.string().min(1),
  description: z.string().default(""),
  /** When non-empty and the worktree is dirty, commit everything with this message first. */
  commitMessage: z.string().default(""),
  draft: z.boolean().default(false),
});

export const openMergeRequestAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "open-merge-request",
  label: "Open merge request",
  description: "Pushes the task branch and opens a GitLab merge request or GitHub pull request.",
  configSchema,
  fields: [
    { name: "title", label: "Title", kind: "text", default: "{{task.title}}", templated: true },
    { name: "description", label: "Description", kind: "textarea", default: "{{task.description}}", templated: true },
    {
      name: "commitMessage",
      label: "Commit uncommitted changes as",
      kind: "text",
      default: "",
      templated: true,
      help: "Leave blank to fail instead when the worktree is dirty.",
    },
    { name: "remote", label: "Remote", kind: "text", default: "origin" },
    {
      name: "host",
      label: "Host",
      kind: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Detect from the remote URL" },
        { value: "gitlab", label: "GitLab (push options)" },
        { value: "github", label: "GitHub (gh pr create)" },
      ],
    },
    { name: "draft", label: "Open as draft", kind: "boolean", default: false },
  ],
  async run({ config, task, signal, log }) {
    if (!task.worktreePath || !task.branch || !task.baseBranch) {
      throw new Error("Task has no worktree yet; run ensure-worktree first");
    }
    const onLine = (text: string, stream: "stdout" | "stderr") => log(text, stream);
    const options = { cwd: task.worktreePath, signal, onLine };

    if (config.commitMessage && (await git(["status", "--porcelain"], { cwd: task.worktreePath, signal }))) {
      log("Committing uncommitted changes");
      await git(["add", "-A"], options);
      await git(["commit", "-m", config.commitMessage], options);
    }

    const remoteUrl = await git(["remote", "get-url", config.remote], { cwd: task.worktreePath, signal });
    const host = config.host === "auto" ? (/github\.com[:/]/i.test(remoteUrl) ? "github" : "gitlab") : config.host;

    let mrUrl: string | null;
    if (host === "gitlab") {
      // Push option values cannot contain newlines.
      const oneLine = (value: string) => value.replace(/\s*\r?\n\s*/g, " ").trim();
      const title = config.draft ? `Draft: ${oneLine(config.title)}` : oneLine(config.title);
      const args = ["push", "-u", config.remote, task.branch];
      args.push("-o", "merge_request.create", "-o", `merge_request.target=${task.baseBranch}`);
      args.push("-o", `merge_request.title=${title}`);
      if (config.description) args.push("-o", `merge_request.description=${oneLine(config.description)}`);
      const output = await git(args, { ...options, includeStderr: true });
      mrUrl = output.match(/https?:\/\/\S+\/merge_requests\/\d+/)?.[0] ?? null;
    } else {
      await git(["push", "-u", config.remote, task.branch], options);
      const args = ["pr", "create", "--base", task.baseBranch, "--head", task.branch];
      args.push("--title", config.title, "--body", config.description);
      if (config.draft) args.push("--draft");
      const result = await runProcess({ command: "gh", args, cwd: task.worktreePath, signal, onLine }).catch(
        (err: NodeJS.ErrnoException) => {
          throw err.code === "ENOENT" ? new Error("GitHub CLI (gh) is not installed") : err;
        },
      );
      if (result.aborted) throw new Error("Cancelled");
      if (result.code !== 0) throw new Error(`gh pr create failed: ${tail(result.output, 5)}`);
      mrUrl = result.output.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
    }

    if (!mrUrl) log("Pushed, but could not find the merge request URL in the output", "stderr");
    return { outputs: { mrUrl, host }, summary: mrUrl ?? "branch pushed" };
  },
};
