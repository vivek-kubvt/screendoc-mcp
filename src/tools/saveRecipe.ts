/**
 * save_recipe — store a coordinate-tap navigation recipe for one screen/state.
 *
 * The recipe (ordered tap/swipe/input/wait/back steps) tells the capture engine
 * how to REACH that screen by driving the UI — the generic navigation path that
 * works even when deep links are blocked. Saved as JSON under
 * .docmcp/skills/recipes/<node-id>/<state>.json and replayed every run.
 */
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guardWorkspace } from "../guards/workspaceGuard.js";
import { loadState } from "../state/store.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Recipe } from "../capture/recipe.js";

export const saveRecipeSchema = {
  screenId: z.string().describe('Screen id from the graph, e.g. "(auth)/sign-in".'),
  state: z.string().optional().describe('State this recipe reaches (default "default").'),
  steps: z
    .array(z.record(z.any()))
    .describe(
      'Ordered steps. Each is one of: {launch:{clearState?}}, {tap:{text|id|point,index?}}, ' +
        '{input:string,into?:target}, {swipe:{direction}}, {wait:ms}, {waitFor:{text,timeout?}}, ' +
        '{back:true}, {assertVisible:{text}}. Use {{secretKey}} in input for stored secrets.',
    ),
  description: z.string().optional(),
  projectRoot: z.string().optional(),
  docsBranch: z.string().optional(),
};

export async function saveRecipe(args: {
  screenId: string;
  state?: string;
  steps: Record<string, any>[];
  description?: string;
  projectRoot?: string;
  docsBranch?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const guard = await guardWorkspace({ projectRoot, docsBranch: args.docsBranch });
  if (!guard.ok) return text(`# save_recipe blocked\n\n${guard.escalation}`);

  const state = args.state ?? "default";
  const st = await loadState(projectRoot);
  if (st && !st.screenGraph.nodes.find((n) => n.id === args.screenId)) {
    return errorText(
      `Screen "${args.screenId}" is not in the graph. Run project_scan or check the id with doc_status.`,
    );
  }

  const dir = path.join(projectRoot, ".docmcp", "skills", "recipes", args.screenId.replace(/\//g, "__"));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${state}.json`);
  const recipe: Recipe = { description: args.description, steps: args.steps as Recipe["steps"] };
  await fs.writeFile(file, JSON.stringify(recipe, null, 2) + "\n", "utf8");

  return text(
    `# save_recipe — saved\n\nScreen: ${args.screenId} (${state})\n` +
      `Steps: ${args.steps.length}\nFile: ${path.relative(projectRoot, file)}\n\n` +
      `capture_screen or create_document will replay this to reach the screen.`,
  );
}
