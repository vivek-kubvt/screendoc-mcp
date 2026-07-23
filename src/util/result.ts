/**
 * Helpers for building MCP tool results. Tools return human-readable text
 * (rendered in the client) — these keep that consistent and terse.
 */
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function errorText(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/** Resolve the project root a tool should operate on. */
export function resolveProjectRoot(arg?: string): string {
  return arg && arg.trim().length > 0 ? arg : process.cwd();
}
