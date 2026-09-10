// Minimal stand-in for `codex exec --json`, driven by keywords in the prompt (FAIL, HANG).
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (prompt.includes("HANG")) {
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  process.exit(0);
}

const resume = args[1] === "resume";
const sessionId = resume ? args[args.length - 2] : "codex-thread-1";
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((key) => process.env[key]).join(",") || "none";

emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "git status", exit_code: null } });
emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status", exit_code: 0 } });

if (prompt.includes("FAIL")) {
  emit({ type: "turn.failed", error: { message: "model exploded" } });
  process.exit(1);
}

const access = args.includes("--dangerously-bypass-approvals-and-sandbox") ? "autonomous" : "read-only";
const text = `codex ${resume ? `resumed ${sessionId}` : "fresh"} | model:${flag("-m") ?? "default"} | access:${access} | keys:${keys} | prompt:${prompt}`;
emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
emit({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 80 } });
writeFileSync(flag("-o"), text);
