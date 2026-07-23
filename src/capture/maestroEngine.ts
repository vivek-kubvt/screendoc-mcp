/**
 * Maestro capture engine — drives iOS simulators and Android emulators with one
 * tool (matches the project's existing Android harness). For each screen it
 * generates a tiny Maestro flow that deep-links to the route and screenshots it.
 *
 * Navigation strategy:
 *   - Static routes  → deep link  (scheme:///route)  — generic, no per-app code.
 *   - Dynamic routes ([param]) or non-linkable states → need a recorded recipe
 *     in .docmcp/skills/recipes/<node-id>/<state>.yaml; absent → reported, not
 *     silently skipped.
 *
 * Auth: if .docmcp/skills/auth-flow.yaml exists it is run once in prepare(), so
 * a logged-in session persists (via the app's own storage) for later deep links.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CaptureContext, CaptureEngine, CaptureOutcome } from "./engine.js";
import { ScreenNode } from "../util/types.js";
import { run, commandExists } from "../util/exec.js";
import { compileRecipe, Recipe } from "./recipe.js";

const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;

async function maestroBin(): Promise<string> {
  if (await commandExists("maestro")) return "maestro";
  return MAESTRO; // fall back to the standard install path
}

/** scheme + route → deep link, or null when the route can't be linked.
 *  Uses `scheme://route` (host-style) — the form verified to resolve on iOS
 *  simulators; the empty-authority `scheme:///route` form is flakier there. */
function deepLink(scheme: string | null, node: ScreenNode): string | null {
  if (!scheme || !node.route) return null;
  if (node.route.includes(":") || node.route.includes("*")) return null; // dynamic
  const routePart = node.route === "/" ? "" : node.route.replace(/^\//, "");
  return `${scheme}://${routePart}`;
}

function recipeDir(ctx: CaptureContext, node: ScreenNode): string {
  return path.join(ctx.projectRoot, ".docmcp", "skills", "recipes", node.id.replace(/\//g, "__"));
}

/** Resolve a recipe body for (node,state): a structured .json recipe (compiled)
 *  or a raw .yaml recipe. Returns null when neither exists. */
async function loadRecipeBody(
  ctx: CaptureContext,
  node: ScreenNode,
  state: string,
): Promise<string | null> {
  const jsonPath = path.join(recipeDir(ctx, node), `${state}.json`);
  if (await fileExists(jsonPath)) {
    const recipe = JSON.parse(await fs.readFile(jsonPath, "utf8")) as Recipe;
    return compileRecipe(recipe, ctx.secrets);
  }
  const yamlPath = path.join(recipeDir(ctx, node), `${state}.yaml`);
  if (await fileExists(yamlPath)) {
    return (await fs.readFile(yamlPath, "utf8")).trimEnd();
  }
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class MaestroEngine implements CaptureEngine {
  readonly id = "maestro";
  private bin = "maestro";
  private flowDir = "";

  async prepare(ctx: CaptureContext): Promise<{ ok: boolean; reason?: string }> {
    this.bin = await maestroBin();
    const check = await run(this.bin, ["--version"], { timeoutMs: 15000 });
    if (check.code !== 0) {
      return { ok: false, reason: "Maestro not runnable. Install: curl -Ls https://get.maestro.mobile.dev | bash" };
    }
    this.flowDir = path.join(ctx.capturesDir, "..", "flows");
    await fs.mkdir(this.flowDir, { recursive: true });

    // Run the auth recipe once, if the project has recorded one.
    const authFlow = path.join(ctx.projectRoot, ".docmcp", "skills", "auth-flow.yaml");
    if (await fileExists(authFlow)) {
      const res = await run(this.bin, ["test", authFlow], { timeoutMs: 180_000, cwd: ctx.projectRoot });
      if (res.code !== 0) {
        return {
          ok: false,
          reason: `Auth recipe failed (maestro exit ${res.code}). Check .docmcp/skills/auth-flow.yaml and credentials.`,
        };
      }
    }
    return { ok: true };
  }

  async capture(
    ctx: CaptureContext,
    node: ScreenNode,
    state: string,
    label: string,
  ): Promise<CaptureOutcome> {
    const shotBase = path.join(ctx.capturesDir, label); // maestro appends .png
    const flowFile = path.join(this.flowDir, `${label}.yaml`);

    // Navigation precedence: a recorded recipe (coordinate-tap, works on any
    // build) wins; otherwise fall back to a deep link (works on release builds).
    const recipeBody = await loadRecipeBody(ctx, node, state);
    let flow: string;
    if (recipeBody) {
      flow = `appId: ${ctx.appId}\n---\n` + recipeBody + `\n- takeScreenshot: ${shotBase}\n`;
    } else if (state === "default" && ctx.allowDeepLinks) {
      // Legacy fallback, opt-in only. Primary path is chunk flows (plan_capture/run_flow).
      const link = deepLink(ctx.scheme, node);
      if (!link) {
        return {
          ok: false,
          reason:
            `No recipe/flow screenshot and no deep link for route "${node.route ?? "—"}". ` +
            `Add it to a chunk flow (plan_capture → run_flow) or record a recipe.`,
        };
      }
      flow =
        `appId: ${ctx.appId}\n---\n` +
        `- openLink:\n    link: ${link}\n    autoVerify: false\n` +
        `- waitForAnimationToEnd:\n    timeout: 4000\n` +
        `- takeScreenshot: ${shotBase}\n`;
    } else {
      const chunkHint = `plan_capture` + (state !== "default" ? " (then add a step to reach this state)" : " → run_flow");
      return {
        ok: false,
        reason:
          `No screenshot for "${node.title}" (${state}). Capture is Maestro-flow-first: ${chunkHint}, ` +
          `or record a recipe. (Deep-linking is off; pass allowDeepLinks:true to re-enable the fallback.)`,
      };
    }

    await fs.writeFile(flowFile, flow, "utf8");
    const res = await run(this.bin, ["test", flowFile], {
      timeoutMs: 90_000,
      cwd: ctx.projectRoot,
    });
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).split("\n").slice(-4).join(" ").trim();
      return { ok: false, reason: `maestro exit ${res.code}: ${tail || "flow failed"}` };
    }
    const produced = `${shotBase}.png`;
    if (!(await fileExists(produced))) {
      return { ok: false, reason: "maestro reported success but no screenshot was written" };
    }
    return { ok: true, file: produced };
  }

  /**
   * Run a whole chunk flow file (Maestro-flow-first capture). The flow itself
   * contains the `takeScreenshot` steps; the caller reconciles which landed.
   * Requires prepare() first (resolves the binary and runs auth once).
   */
  async runFlowFile(ctx: CaptureContext, flowFile: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await run(this.bin, ["test", flowFile], { timeoutMs: 300_000, cwd: ctx.projectRoot });
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).split("\n").slice(-6).join(" ").trim();
      return { ok: false, reason: `maestro exit ${res.code}: ${tail || "flow failed"}` };
    }
    return { ok: true };
  }

  async teardown(_ctx: CaptureContext): Promise<void> {
    /* nothing persistent to clean up */
  }
}
