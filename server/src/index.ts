import { serve } from "@hono/node-server";
import { bootstrapWorkspaces } from "./workspaces";
import { loadConfig } from "./config";

const config = loadConfig(process.env, { dev: process.argv.includes("--dev") });
const ctx = bootstrapWorkspaces(config);
ctx.start();

const server = serve({ fetch: ctx.app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Agentify listening on http://${config.host}:${info.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await ctx.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
