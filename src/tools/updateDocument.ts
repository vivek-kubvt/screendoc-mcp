/**
 * update_document — incremental refresh.
 *   guard → diff since baseline → map changed files to screens → recapture only
 *   those → rebuild PDF with UPDATED badges + a changelog entry → advance baseline.
 *
 * Only affected screens are re-captured; everything else keeps its prior
 * screenshots and original capture date, so page freshness stays visible.
 */
import { z } from "zod";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { headShort, changedFilesSince, commitsSince } from "../util/git.js";
import { loadState, saveState } from "../state/store.js";
import { buildContext } from "../capture/session.js";
import { MaestroEngine } from "../capture/maestroEngine.js";
import { buildDocumentHtml, ChangelogEntry } from "../output/html.js";
import { buildVisualFlowHtml } from "../output/visualFlow.js";
import { resolveFormat } from "../output/formats.js";
import { applyDetectedAccent } from "../output/applyAccent.js";
import { loadAnnotations } from "../output/annotations.js";
import { htmlToPdf } from "../output/pdf.js";
import { computeCoverage } from "../util/coverage.js";
import { hashFiles } from "../util/hash.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { makeProgress, ToolExtra } from "../util/progress.js";
import { cleanupCaptures, cleanupLine } from "../output/cleanup.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_DOCS_BRANCH, DocState, ScreenNode } from "../util/types.js";

export const updateDocumentSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  since: z.string().optional().describe("Override the baseline commit to diff from."),
  allowGaps: z.boolean().optional(),
  keepCaptures: z
    .boolean()
    .optional()
    .describe("Keep the raw screenshot files after the PDF is built. Default false: captures are baked into the PDF, so they're deleted to free space (flows, recipes & plans are always kept)."),
  docsBranch: z.string().optional(),
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Which screens are affected by the changed files (direct source match + fan-out). */
function affectedScreens(state: DocState, projectRoot: string, changed: string[]): ScreenNode[] {
  const changedAbs = new Set(changed.map((c) => path.resolve(projectRoot, c)));
  const changedBases = new Set(changed.map((c) => path.basename(c)));
  const hits: ScreenNode[] = [];
  for (const node of state.screenGraph.nodes) {
    const direct = node.sourceFiles.some((f) => changedAbs.has(path.resolve(f)));
    // Shared-component fan-out heuristic: a changed non-route file whose basename
    // is imported near this screen's directory. Conservative: same directory tree.
    const nearby = node.sourceFiles.some((f) => {
      const dir = path.dirname(f);
      return [...changedBases].some((b) => changed.some((c) => path.resolve(projectRoot, c).startsWith(dir) && path.basename(c) === b));
    });
    if (direct || nearby) hits.push(node);
  }
  return hits;
}

