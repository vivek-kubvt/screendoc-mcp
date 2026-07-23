/**
 * create_document — the full documentation pipeline:
 *   guard → (create docs branch on consent) → scan/persist → prepare engine →
 *   capture loop (checkpointed) → coverage gate → build PDF.
 *
 * Resumable: capture progress is saved after every screen, so an interrupted
 * run continues where it stopped. Honest: gaps are reported, never hidden, and
 * the PDF is withheld unless coverage is complete or gaps are explicitly allowed.
 */
import { z } from "zod";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import {
  isGitRepo,
  currentBranch,
  headShort,
  createAndCheckoutBranch,
} from "../util/git.js";
import { loadState, saveState, defaultState, stateExists } from "../state/store.js";
import { detectPlatform } from "../scan/detectPlatform.js";
import { buildExpoRouterGraph } from "../scan/routeGraph.js";
import { scanScreenSource } from "../scan/overlayScan.js";
import { buildContext } from "../capture/session.js";
import { MaestroEngine } from "../capture/maestroEngine.js";
import { buildDocumentHtml } from "../output/html.js";
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
import { DEFAULT_DOCS_BRANCH, DocState } from "../util/types.js";

export const createDocumentSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  confirmBranchCreation: z
    .boolean()
    .optional()
    .describe("Consent to create the documentation branch on first run."),
  only: z.array(z.string()).optional().describe("Restrict capture to these screen ids."),
  limit: z.number().optional().describe("Cap how many screens to capture this run (for incremental runs)."),
  allowGaps: z
    .boolean()
    .optional()
    .describe("Build the PDF even if some screens/states are uncaptured (default true; gaps are always reported)."),
  allowDeepLinks: z
    .boolean()
    .optional()
    .describe("Opt into the legacy deep-link fallback for screens with no flow/recipe. Default false (Maestro-flow-first)."),
  keepCaptures: z
    .boolean()
    .optional()
    .describe("Keep the raw screenshot files after the PDF is built. Default false: captures are baked into the PDF, so they're deleted to free space (flows, recipes & plans are always kept)."),
  docsBranch: z.string().optional(),
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureState(projectRoot: string): Promise<DocState> {
  if (await stateExists(projectRoot)) {
    const s = await loadState(projectRoot);
    if (s && s.screenGraph.nodes.length) return s;
  }
  // Fresh scan.
  const detection = await detectPlatform(projectRoot);
  const state = defaultState(path.basename(projectRoot), detection.platform);
  state.project = {
    name: path.basename(projectRoot),
    platform: detection.platform,
    frameworks: detection.frameworks,
    entryPoints: detection.entryPoints,
    captureEngines: detection.captureEngines,
  };
  if (detection.frameworks.includes("expo-router") && detection.entryPoints[0]) {
    const routerDir = path.join(projectRoot, detection.entryPoints[0]);
    state.screenGraph = await buildExpoRouterGraph(routerDir, (f) => scanScreenSource(f));
  }
  return state;
}

