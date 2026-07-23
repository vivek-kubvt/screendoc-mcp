/**
 * Bridge the palette detector to the resolved format: for the visual-flow
 * template, when no accent was pinned in `.docmcp/format.json`, adopt the
 * project's own primary/brand color so the docs match the product. A committed
 * accent override always wins; detection is skipped for other templates.
 *
 * Mutates `resolved.format` in place and returns a one-line note for tool
 * output, or null when nothing was applied.
 */
import { ResolvedFormat } from "./formats.js";
import { detectPrimaryColor } from "../scan/palette.js";

export async function applyDetectedAccent(
  projectRoot: string,
  resolved: ResolvedFormat,
): Promise<string | null> {
  if (resolved.format.template !== "visual-flow" || resolved.accentFromConfig) return null;
  const detected = await detectPrimaryColor(projectRoot);
  if (!detected) return null;
  resolved.format = {
    ...resolved.format,
    colors: { ...resolved.format.colors, accent: detected.color },
  };
  return `Accent: ${detected.color} (from project palette · ${detected.source})`;
}
