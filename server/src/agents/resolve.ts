import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { type ProcessResult, runProcess } from "../lib/process";
import type { ResolvedCli } from "./types";

const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

/**
 * Turns a path into something spawnable without a shell. npm's Windows shims (.cmd/.ps1) can't be
 * spawned directly, and running them through cmd.exe would mangle multi-line prompts, so we
 * follow the shim to the real .exe or .js entry point.
 */
export function cliFromPath(path: string): ResolvedCli {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) return { command: process.execPath, prefixArgs: [path], path };
  if (extension === ".ps1") {
    const cmd = path.slice(0, -extension.length) + ".cmd";
    if (existsSync(cmd)) return cliFromPath(cmd);
  }
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    const target = shimTarget(path);
    if (target) return cliFromPath(target);
    const launcher = versionedLauncher(path);
    if (launcher) return launcher;
    throw new Error(`Can't tell what ${path} runs; point to the underlying .exe or .js file instead`);
  }
  return { command: path, prefixArgs: [], path };
}

const VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;
const versionDate = (name: string) => {
  const [year = 0, month = 0, day = 0] = (name.split("-")[0] ?? "").split(".").map(Number);
  return year * 10_000 + month * 100 + day;
};

/**
 * Cursor's launcher (.cmd → .ps1) runs the newest `versions/<YYYY.MM.DD-commit>/index.js` with the
 * node.exe bundled beside it. Resolved on every launch, like the launcher itself, so auto-updates
 * are picked up.
 */
export function versionedLauncher(shimFile: string): ResolvedCli | null {
  const versionsDir = join(dirname(shimFile), "versions");
  if (!existsSync(versionsDir)) return null;
  const candidates = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => versionDate(b) - versionDate(a) || b.localeCompare(a));
  for (const name of candidates) {
    const node = join(versionsDir, name, "node.exe");
    const entry = join(versionsDir, name, "index.js");
    if (existsSync(node) && existsSync(entry)) return { command: node, prefixArgs: [entry], path: entry };
  }
  return null;
}

/** npm .cmd shims reference their target as `"%dp0%\node_modules\...\bin\tool.exe"` (or a .js run by node). */
export function shimTarget(shimFile: string): string | null {
  const text = readFileSync(shimFile, "utf8");
  const targets = [...text.matchAll(/"%dp0%\\([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target && !/^node(\.exe)?$/i.test(target));
  const last = targets.at(-1);
  return last ? join(dirname(shimFile), last) : null;
}

export function findOnPath(binName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${binName}.cmd`, `${binName}.exe`] : [binName];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

export function resolveCli(binName: string, override: string | null, installLocations: string[] = []): ResolvedCli | null {
  const path = override ?? findOnPath(binName) ?? installLocations.find((location) => existsSync(location)) ?? null;
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return cliFromPath(path);
}

/** Runs a short CLI command (version, auth status) with a timeout. */
export function execCli(cli: ResolvedCli, args: string[], timeoutMs = 20_000): Promise<ProcessResult> {
  return runProcess({
    command: cli.command,
    args: [...cli.prefixArgs, ...args],
    cwd: tmpdir(),
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs,
  });
}
