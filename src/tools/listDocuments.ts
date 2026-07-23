/**
 * list_documents — every generated document with version, date, commit, kind,
 * and which screens changed. The lineage that makes updates easy to track.
 */
import { z } from "zod";
import { loadState } from "../state/store.js";
import { text, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const listDocumentsSchema = {
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
};

export async function listDocuments(args: { projectRoot?: string }): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const state = await loadState(projectRoot);
  if (!state || state.documents.length === 0) {
    return text("# Documents\n\nNone generated yet. Run create_document.");
  }
  const lines = ["# Documents", ""];
  for (const d of [...state.documents].reverse()) {
    lines.push(
      `- **v${d.version}** (${d.kind}) · ${d.date} · commit \`${d.commit ?? "—"}\` · ${d.file}` +
        (d.screensChanged.length ? `\n    changed: ${d.screensChanged.join(", ")}` : ""),
    );
  }
  return text(lines.join("\n"));
}
