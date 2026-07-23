/**
 * Coordinate-tap navigation recipes.
 *
 * A recipe is a small ordered list of steps describing how to REACH a screen by
 * interacting with the UI — tap (by visible text or by point), swipe, type,
 * wait, go back. Steps compile to Maestro commands, which drive both iOS
 * simulators and Android emulators reliably (unlike deep links, which a
 * dev-client build may ignore).
 *
 * Recipes live at .docmcp/skills/recipes/<node-id>/<state>.json and are the
 * generic navigation primitive: author or record once, replay every run.
 *
 * Secret substitution: any string may contain {{key}}, replaced from the
 * project's secrets store at compile time (never written to disk).
 */

export type Target =
  | { text: string; index?: number }
  | { id: string; index?: number }
  | { point: string }; // "50%,90%" or "201,785"

export type RecipeStep =
  | { launch: { clearState?: boolean } }
  | { tap: Target }
  | { longPress: Target }
  | { input: string; into?: Target }
  | { swipe: { direction: "up" | "down" | "left" | "right" } }
  | { wait: number }
  | { waitFor: { text: string; timeout?: number } }
  | { back: true }
  | { assertVisible: { text: string } };

export interface Recipe {
  /** Human note about what this recipe reaches. */
  description?: string;
  steps: RecipeStep[];
}

function subst(s: string, secrets: Record<string, string>): string {
  return s.replace(/\{\{(\w[\w.-]*)\}\}/g, (_m, k) => secrets[k] ?? "");
}

function targetYaml(t: Target): string {
  if ("text" in t) return `    text: ${JSON.stringify(t.text)}${t.index != null ? `\n    index: ${t.index}` : ""}`;
  if ("id" in t) return `    id: ${JSON.stringify(t.id)}${t.index != null ? `\n    index: ${t.index}` : ""}`;
  return `    point: ${JSON.stringify(t.point)}`;
}

/** Compile recipe steps into a Maestro flow BODY (no appId header, no trailing screenshot). */
export function compileRecipe(recipe: Recipe, secrets: Record<string, string>): string {
  const out: string[] = [];
  for (const step of recipe.steps) {
    if ("launch" in step) {
      out.push(step.launch.clearState ? `- launchApp:\n    clearState: true` : `- launchApp`);
    } else if ("tap" in step) {
      out.push(`- tapOn:\n${targetYaml(step.tap)}`);
    } else if ("longPress" in step) {
      out.push(`- longPressOn:\n${targetYaml(step.longPress)}`);
    } else if ("input" in step) {
      if (step.into) out.push(`- tapOn:\n${targetYaml(step.into)}`);
      out.push(`- inputText: ${JSON.stringify(subst(step.input, secrets))}`);
    } else if ("swipe" in step) {
      out.push(`- swipe:\n    direction: ${step.swipe.direction.toUpperCase()}`);
    } else if ("wait" in step) {
      out.push(`- waitForAnimationToEnd:\n    timeout: ${step.wait}`);
    } else if ("waitFor" in step) {
      out.push(
        `- extendedWaitUntil:\n    visible:\n      text: ${JSON.stringify(step.waitFor.text)}\n    timeout: ${step.waitFor.timeout ?? 10000}`,
      );
    } else if ("back" in step) {
      out.push(`- back`);
    } else if ("assertVisible" in step) {
      out.push(`- assertVisible:\n    text: ${JSON.stringify(step.assertVisible.text)}`);
    }
  }
  return out.join("\n");
}
