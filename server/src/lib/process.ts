import { execFile, spawn } from "node:child_process";

export interface RunProcessOptions {
  command: string;
  args?: string[];
  /** Run `command` through the platform shell (cmd.exe on Windows, /bin/sh elsewhere). */
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Kill the process if it produces no output for this long. */
  inactivityTimeoutMs?: number;
  /**
   * Suspends the inactivity timeout while true. An agent blocked on a question the user hasn't
   * answered yet is silent on purpose, and must not be mistaken for a hung process.
   */
  isIdleExpected?: () => boolean;
  onLine?: (text: string, stream: "stdout" | "stderr") => void;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Interleaved stdout + stderr, capped to the most recent MAX_BUFFER characters. */
  output: string;
  timedOut: boolean;
  inactive: boolean;
  aborted: boolean;
}

const MAX_BUFFER = 1_000_000;

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const empty = { code: null, stdout: "", stderr: "", output: "" };
    if (options.signal?.aborted) return resolve({ ...empty, timedOut: false, inactive: false, aborted: true });

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const buffers = { stdout: "", stderr: "", output: "" };
    let timedOut = false;
    let inactive = false;
    let aborted = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const touch = () => {
      if (!options.inactivityTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Silence is expected while the agent waits on a person; check again later instead.
        if (options.isIdleExpected?.()) return touch();
        inactive = true;
        killTree(child.pid);
      }, options.inactivityTimeoutMs);
    };

    const cap = (value: string) => (value.length > MAX_BUFFER ? value.slice(-MAX_BUFFER) : value);
    const lineSplitter = (stream: "stdout" | "stderr") => {
      let pending = "";
      return {
        push(chunk: string) {
          touch();
          buffers[stream] = cap(buffers[stream] + chunk);
          buffers.output = cap(buffers.output + chunk);
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) options.onLine?.(line, stream);
        },
        flush() {
          if (pending) options.onLine?.(pending, stream);
          pending = "";
        },
      };
    };
    const stdout = lineSplitter("stdout");
    const stderr = lineSplitter("stderr");
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // the child may exit before reading everything
      child.stdin.end(options.stdin);
    }

    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs)
      : undefined;
    touch();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      stdout.flush();
      stderr.flush();
      resolve({ code, ...buffers, timedOut, inactive, aborted });
    });
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

export function tail(text: string, lines = 20): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/** CLIs colour their output whenever they feel like it; the run log and output regexes want plain text. */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
