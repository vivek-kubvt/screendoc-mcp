/**
 * doc_status — read-only "where are we" report.
 *
 * Runs the workspace guard (so the branch situation is always visible), loads
 * state if present, and prints project info, coverage, the current run, blocked
 * screens, and the last generated document. Safe to call anytime.
 */
import { z } from "zod";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState, stateExists } from "../state/store.js";
import { computeCoverage } from "../util/coverage.js";
import { text, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const docStatusSchema = {
  projectRoot: z
    .string()
    .optional()
    .describe("Absolute path to the project to inspect. Defaults to the server's cwd."),
  docsBranch: z
    .string()
    .optional()
    .describe("Override the documentation branch name (default docs/mcp-documentation)."),
};

export async function docStatus(args: {
  projectRoot?: string;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });

  const lines: string[] = [];
  lines.push(`# doc-mcp status`);
  lines.push(`Project root: ${projectRoot}`);

  // Workspace / branch situation.
  if (guard.mode === "folder") {
    lines.push(`Workspace: folder mode (no git) — .docmcp/ is the workspace.`);
  } else if (!guard.ok) {
    lines.push(`Workspace: ⚠️ BLOCKED (${guard.reason})`);
    lines.push("");
    lines.push(guard.escalation);
    return text(lines.join("\n"));
  } else if (guard.needsBranchCreation) {
    lines.push(
      `Workspace: git repo, on \`${guard.branch}\` — documentation branch does not exist yet ` +
        `(will be created on first create_document run).`,
    );
  } else {
    lines.push(`Workspace: ✅ on documentation branch \`${guard.branch}\`.`);
  }

  if (!(await stateExists(projectRoot))) {
    lines.push("");
    lines.push("No documentation state yet. Run `create_document` to begin.");
    return text(lines.join("\n"));
  }

  const state = await loadState(projectRoot);
  if (!state) {
    lines.push("");
    lines.push("State file unreadable. Run `project_scan` to rebuild.");
    return text(lines.join("\n"));
  }

  lines.push("");
  lines.push(`## Project`);
  lines.push(`- Name: ${state.project.name}`);
  lines.push(`- Platform: ${state.project.platform}`);
  lines.push(
    `- Frameworks: ${state.project.frameworks.length ? state.project.frameworks.join(", ") : "—"}`,
  );
  lines.push(
    `- Capture engines: ${state.project.captureEngines.length ? state.project.captureEngines.join(", ") : "—"}`,
  );

  const cov = computeCoverage(state.screenGraph);
  lines.push("");
  lines.push(`## Coverage`);
  lines.push(`- Screens: ${state.screenGraph.nodes.length}`);
  lines.push(`- States captured: ${cov.capturedStates}/${cov.totalStates} (${cov.percent}%)`);
  if (cov.uncaptured.length) {
    lines.push(`- Remaining:`);
    for (const u of cov.uncaptured.slice(0, 12)) {
      lines.push(`    • ${u.node}: ${u.states.join(", ")}`);
    }
    if (cov.uncaptured.length > 12) lines.push(`    • …and ${cov.uncaptured.length - 12} more`);
  }
  if (cov.blocked.length) {
    lines.push(`- ⚠️ Blocked screens:`);
    for (const b of cov.blocked) lines.push(`    • ${b.node}: ${b.reason}`);
  }

  lines.push("");
  lines.push(`## Run`);
  lines.push(`- Status: ${state.run.status}`);
  if (state.run.currentNode) lines.push(`- Current screen: ${state.run.currentNode}`);
  if (state.run.queue.length) lines.push(`- Queued: ${state.run.queue.length} screens`);

  lines.push("");
  lines.push(`## Documents`);
  if (state.documents.length === 0) {
    lines.push(`- None generated yet.`);
  } else {
    const last = state.documents[state.documents.length - 1];
    lines.push(`- Latest: v${last.version} (${last.kind}) — ${last.date} — ${last.file}`);
    lines.push(`- Total generated: ${state.documents.length}`);
  }
  lines.push(
    `- Baseline commit: ${state.baseline.lastDocumentedCommit ?? "—"} (doc v${state.baseline.docVersion})`,
  );

  return text(lines.join("\n"));
}
