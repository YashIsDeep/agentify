#!/usr/bin/env node
// Builds a clean sandbox for a full sweep: a throwaway repository with one deliberate bug and one
// failing test, a bare local origin to push to, and an empty data directory so the server seeds the
// current Feature and Bugfix workflows. Refuses to touch a directory that already exists.
//
//   node .claude/skills/verify-agentify/scripts/new-sandbox.mjs [dir]     (default C:/code/wm-qa)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "C:/code/wm-qa");
if (existsSync(root)) {
  console.error(`${root} already exists. Remove it yourself, or pass another directory (and point WM_DATA_DIR in the launch config at its data folder).`);
  process.exit(1);
}

const repo = join(root, "repo");
const origin = join(root, "origin.git");
const files = {
  ".gitignore": "node_modules\n.env\n",
  "README.md": "# tiny-cart\nA tiny cart helper library. Run `npm test`.\n",
  "package.json": `${JSON.stringify({ name: "tiny-cart", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/cart.js": `/** Sum of price * qty for every line in the cart. */
export function subtotal(lines) {
  let total = 0;
  for (const line of lines) total += line.price * line.qty;
  return total;
}

/** Applies a percentage discount (0-100) to an amount. */
export function applyDiscount(amount, percent) {
  // BUG: treats percent as a fraction
  return amount - amount * percent;
}
`,
  "test/cart.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal, applyDiscount } from "../src/cart.js";

test("subtotal sums price * qty", () => {
  assert.equal(subtotal([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
});

test("applyDiscount takes a percentage", () => {
  assert.equal(applyDiscount(200, 10), 180);
});
`,
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

mkdirSync(join(root, "data"), { recursive: true });
for (const [name, content] of Object.entries(files)) {
  mkdirSync(dirname(join(repo, name)), { recursive: true });
  writeFileSync(join(repo, name), content);
}
git(repo, "init", "-b", "main");
// The identity lives in the sandbox only, so agents can commit without a global one.
git(repo, "config", "user.name", "QA Sandbox");
git(repo, "config", "user.email", "qa@example.invalid");
git(repo, "add", "-A");
git(repo, "commit", "-m", "Initial tiny-cart");
git(root, "init", "--bare", "-b", "main", origin);
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-u", "origin", "main");
// Gitignored, so it only reaches a worktree through Ensure worktree's "Carry over from the repository".
writeFileSync(join(repo, ".env"), "CART_CURRENCY=EUR\n");

console.log(`Sandbox ready in ${root}
  repo        ${repo}   (main; \`npm test\` fails on applyDiscount)
  origin      ${origin}   (plain bare remote: not GitHub, not GitLab)
  data        ${join(root, "data")}   (empty: the server seeds it on first start)`);
