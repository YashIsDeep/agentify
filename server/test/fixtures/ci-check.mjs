import { appendFileSync, existsSync } from "node:fs";
// Represents local validation plus a remote check of the last published revision.
if (process.argv.includes("publish")) {
  appendFileSync("ci-publishes", "publish\n");
} else {
  appendFileSync("ci-checks", "check\n");
  const passed = existsSync("ci-fixed") && existsSync("ci-publishes");
  console.log(passed ? "Local and remote checks passed" : "Local or remote checks failed");
  process.exitCode = passed ? 0 : 1;
}
