// Boot the real MCP server over stdio and exercise it through the SDK client.
//
// Usage: node scripts/mcp-smoke.mjs [projectRoot]
// Defaults to this repo as the target project.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = process.argv[2] ?? repoRoot;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: repoRoot,
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

const res = await client.callTool({
  name: "doc_status",
  arguments: { projectRoot },
});
console.log(`\ndoc_status(${projectRoot}) via MCP:\n` + res.content[0].text);

await client.close();