export async function updateDocument(
  args: {
    projectRoot?: string;
    since?: string;
    allowGaps?: boolean;
    keepCaptures?: boolean;
    docsBranch?: string;
  },
  extra?: ToolExtra,
): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const docsBranch = args.docsBranch ?? DEFAULT_DOCS_BRANCH;
  const allowGaps = args.allowGaps ?? true;
  const progress = makeProgress(extra, "update_document");

  const guard = await guardWorkspace({ projectRoot, docsBranch });
  if (!guard.ok) return text(`# update_document blocked\n\n${guard.escalation}`);
  if (guard.mode === "git-branch" && guard.needsBranchCreation) {
    return errorText("No documentation branch yet. Run create_document first.");
  }

  const state = await loadState(projectRoot);
  if (!state) return errorText("No state. Run create_document first.");

  const baseline = args.since ?? state.baseline.lastDocumentedCommit;
  if (!baseline) {
    return errorText("No baseline commit recorded. Run create_document to establish one.");
  }

  const changed = await changedFilesSince(projectRoot, baseline);
  if (changed.length === 0) {
    return text(`# update_document — nothing to do\n\nNo files changed since \`${baseline}\`. Docs are current.`);
  }

  const affected = affectedScreens(state, projectRoot, changed);
  const commits = await commitsSince(projectRoot, baseline);

  if (affected.length === 0) {
    return text(
      `# update_document — no screens affected\n\n${changed.length} files changed since \`${baseline}\`, ` +
        `but none map to a documented screen. (Change mapping is by source file + directory fan-out.)\n\n` +
        `Changed files:\n${changed.slice(0, 20).map((c) => `- ${c}`).join("\n")}`,
    );
  }

  // Recapture affected screens (reset their capture dates first).
  const ctx = await buildContext(projectRoot, state);
  const engine = new MaestroEngine();
  const totalSteps = affected.length + 2;
  progress(0, totalSteps, `Preparing capture engine (${affected.length} changed screens)…`);
  const prep = await engine.prepare(ctx);
  if (!prep.ok) return errorText(`Capture engine not ready: ${prep.reason}`);

  state.run = { status: "capturing", currentNode: null, queue: affected.map((n) => n.id), startedAt: new Date().toISOString() };
  await saveState(projectRoot, state);

  const updatedIds = new Set<string>();
  let done = 0;
  for (const node of affected) {
    state.run.currentNode = node.id;
    progress(done, totalSteps, `Recapturing ${node.title} (${done + 1}/${affected.length})…`);
    delete node.blocked;
    for (const st of node.states) {
      const label = `${node.id.replace(/\//g, "__")}__${st}`;
      const outcome = await engine.capture(ctx, node, st, label);
      if (outcome.ok) node.captured[st] = nowIso();
      else if (st === "default") node.blocked = { reason: outcome.reason ?? "capture failed", at: nowIso() };
    }
    node.contentHash = await hashFiles(node.sourceFiles);
    updatedIds.add(node.id);
    state.run.queue = state.run.queue.filter((id) => id !== node.id);
    await saveState(projectRoot, state);
    done++;
    progress(done, totalSteps, `Recaptured ${node.title} (${done}/${affected.length})`);
  }
  await engine.teardown(ctx);

  const cov = computeCoverage(state.screenGraph);
  if (cov.uncaptured.length > 0 && !allowGaps) {
    state.run.status = "idle";
    await saveState(projectRoot, state);
    return text(`# update_document — coverage gate\n\nGaps remain (${cov.percent}%). Re-run with allowGaps:true or capture them.`);
  }

  // Build the updated PDF with badges + changelog.
  const commit = await headShort(projectRoot);
  const version = state.baseline.docVersion + 1;
  const date = nowIso();
  const changelog: ChangelogEntry[] = [
    {
      date,
      commit,
      screens: affected.map((n) => n.title),
      notes: commits.slice(0, 12),
    },
    ...state.documents
      .filter((d) => d.kind === "update")
      .map((d) => ({ date: d.date, commit: d.commit, screens: d.screensChanged, notes: [] as string[] })),
  ];

  const fmt = await resolveFormat(projectRoot);
  const accentNote = await applyDetectedAccent(projectRoot, fmt);
  const annotations = await loadAnnotations(projectRoot, state.screenGraph.nodes.map((n) => n.id));
  const buildOpts = {
    capturesDir: ctx.capturesDir,
    updatedScreens: updatedIds,
    changelog,
    kind: "update" as const,
    version,
    commit,
    date,
    format: fmt.format,
    projectRoot,
    annotations,
  };
  const html =
    fmt.format.template === "visual-flow"
      ? await buildVisualFlowHtml(state, buildOpts)
      : await buildDocumentHtml(state, buildOpts);
  const outName = `${state.project.name}-docs-v${version}-${date}-${commit ?? "nogit"}.pdf`;
  const outPdf = path.join(projectRoot, ".docmcp", "output", outName);
  progress(affected.length + 1, totalSteps, `Building PDF v${version}…`);
  const pdf = await htmlToPdf(html, outPdf);
  if (!pdf.ok) return errorText(`Recaptured OK but PDF build failed: ${pdf.reason}`);

  const cleanupNote =
    args.keepCaptures ? null : cleanupLine(await cleanupCaptures(ctx.capturesDir));
  progress(totalSteps, totalSteps, `Done — PDF v${version} ready`);

  state.baseline = { lastDocumentedCommit: commit, lastRunDate: date, docVersion: version };
  state.documents.push({
    file: path.relative(projectRoot, outPdf),
    version,
    date,
    commit,
    kind: "update",
    screensChanged: affected.map((n) => n.title),
  });
  state.run = { status: "done", currentNode: null, queue: [], startedAt: null };
  await saveState(projectRoot, state);

  const formatLine =
    `Format: ${fmt.format.label} (${fmt.source === "config" ? "from .docmcp/format.json" : "default"})` +
    (accentNote ? `\n${accentNote}` : "") +
    (fmt.warnings.length ? `\n> ${fmt.warnings.join("\n> ")}` : "");
  return text(
    `# update_document — done\n\n` +
      `Diffed from \`${baseline}\` → \`${commit}\` (${changed.length} files, ${commits.length} commits)\n` +
      `${formatLine}\n` +
      `Screens updated: ${affected.length}\n` +
      affected.map((n) => `  • ${n.title}`).join("\n") +
      `\n\n📄 PDF: ${path.relative(projectRoot, outPdf)} (v${version}) — updated pages badged, changelog added.` +
      (cleanupNote ? `\n${cleanupNote}` : ""),
  );
}
