/**
 * plan_capture — chunk the screen graph and write one editable Maestro flow file
 * per chunk (auth · one per tab · root modals). This is the Maestro-flow-first
 * alternative to deep-linking: the flows walk the UI and screenshot each screen.
 *
 * The generated flows are scaffolds — launch + auth + a labelled block per screen
 * with best-effort tab navigation and `# TODO` markers where you fill the taps.
 * Edit them, then run each with run_flow, then reconcile_capture.
 */
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState } from "../state/store.js";
import {
  chunkScreens,
  generateChunkFlow,
  chunkFlowFile,
  flowsDirFor,
  capturesDirFor,
} from "../capture/flowPlan.js";
import { buildContext } from "../capture/session.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const planCaptureSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  only: z.array(z.string()).optional().describe("Only (re)generate these chunk ids, e.g. [\"auth\",\"tab-feed\"]."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Overwrite existing flow files (loses your edits). Default false — existing files are kept."),
  docsBranch: z.string().optional(),
};

export async function planCapture(args: {
  projectRoot?: string;
  only?: string[];
  overwrite?: boolean;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# plan_capture blocked\n\n${guard.escalation}`);

  const state = await loadState(projectRoot);
  if (!state || state.screenGraph.nodes.length === 0) {
    return errorText("No screen graph. Run project_scan (or create_document) first.");
  }

  const ctx = await buildContext(projectRoot, state);
  const capturesDir = capturesDirFor(projectRoot);
  await fs.mkdir(flowsDirFor(projectRoot), { recursive: true });

  let chunks = chunkScreens(state);
  if (args.only?.length) chunks = chunks.filter((c) => args.only!.includes(c.id));
  if (chunks.length === 0) {
    return errorText(`No chunks matched. Available: ${chunkScreens(state).map((c) => c.id).join(", ")}`);
  }

  const lines: string[] = [];
  let wrote = 0;
  let kept = 0;
  for (const chunk of chunks) {
    const file = chunkFlowFile(projectRoot, chunk.id);
    const exists = await fileExists(file);
    if (exists && !args.overwrite) {
      kept++;
      lines.push(`  • ${chunk.id} — ${chunk.nodes.length} screens · kept existing ${path.relative(projectRoot, file)}`);
      continue;
    }
    await fs.writeFile(file, generateChunkFlow(chunk, ctx.appId, capturesDir), "utf8");
    wrote++;
    lines.push(`  • ${chunk.id} — ${chunk.nodes.length} screens · wrote ${path.relative(projectRoot, file)}`);
  }

  const authNote = (await fileExists(path.join(projectRoot, ".docmcp", "skills", "auth-flow.yaml")))
    ? "Auth flow found — it runs automatically before each chunk."
    : "No auth flow yet: if screens need login, record .docmcp/skills/auth-flow.yaml and set credentials (set_credential).";

  return text(
    `# plan_capture — ${wrote} flow${wrote === 1 ? "" : "s"} written${kept ? `, ${kept} kept` : ""}\n\n` +
      `App: ${ctx.appId}\n${authNote}\n\n` +
      `Chunks:\n${lines.join("\n")}\n\n` +
      `Next:\n` +
      `1. Edit each \`.docmcp/flows/<chunk>.yaml\` — fill the \`# TODO\` navigation taps.\n` +
      `2. \`run_flow chunk:"<id>"\` to capture that chunk (one by one).\n` +
      `3. \`reconcile_capture\` to see which screenshots are missing and how to fix them.\n` +
      `4. \`create_document format:visual-flow\` to build the PDF.`,
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
