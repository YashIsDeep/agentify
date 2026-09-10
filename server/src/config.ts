import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  /** Extra localhost ports allowed as request Origin (e.g. the Vite dev server). */
  devOriginPorts: number[];
  maxConcurrentLongRuns: number;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** In dev mode data defaults to `<repo>/.wm-data` so experiments never touch real tasks. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { dev?: boolean } = {}): AppConfig {
  const defaultDataDir = options.dev ? join(REPO_ROOT, ".wm-data") : join(homedir(), ".workflow-manager");
  return {
    dataDir: resolve(env.WM_DATA_DIR ?? defaultDataDir),
    host: "127.0.0.1",
    port: positiveInt(env.WM_PORT, 4280),
    devOriginPorts: [5173],
    maxConcurrentLongRuns: positiveInt(env.WM_MAX_CONCURRENT_AGENTS, 3),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
