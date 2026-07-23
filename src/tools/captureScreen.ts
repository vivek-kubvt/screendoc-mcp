/**
 * capture_screen — capture one named screen (all its states, or one state) via
 * the mobile engine, updating capture progress in state. Used for retakes and
 * spot fixes; create_document uses the same underlying path in a loop.
 */
import { z } from "zod";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState, saveState } from "../state/store.js";
import { buildContext } from "../capture/session.js";
import { MaestroEngine } from "../capture/maestroEngine.js";
import { hashFiles } from "../util/hash.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const captureScreenSchema = {
  screenId: z.string().describe('Screen id from the graph, e.g. "(auth)/sign-in".'),
  state: z.string().optional().describe('Single state to capture (default: all of the screen\'s states).'),
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  docsBranch: z.string().optional(),
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function captureScreen(args: {
  screenId: string;
  state?: string;
  projectRoot?: string;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# capture_screen blocked\n\n${guard.escalation}`);
  if (guard.mode === "git-branch" && guard.needsBranchCreation) {
    return errorText("Documentation branch not created yet. Run create_document first.");
  }

  const state = await loadState(projectRoot);
  if (!state) return errorText("No state. Run project_scan or create_document first.");
  const node = state.screenGraph.nodes.find((n) => n.id === args.screenId);
  if (!node) return errorText(`Screen "${args.screenId}" not found in the graph.`);

  const ctx = await buildContext(projectRoot, state);
  const engine = new MaestroEngine();
  const prep = await engine.prepare(ctx);
  if (!prep.ok) return errorText(`Capture engine not ready: ${prep.reason}`);

  const states = args.state ? [args.state] : node.states;
  const results: string[] = [];
  for (const st of states) {
    const label = `${node.id.replace(/\//g, "__")}__${st}`;
    const outcome = await engine.capture(ctx, node, st, label);
    if (outcome.ok) {
      node.captured[st] = nowIso();
      delete node.blocked;
      results.push(`✅ ${st} → ${path.relative(projectRoot, outcome.file!)}`);
    } else {
      if (st === "default") node.blocked = { reason: outcome.reason ?? "capture failed", at: nowIso() };
      results.push(`⚠️ ${st}: ${outcome.reason}`);
    }
  }
  node.contentHash = await hashFiles(node.sourceFiles);
  await engine.teardown(ctx);
  await saveState(projectRoot, state);

  return text(`# capture_screen — ${node.title}\nRoute: ${node.route ?? "—"}\n\n` + results.join("\n"));
}