export async function createDocument(
  args: {
    projectRoot?: string;
    confirmBranchCreation?: boolean;
    only?: string[];
    limit?: number;
    allowGaps?: boolean;
    allowDeepLinks?: boolean;
    keepCaptures?: boolean;
    docsBranch?: string;
  },
  extra?: ToolExtra,
): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const docsBranch = args.docsBranch ?? DEFAULT_DOCS_BRANCH;
  const allowGaps = args.allowGaps ?? true;
  const progress = makeProgress(extra, "create_document");

  const guard = await guardWorkspace({ projectRoot, docsBranch });
  if (!guard.ok) return text(`# create_document blocked\n\n${guard.escalation}`);

  // First-run branch creation — only with explicit consent.
  if (guard.mode === "git-branch" && guard.needsBranchCreation) {
    if (!args.confirmBranchCreation) {
      const cur = await currentBranch(projectRoot);
      return text(
        `# create_document — consent needed\n\n` +
          `This is the first documentation run. doc-mcp wants to create its branch ` +
          `\`${docsBranch}\` from \`${cur}\` and do all work there.\n\n` +
          `Re-run with \`confirmBranchCreation: true\` to proceed. doc-mcp will only ever ` +
          `commit to \`${docsBranch}\`.`,
      );
    }
    const base = (await currentBranch(projectRoot)) ?? "HEAD";
    const err = await createAndCheckoutBranch(projectRoot, docsBranch, base);
    if (err) return errorText(`Could not create ${docsBranch}: ${err}`);
  }

  const isGit = await isGitRepo(projectRoot);
  const state = await ensureState(projectRoot);
  state.workspace = {
    mode: isGit ? "git-branch" : "folder",
    branch: isGit ? docsBranch : null,
  };

  if (state.screenGraph.nodes.length === 0) {
    return errorText(
      "No screens detected. This phase supports expo-router; other routers arrive in a later phase.",
    );
  }

  // Select screens to capture.
  let targets = state.screenGraph.nodes;
  if (args.only?.length) targets = targets.filter((n) => args.only!.includes(n.id));
  if (args.limit) targets = targets.slice(0, args.limit);

  // Prepare the capture engine.
  const ctx = await buildContext(projectRoot, state, { allowDeepLinks: args.allowDeepLinks });
  // The scheme/appId that were actually resolved from the native project — the
  // single most useful line for diagnosing "everything failed" (wrong scheme).
  const deviceLine =
    `Device: ${ctx.platform ?? "unknown"} · deep-link ${ctx.scheme ? `${ctx.scheme}://` : "— (tap-nav only)"} · appId ${ctx.appId}` +
    (ctx.identityEvidence?.length ? `\n> ${ctx.identityEvidence.join("\n> ")}` : "");
  const engine = new MaestroEngine();
  state.run = { status: "capturing", currentNode: null, queue: targets.map((n) => n.id), startedAt: new Date().toISOString() };
  await saveState(projectRoot, state);

  // total steps = one per screen + PDF build + finalize; used for the progress bar.
  const totalSteps = targets.length + 2;
  progress(0, totalSteps, `Preparing capture engine (${targets.length} screens)…`);

  const prep = await engine.prepare(ctx);
  if (!prep.ok) {
    state.run.status = "idle";
    await saveState(projectRoot, state);
    return errorText(`Capture engine not ready: ${prep.reason}`);
  }

  // Note auth-gated screens with no session — captured anyway, but flagged.
  const authNote =
    !ctx.secrets["auth"] && targets.some((n) => n.requires.includes("auth"))
      ? `\n> Note: no auth session configured, so auth-gated screens may show the login redirect. ` +
        `Record an auth recipe at .docmcp/skills/auth-flow.yaml and set credentials to capture them.`
      : "";

  // Capture loop — checkpoint after each screen.
  const log: string[] = [];
  let done = 0;
  for (const node of targets) {
    state.run.currentNode = node.id;
    progress(done, totalSteps, `Capturing ${node.title} (${done + 1}/${targets.length})…`);
    let anyOk = false;
    for (const st of node.states) {
      if (node.captured[st]) {
        anyOk = true;
        continue; // resume: skip already-captured
      }
      const label = `${node.id.replace(/\//g, "__")}__${st}`;
      const outcome = await engine.capture(ctx, node, st, label);
      if (outcome.ok) {
        node.captured[st] = nowIso();
        anyOk = true;
      } else if (st === "default") {
        node.blocked = { reason: outcome.reason ?? "capture failed", at: nowIso() };
      }
    }
    node.contentHash = await hashFiles(node.sourceFiles);
    if (!anyOk && node.blocked) log.push(`⚠️ ${node.title}: ${node.blocked.reason}`);
    state.run.queue = state.run.queue.filter((id) => id !== node.id);
    await saveState(projectRoot, state);
    done++;
    progress(done, totalSteps, `Captured ${node.title} (${done}/${targets.length})`);
  }
  await engine.teardown(ctx);

  // Coverage gate.
  const cov = computeCoverage(state.screenGraph);
  const complete = cov.uncaptured.length === 0;
  if (!complete && !allowGaps) {
    state.run.status = "idle";
    await saveState(projectRoot, state);
    return text(
      `# create_document — coverage gate\n\n${deviceLine}\n\nCoverage ${cov.percent}% ` +
        `(${cov.capturedStates}/${cov.totalStates}). ${cov.uncaptured.length} screens have ` +
        `uncaptured states. Capture is Maestro-flow-first: run \`plan_capture\` → \`run_flow\` → ` +
        `\`reconcile_capture\` to fill them (or add PNGs manually), then re-run. ` +
        `Or re-run with allowGaps:true to build with gaps shown.`,
    );
  }

  // Build the PDF.
  const commit = await headShort(projectRoot);
  const version = state.baseline.docVersion + 1;
  const date = nowIso();
  const fmt = await resolveFormat(projectRoot);
  const accentNote = await applyDetectedAccent(projectRoot, fmt);
  const annotations = await loadAnnotations(projectRoot, state.screenGraph.nodes.map((n) => n.id));
  const buildOpts = {
    capturesDir: ctx.capturesDir,
    kind: "create" as const,
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
  progress(targets.length + 1, totalSteps, `Building PDF v${version}…`);
  const pdf = await htmlToPdf(html, outPdf);
  if (!pdf.ok) {
    state.run.status = "idle";
    await saveState(projectRoot, state);
    return errorText(`Captured OK but PDF build failed: ${pdf.reason}`);
  }

  // Reclaim disk: screenshots are baked into the PDF, so the raw captures are
  // scratch now. Kept only when keepCaptures:true. Flows/recipes/plans survive.
  const cleanupNote =
    args.keepCaptures ? null : cleanupLine(await cleanupCaptures(ctx.capturesDir));
  progress(totalSteps, totalSteps, `Done — PDF v${version} ready`);

  // Record the document + advance baseline.
  state.baseline = { lastDocumentedCommit: commit, lastRunDate: date, docVersion: version };
  state.documents.push({
    file: path.relative(projectRoot, outPdf),
    version,
    date,
    commit,
    kind: "create",
    screensChanged: [],
  });
  state.run = { status: "done", currentNode: null, queue: [], startedAt: null };
  await saveState(projectRoot, state);

  const gapLine = complete
    ? "Full coverage."
    : `⚠️ ${cov.uncaptured.length} screens partially/uncaptured (${cov.percent}% coverage) — run \`reconcile_capture\` for the missing list + how to fix each.`;
  const formatLine =
    `Format: ${fmt.format.label} (${fmt.source === "config" ? "from .docmcp/format.json" : "default"})` +
    (accentNote ? `\n${accentNote}` : "") +
    (fmt.warnings.length ? `\n> ${fmt.warnings.join("\n> ")}` : "");
  return text(
    `# create_document — done\n\n` +
      `Project: ${state.project.name} (${state.project.platform})\n` +
      `${deviceLine}\n` +
      `${formatLine}\n` +
      `Screens targeted: ${targets.length} / ${state.screenGraph.nodes.length}\n` +
      `Coverage: ${cov.capturedStates}/${cov.totalStates} states (${cov.percent}%)\n` +
      `${gapLine}\n\n` +
      `📄 PDF: ${path.relative(projectRoot, outPdf)} (v${version})${authNote}` +
      (cleanupNote ? `\n${cleanupNote}` : "") +
      (log.length ? `\n\nIssues:\n${log.slice(0, 15).join("\n")}` : ""),
  );
}
