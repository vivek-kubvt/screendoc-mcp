/**
 * run_flow — run one (or every) chunk's Maestro flow to capture its screens in a
 * single UI walk, then record which screenshots landed. This is "apply one by
 * one": run a chunk, see what it produced, fix the flow, re-run.
 *
 * A missing chunk flow is generated on the fly (so run_flow works without a prior
 * plan_capture), but an existing, hand-edited flow is always preferred.
 */
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState, saveState } from "../state/store.js";
import { buildContext } from "../capture/session.js";
import { MaestroEngine } from "../capture/maestroEngine.js";
import {
  chunkScreens,
  chunkExpected,
  chunkFlowFile,
  generateChunkFlow,
  flowsDirFor,
  capturesDirFor,
  screenshotPath,
  Chunk,
} from "../capture/flowPlan.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { makeProgress, ToolExtra } from "../util/progress.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const runFlowSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  chunk: z.string().optional().describe('Chunk id to run (e.g. "auth", "tab-feed"). Omit or "all" to run every chunk.'),
  docsBranch: z.string().optional(),
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runFlow(
  args: {
    projectRoot?: string;
    chunk?: string;
    docsBranch?: string;
  },
  extra?: ToolExtra,
): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const progress = makeProgress(extra, "run_flow");
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# run_flow blocked\n\n${guard.escalation}`);

  const state = await loadState(projectRoot);
  if (!state || state.screenGraph.nodes.length === 0) {
    return errorText("No screen graph. Run project_scan (or create_document) first.");
  }

  const all = chunkScreens(state);
  const wanted = !args.chunk || args.chunk === "all" ? all : all.filter((c) => c.id === args.chunk);
  if (wanted.length === 0) {
    return errorText(`Unknown chunk "${args.chunk}". Available: ${all.map((c) => c.id).join(", ")}`);
  }

  const ctx = await buildContext(projectRoot, state);
  const engine = new MaestroEngine();
  const prep = await engine.prepare(ctx);
  if (!prep.ok) return errorText(`Capture engine not ready: ${prep.reason}`);

  const capturesDir = capturesDirFor(projectRoot);
  await fs.mkdir(flowsDirFor(projectRoot), { recursive: true });

  const report: string[] = [];
  let totalCaptured = 0;
  let totalMissing = 0;
  let chunkIdx = 0;

  for (const chunk of wanted) {
    progress(chunkIdx, wanted.length, `Running ${chunk.title} flow (${chunkIdx + 1}/${wanted.length})…`);
    const file = chunkFlowFile(projectRoot, chunk.id);
    if (!(await fileExists(file))) {
      await fs.writeFile(file, generateChunkFlow(chunk, ctx.appId, capturesDir), "utf8");
    }

    const runRes = await engine.runFlowFile(ctx, file);
    const { captured, missing } = await reconcileChunk(chunk, capturesDir, state);
    totalCaptured += captured.length;
    totalMissing += missing.length;

    const status = runRes.ok ? "flow ok" : `flow error (${runRes.reason})`;
    report.push(
      `## ${chunk.id} — ${chunk.title} (${status})\n` +
        `Captured ${captured.length}/${chunk.nodes.length * 1} · missing ${missing.length}\n` +
        (missing.length
          ? `Missing:\n${missing.map((m) => `  • ${m}`).join("\n")}`
          : `All screens in this chunk captured.`),
    );
    chunkIdx++;
    progress(chunkIdx, wanted.length, `${chunk.title}: ${captured.length} captured, ${missing.length} missing`);
  }

  await saveState(projectRoot, state);

  return text(
    `# run_flow — ${totalCaptured} captured, ${totalMissing} missing\n\n` +
      report.join("\n\n") +
      `\n\nNext: fix any missing screens (edit the chunk flow's \`# TODO\` taps and re-run, ` +
      `or drop a PNG manually — see \`reconcile_capture\`), then \`create_document format:visual-flow\`.`,
  );
}

/** After a chunk runs, mark captured every expected shot that now exists on disk. */
async function reconcileChunk(
  chunk: Chunk,
  capturesDir: string,
  state: import("../util/types.js").DocState,
): Promise<{ captured: string[]; missing: string[] }> {
  const captured: string[] = [];
  const missing: string[] = [];
  const byId = new Map(state.screenGraph.nodes.map((n) => [n.id, n]));
  for (const exp of chunkExpected(chunk)) {
    const exists = await fileExists(screenshotPath(capturesDir, exp.nodeId, exp.state));
    const node = byId.get(exp.nodeId);
    if (exists) {
      if (node) node.captured[exp.state] = nowIso();
      captured.push(`${exp.nodeId} (${exp.state})`);
    } else if (exp.state === "default") {
      // Only the default state counts as "missing" for the walk; other states are optional/recipe.
      missing.push(`${exp.nodeId} (${exp.state})`);
    }
  }
  return { captured, missing };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
