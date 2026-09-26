import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_CONCURRENT_AGENTS } from "@wm/shared";

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  /** Extra localhost ports allowed as request Origin (e.g. the Vite dev server). */
  devOriginPorts: number[];
  /** Used until the cap is changed in the UI, which saves it in the default workspace. */
  maxConcurrentLongRuns: number;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The UI's address: `npm start` serves it from the API, `npm run dev` from Vite. */
const UI_PORT = 2712;
const DEV_API_PORT = 2711;

/**
 * In dev mode data defaults to `<repo>/.wm-data` so experiments never touch real tasks, and the
 * API steps aside to DEV_API_PORT so Vite can hold UI_PORT.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { dev?: boolean } = {}): AppConfig {
  const defaultDataDir = options.dev ? join(REPO_ROOT, ".wm-data") : homeDataDir();
  return {
    dataDir: resolve(env.WM_DATA_DIR ?? defaultDataDir),
    host: "127.0.0.1",
    port: positiveInt(env.WM_PORT, options.dev ? DEV_API_PORT : UI_PORT),
    devOriginPorts: [UI_PORT],
    maxConcurrentLongRuns: DEFAULT_MAX_CONCURRENT_AGENTS,
  };
}

/**
 * `~/.agentify`, unless only the pre-rename `~/.workflow-manager` exists. That one is used in place
 * rather than moved, since the git worktrees inside it record their absolute paths.
 */
function homeDataDir(): string {
  const current = join(homedir(), ".agentify");
  const legacy = join(homedir(), ".workflow-manager");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
