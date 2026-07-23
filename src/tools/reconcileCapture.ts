/**
 * reconcile_capture — the "no snapshot missing before we build the PDF" check.
 *
 * Diffs every expected (screen, state) against the PNGs on disk. It ADOPTS any
 * screenshot that now exists but wasn't recorded (e.g. one you dropped in by
 * hand), and for everything still missing it prints the two ways forward:
 *   • add manually — the exact PNG path to drop a file at, or
 *   • retry — the chunk flow to edit + re-run (run_flow).
 *
 * Non-default states that were never requested by a recipe/flow are listed
 * separately as optional, so they don't read as failures.
 */
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState, saveState } from "../state/store.js";
import {
  chunkScreens,
  screenshotPath,
  chunkFlowFile,
} from "../capture/flowPlan.js";
import { computeCoverage } from "../util/coverage.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const reconcileCaptureSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  docsBranch: z.string().optional(),
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function reconcileCapture(args: {
  projectRoot?: string;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# reconcile_capture blocked\n\n${guard.escalation}`);

  const state = await loadState(projectRoot);
  if (!state || state.screenGraph.nodes.length === 0) {
    return errorText("No screen graph. Run project_scan (or create_document) first.");
  }

  const capturesDir = path.join(projectRoot, ".docmcp", "captures");
  // Map each screen id → its chunk id, so we can tell the user which flow to re-run.
  const chunkOf = new Map<string, string>();
  for (const chunk of chunkScreens(state)) {
    for (const n of chunk.nodes) chunkOf.set(n.id, chunk.id);
  }

  let adopted = 0;
  const missingDefault: { id: string; title: string; chunk: string; pngPath: string }[] = [];
  const missingOptional: string[] = [];

  for (const node of state.screenGraph.nodes) {
    for (const st of node.states) {
      const png = screenshotPath(capturesDir, node.id, st);
      const exists = await fileExists(png);
      if (exists) {
        if (!node.captured[st]) {
          node.captured[st] = nowIso();
          adopted++;
        }
        continue;
      }
      // Missing on disk → make sure state reflects that, then classify.
      if (node.captured[st]) node.captured[st] = null;
      if (st === "default") {
        missingDefault.push({
          id: node.id,
          title: node.title,
          chunk: chunkOf.get(node.id) ?? "root",
          pngPath: png,
        });
      } else {
        missingOptional.push(`${node.id} (${st})`);
      }
    }
  }

  await saveState(projectRoot, state);

  const cov = computeCoverage(state.screenGraph);
  const head = `# reconcile_capture\n\nCoverage: ${cov.capturedStates}/${cov.totalStates} states (${cov.percent}%)` +
    (adopted ? ` · adopted ${adopted} manually-added screenshot${adopted === 1 ? "" : "s"}` : "");

  if (missingDefault.length === 0) {
    return text(
      `${head}\n\n✅ Every screen has its primary screenshot.` +
        (missingOptional.length
          ? `\n\nOptional (non-default) states not captured (fine to skip):\n${missingOptional.slice(0, 30).map((m) => `  • ${m}`).join("\n")}`
          : "") +
        `\n\nReady: \`create_document format:visual-flow\`.`,
    );
  }

  // Group missing by chunk so the retry guidance is actionable.
  const byChunk = new Map<string, typeof missingDefault>();
  for (const m of missingDefault) (byChunk.get(m.chunk) ?? byChunk.set(m.chunk, []).get(m.chunk)!).push(m);

  const blocks: string[] = [];
  for (const [chunk, items] of byChunk) {
    const flow = path.relative(projectRoot, chunkFlowFile(projectRoot, chunk));
    blocks.push(
      `## ${chunk} — ${items.length} missing\n` +
        `Retry: edit \`${flow}\` (fill the TODO taps for these), then \`run_flow chunk:"${chunk}"\`.\n` +
        items
          .map((m) => `  • ${m.title}\n      add manually → ${m.pngPath}`)
          .join("\n"),
    );
  }

  return text(
    `${head}\n\n⚠️ ${missingDefault.length} screen(s) have no screenshot. For each, either **retry** ` +
      `(fix the chunk flow and re-run) or **add manually** (drop a PNG at the path shown):\n\n` +
      blocks.join("\n\n") +
      (missingOptional.length
        ? `\n\nOptional states also missing (skippable): ${missingOptional.length}`
        : "") +
      `\n\nRe-run \`reconcile_capture\` after fixing to confirm before building the PDF.`,
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
