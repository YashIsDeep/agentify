#!/usr/bin/env node
// Gets a full sweep ready in one command (`npm run qa`): the preflight from
// references/features/README.md, a clean sandbox, the built server on its own port, and a run sheet
// with one row per feature file. The sweep itself is then driven by an agent with this skill.
//
//   npm run qa                  preflight, sandbox, run sheet, then serve until Ctrl+C
//   npm run qa -- --reset       throw the sandbox away and build a new one first
//   npm run qa -- --skip-checks skip typecheck and tests
//   npm run qa -- --allow-dirty carry on with uncommitted changes
//   npm run qa -- --no-server   prepare everything but don't start the server
//
// WM_QA_DIR (default C:/code/wm-qa) and WM_QA_PORT (default 2816) move the sandbox and the port; the
// `workflow-manager-qa` launch config assumes the defaults.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const features = resolve(here, "../references/features");
const flags = new Set(process.argv.slice(2));
const known = ["--reset", "--skip-checks", "--allow-dirty", "--no-server"];
const unknown = [...flags].filter((flag) => !known.includes(flag));
if (unknown.length) fail(`Unknown option ${unknown.join(", ")}. Options: ${known.join(", ")}`);

const sandbox = resolve(process.env.WM_QA_DIR ?? "C:/code/wm-qa");
const port = Number(process.env.WM_QA_PORT ?? 2816);
const base = `http://127.0.0.1:${port}`;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
const step = (text) => console.log(`\n▸ ${text}`);
const git = (...args) => execFileSync("git", args, { cwd: repoRoot }).toString().trim();
const npm = (...args) => spawnSync(`npm ${args.join(" ")}`, { cwd: repoRoot, stdio: "inherit", shell: true }).status === 0;
const get = async (path) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
};
const serverUp = () => get("/api/workspaces").then(() => true, () => false);

// 1. Pin the target.
step("Target");
const commit = git("rev-parse", "--short", "HEAD");
const dirty = git("status", "--short");
console.log(`${git("branch", "--show-current") || "(detached)"} @ ${commit}`);
if (dirty && !flags.has("--allow-dirty")) {
  fail(`Uncommitted changes, so the sweep would not run against a known commit:\n${dirty}\nCommit them, or pass --allow-dirty.`);
}

// 2. Checks.
if (flags.has("--skip-checks")) console.log("\n▸ Typecheck and tests skipped");
else {
  step("Typecheck");
  if (!npm("run", "typecheck")) fail("Typecheck failed");
  step("Tests");
  if (!npm("test")) fail("Tests failed");
}

// 3. Sandbox.
step("Sandbox");
const running = await serverUp();
if (flags.has("--reset") && existsSync(sandbox)) {
  if (running) fail(`A server is still running on ${base} and holds ${sandbox}. Stop it first.`);
  // Only ever a directory this script's sibling created.
  if (!existsSync(join(sandbox, "origin.git")) || !existsSync(join(sandbox, "data"))) fail(`${sandbox} doesn't look like a sweep sandbox; not removing it.`);
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`Removed ${sandbox}`);
}
if (existsSync(sandbox)) console.log(`Reusing ${sandbox} (pass --reset for a new one)`);
else if (spawnSync(process.execPath, [join(here, "new-sandbox.mjs"), sandbox], { stdio: "inherit" }).status !== 0) fail("Could not build the sandbox");

// 4. Run sheet.
step("Run sheet");
const today = new Date().toLocaleDateString("sv");
const sheet = join(repoRoot, "docs", `QA-${today}-sweep.md`);
const rows = [...readFileSync(join(features, "README.md"), "utf8").matchAll(/^- \[([^\]]+)\]\(([^)]+\.md)\)/gm)].map((match) => match[1]);
if (existsSync(sheet)) console.log(`Keeping ${sheet}`);
else {
  writeFileSync(sheet, `# Agentify — full sweep, ${today}

## Verdict

## Setup

- Commit \`${commit}\`${dirty ? " plus uncommitted changes" : ""}; built server on \`${base}\`, data in \`${join(sandbox, "data")}\`.
- Sandbox repository \`${join(sandbox, "repo")}\` with the bare origin \`${join(sandbox, "origin.git")}\`.
- Agents and models used:

## Findings

## Skipped

## Feature map

| Feature file | Result | Evidence |
|---|---|---|
${rows.map((name) => `| ${name} | | |`).join("\n")}

## Left on disk
`);
  console.log(`Wrote ${sheet} (${rows.length} feature files)`);
}

// 5. Server.
step("Server");
let server;
if (running) console.log(`Already running on ${base}`);
else if (flags.has("--no-server")) console.log(`Not started. Later: preview_start { name: "workflow-manager-qa" }`);
else {
  console.log("Building and starting (this takes a moment)…");
  server = spawn("npm start", {
    cwd: repoRoot, shell: true, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, WM_DATA_DIR: join(sandbox, "data"), WM_PORT: String(port) },
  });
  server.on("exit", (code) => process.exit(code ?? 0));
  const deadline = Date.now() + 180_000;
  while (!(await serverUp())) {
    if (Date.now() > deadline) fail(`The server did not answer on ${base} within 3 minutes`);
    await new Promise((done) => setTimeout(done, 1500));
  }
  console.log(`Serving on ${base}`);
}

// 6. What the sweep can reach.
if (running || server) {
  step("Agents");
  for (const agent of await get("/api/workspaces/default/agents")) {
    const state = !agent.installed ? "not installed" : agent.loggedIn ? "ready" : "not logged in";
    console.log(`${agent.label.padEnd(14)} ${state}${agent.version ? ` (${agent.version})` : ""}`);
  }
  const workflows = await get("/api/workspaces/default/workflows");
  const tasks = await get("/api/workspaces/default/tasks?status=active");
  console.log(`\nWorkflows: ${workflows.map((workflow) => workflow.name).join(", ")} · active tasks: ${tasks.length}`);
  if (tasks.length) console.log("The data directory isn't fresh. Pass --reset for a clean seed.");
}

console.log(`
Ready. In Claude Code, ask:

  Run the full sweep from the verify-agentify feature map against ${base}
  (sandbox repository ${join(sandbox, "repo")}) and fill in docs/QA-${today}-sweep.md.
`);
if (server) console.log("Ctrl+C stops the server.");
