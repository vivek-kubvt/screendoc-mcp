/**
 * extract_annotations — run the deterministic source-analysis pass over the
 * screen graph and write per-screen annotation skeletons under
 * `.docmcp/annotations/<screen-id>.json`.
 *
 * This fills the *mechanical* fields (navigation exits, UI handlers, popups,
 * APIs, storage keys, notifications, deep links, analytics, state branches,
 * native modules) with source line numbers. You then author the semantic fields
 * (Purpose, "what it does", field meanings). Re-running is safe: authored,
 * non-empty values are preserved (see mergeAnnotations).
 *
 * The visual-flow format renders these; the standard format ignores them.
 */
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState } from "../state/store.js";
import { extractAnnotation, mergeAnnotations, summarize } from "../scan/annotate.js";
import { loadAnnotations, annotationKey, ANNOTATIONS_DIR } from "../output/annotations.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DOCMCP_DIR } from "../util/types.js";

export const extractAnnotationsSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
  only: z.array(z.string()).optional().describe("Restrict extraction to these screen ids."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Replace existing annotations entirely instead of merging (authored fields are lost). Default false."),
  docsBranch: z.string().optional(),
};

export async function extractAnnotations(args: {
  projectRoot?: string;
  only?: string[];
  overwrite?: boolean;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# extract_annotations blocked\n\n${guard.escalation}`);

  const state = await loadState(projectRoot);
  if (!state || state.screenGraph.nodes.length === 0) {
    return errorText("No screen graph. Run project_scan (or create_document) first.");
  }

  let targets = state.screenGraph.nodes;
  if (args.only?.length) targets = targets.filter((n) => args.only!.includes(n.id));
  if (targets.length === 0) {
    return errorText(`No screens matched. Check ids with doc_status.`);
  }

  const existing = args.overwrite
    ? {}
    : await loadAnnotations(projectRoot, targets.map((n) => n.id));

  const dir = path.join(projectRoot, DOCMCP_DIR, ANNOTATIONS_DIR);
  await fs.mkdir(dir, { recursive: true });

  const log: string[] = [];
  let written = 0;
  for (const node of targets) {
    const extracted = await extractAnnotation(node.sourceFiles);
    const merged = args.overwrite ? extracted : mergeAnnotations(extracted, existing[node.id]);
    const file = path.join(dir, `${annotationKey(node.id)}.json`);
    await fs.writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
    written++;
    log.push(`  • ${node.title} — ${summarize(extracted)}`);
  }

  return text(
    `# extract_annotations — done\n\n` +
      `Wrote ${written} annotation skeleton${written === 1 ? "" : "s"} to ` +
      `\`.docmcp/${ANNOTATIONS_DIR}/\`${args.overwrite ? " (overwrite)" : " (merged; authored fields kept)"}.\n\n` +
      `${log.slice(0, 40).join("\n")}\n\n` +
      `Next: author the semantic fields (Purpose, each element's "does", field meanings), ` +
      `then build with the \`visual-flow\` format.`,
  );
}
