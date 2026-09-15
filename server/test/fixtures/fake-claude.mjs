// Minimal stand-in for `claude -p --output-format stream-json`.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }, null, 2));
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const resumed = flag("--resume");
const sessionId = resumed ?? "claude-session-1";
const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((key) => process.env[key]).join(",") || "none";
const access = args.includes("--dangerously-skip-permissions") ? "autonomous" : "read-only";
const text = `claude ${resumed ? `resumed ${sessionId}` : "fresh"} | model:${flag("--model") ?? "default"} | access:${access} | keys:${keys} | effort:${flag("--effort") ?? "default"} | prompt:${prompt}`;

emit({ type: "system", subtype: "init", session_id: sessionId });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: sessionId,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
});
