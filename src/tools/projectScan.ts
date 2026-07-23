/**
 * project_scan — detect the platform and build the screen graph, without
 * capturing anything. Read-only by default so you can review the plan before a
 * long capture run; pass persist:true to write it into state (only allowed on
 * the docs branch or in folder mode — never onto another branch).
 */
import { z } from "zod";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { detectPlatform } from "../scan/detectPlatform.js";
import { buildExpoRouterGraph } from "../scan/routeGraph.js";
import { scanScreenSource } from "../scan/overlayScan.js";
import { loadState, saveState, defaultState } from "../state/store.js";
import { computeCoverage } from "../util/coverage.js";
import { text, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DocState, ScreenGraph } from "../util/types.js";

export const projectScanSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  persist: z
    .boolean()
    .optional()
    .describe("Write the detected platform + screen graph into state.json (docs branch / folder only)."),
  docsBranch: z.string().optional().describe("Override the documentation branch name."),
};

/** Carry capture progress across a re-scan: keep captured/hash/blocked by node id. */
function mergeGraph(existing: ScreenGraph | undefined, fresh: ScreenGraph): ScreenGraph {
  if (!existing) return fresh;
  const prev = new Map(existing.nodes.map((n) => [n.id, n]));
  for (const node of fresh.nodes) {
    const old = prev.get(node.id);
    if (!old) continue;
    node.contentHash = old.contentHash;
    node.blocked = old.blocked;
    for (const state of node.states) {
      if (old.captured[state]) node.captured[state] = old.captured[state];
    }
  }
  return fresh;
}

export async function projectScan(args: {
  projectRoot?: string;
  persist?: boolean;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) {
    return text(`# project_scan blocked\n\n${guard.escalation}`);
  }

  const detection = await detectPlatform(projectRoot);
  const lines: string[] = [];
  lines.push(`# project_scan — ${path.basename(projectRoot)}`);
  lines.push("");
  lines.push(`## Platform`);
  lines.push(`- Type: **${detection.platform}**`);
  lines.push(`- Frameworks: ${detection.frameworks.join(", ") || "—"}`);
  lines.push(`- Entry points: ${detection.entryPoints.join(", ") || "—"}`);
  lines.push(`- Capture engines: ${detection.captureEngines.join(", ") || "—"}`);
  for (const e of detection.evidence) lines.push(`  - ${e}`);

  // Screen graph — expo-router only in this phase.
  let graph: ScreenGraph | null = null;
  const isExpoRouter = detection.frameworks.includes("expo-router");
  if (isExpoRouter && detection.entryPoints[0]) {
    const routerDir = path.join(projectRoot, detection.entryPoints[0]);
    graph = await buildExpoRouterGraph(routerDir, (file) => scanScreenSource(file));
  }

  if (!graph) {
    lines.push("");
    lines.push(
      `## Screen graph\nNo expo-router graph built (this phase supports expo-router; other ` +
        `routers land in a later phase).`,
    );
    return text(lines.join("\n"));
  }

  const cov = computeCoverage(graph);
  lines.push("");
  lines.push(`## Screen graph`);
  lines.push(`- Screens: **${graph.nodes.length}**`);
  lines.push(`- States to capture: **${cov.totalStates}**`);
  lines.push(`- Structural edges: ${graph.edges.length}`);

  const withOverlays = graph.nodes.filter((n) => n.overlays.length);
  lines.push(
    `- Screens with overlays (alert/modal/toast/sheet): ${withOverlays.length}`,
  );
  const authGated = graph.nodes.filter((n) => n.requires.includes("auth")).length;
  lines.push(`- Auth-gated screens: ${authGated}`);

  lines.push("");
  lines.push(`### Sample screens`);
  for (const n of graph.nodes.slice(0, 15)) {
    const extras = [
      ...n.overlays.map((o) => `+${o}`),
      ...n.states.filter((s) => s !== "default").map((s) => `:${s}`),
    ];
    lines.push(`- \`${n.route}\`  — ${n.title}${extras.length ? "  (" + extras.join(" ") + ")" : ""}`);
  }
  if (graph.nodes.length > 15) lines.push(`- …and ${graph.nodes.length - 15} more`);

  // Persist only when explicitly requested and safe.
  if (args.persist) {
    if (guard.mode === "git-branch" && guard.needsBranchCreation) {
      lines.push("");
      lines.push(
        `> Not persisted: the documentation branch does not exist yet. Run \`create_document\` ` +
          `to create it (with your consent), which will save this graph.`,
      );
    } else {
      const existing = await loadState(projectRoot);
      const state: DocState = existing ?? defaultState(path.basename(projectRoot), detection.platform);
      state.project = {
        name: state.project.name || path.basename(projectRoot),
        platform: detection.platform,
        frameworks: detection.frameworks,
        entryPoints: detection.entryPoints,
        captureEngines: detection.captureEngines,
      };
      state.workspace = {
        mode: guard.mode,
        branch: guard.mode === "git-branch" ? guard.branch : null,
      };
      state.screenGraph = mergeGraph(existing?.screenGraph, graph);
      await saveState(projectRoot, state);
      lines.push("");
      lines.push(`> Persisted platform + ${graph.nodes.length} screens to .docmcp/state.json.`);
    }
  } else {
    lines.push("");
    lines.push(`_Preview only. Re-run with persist:true to save this into state._`);
  }

  return text(lines.join("\n"));
}
