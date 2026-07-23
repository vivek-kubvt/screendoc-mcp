/**
 * Document formats — named, reusable presets for the generated documentation.
 *
 * The problem this solves: the doc's look (colors, fonts, cover, layout) used to
 * be hardcoded in html.ts, so there was no way to pin a house style — every
 * change to the template silently changed every document. Now the style lives in
 * a small set of named presets, and a project selects one with a committed
 * `.docmcp/format.json`. Commit the file once and every run — create or update —
 * renders with the exact same format.
 *
 * `.docmcp/format.json` accepts either a bare preset name:
 *     "brand"
 * or a preset plus shallow overrides:
 *     { "preset": "brand",
 *       "overrides": { "colors": { "accent": "#7A1FA2" },
 *                      "cover":  { "eyebrow": "Acme Product Docs" } } }
 *
 * Unknown/missing/invalid config falls back to the `default` preset (never throws),
 * so a malformed file degrades gracefully instead of breaking a documentation run.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DOCMCP_DIR } from "../util/types.js";

export interface DocFormat {
  /** Preset key (stable id, used for selection). */
  name: string;
  /** Human label shown in tool output. */
  label: string;
  /**
   * Page structure this format renders with:
   *   "standard"    — cover + TOC + flowing per-screen sections (the original).
   *   "visual-flow" — one screen per page: device frame + source-linked breakdown
   *                   (Purpose / Navigation / UI elements / Labels) + running footer.
   */
  template: "standard" | "visual-flow";
  colors: {
    ink: string;
    muted: string;
    accent: string;
    line: string;
    soft: string;
    /** Background + ink for the "UPDATED" / blocked badges. */
    badgeBg: string;
    badgeInk: string;
  };
  fonts: {
    body: string;
    mono: string;
  };
  cover: {
    /** Small uppercase label above the title. */
    eyebrow: string;
    showFrameworks: boolean;
    showEngines: boolean;
  };
  layout: {
    /** Table-of-contents columns (1 = single list, 2 = two columns). */
    tocColumns: number;
    /** Screenshot bounds in px. */
    shotMaxHeight: number;
    shotMaxWidth: number;
    /** Horizontal padding for content sections, a CSS length. */
    pagePadding: string;
  };
}

const SYSTEM_BODY = `-apple-system, "Segoe UI", Roboto, sans-serif`;
const SYSTEM_MONO = `ui-monospace, Menlo, monospace`;

/**
 * Built-in presets. `default` reproduces the original green house style exactly,
 * so existing documents are unchanged; the others are alternative fixed styles.
 */
export const FORMATS: Record<string, DocFormat> = {
  default: {
    name: "default",
    label: "Default (green)",
    template: "standard",
    colors: {
      ink: "#1c2220",
      muted: "#5c6b62",
      accent: "#0e6b52",
      line: "#dbe2da",
      soft: "#eef3ee",
      badgeBg: "#fdecc8",
      badgeInk: "#8a5a00",
    },
    fonts: { body: SYSTEM_BODY, mono: SYSTEM_MONO },
    cover: { eyebrow: "Screen Documentation", showFrameworks: true, showEngines: true },
    layout: { tocColumns: 2, shotMaxHeight: 460, shotMaxWidth: 240, pagePadding: "3rem" },
  },
  brand: {
    name: "brand",
    label: "Brand (indigo)",
    template: "standard",
    colors: {
      ink: "#171a2b",
      muted: "#5b6178",
      accent: "#4338ca",
      line: "#dcdef0",
      soft: "#eef0fb",
      badgeBg: "#e0e7ff",
      badgeInk: "#3730a3",
    },
    fonts: { body: SYSTEM_BODY, mono: SYSTEM_MONO },
    cover: { eyebrow: "Product Documentation", showFrameworks: true, showEngines: false },
    layout: { tocColumns: 2, shotMaxHeight: 480, shotMaxWidth: 250, pagePadding: "3rem" },
  },
  compact: {
    name: "compact",
    label: "Compact (dense, grayscale)",
    template: "standard",
    colors: {
      ink: "#1a1a1a",
      muted: "#6b6b6b",
      accent: "#333333",
      line: "#e0e0e0",
      soft: "#f2f2f2",
      badgeBg: "#e8e8e8",
      badgeInk: "#444444",
    },
    fonts: { body: SYSTEM_BODY, mono: SYSTEM_MONO },
    cover: { eyebrow: "Screen Reference", showFrameworks: false, showEngines: false },
    layout: { tocColumns: 1, shotMaxHeight: 320, shotMaxWidth: 180, pagePadding: "2rem" },
  },
  "visual-flow": {
    name: "visual-flow",
    label: "Visual Flow (device frame + source map)",
    template: "visual-flow",
    colors: {
      ink: "#141414",
      muted: "#6b7280",
      accent: "#16a34a",
      line: "#e5e7eb",
      soft: "#f3f4f6",
      badgeBg: "#dcfce7",
      badgeInk: "#166534",
    },
    fonts: { body: SYSTEM_BODY, mono: SYSTEM_MONO },
    cover: { eyebrow: "Visual Flow Documentation", showFrameworks: true, showEngines: false },
    layout: { tocColumns: 1, shotMaxHeight: 520, shotMaxWidth: 270, pagePadding: "2.5rem" },
  },
};

export const DEFAULT_FORMAT = "default";
export const FORMAT_FILE = "format.json";

/** Names of all built-in presets, for help/error text. */
export function formatNames(): string[] {
  return Object.keys(FORMATS);
}

/** Shallow, per-group merge: overrides replace individual keys, not whole groups. */
function applyOverrides(base: DocFormat, overrides: unknown): DocFormat {
  if (!overrides || typeof overrides !== "object") return base;
  const o = overrides as Record<string, unknown>;
  const merged: DocFormat = {
    ...base,
    colors: { ...base.colors, ...(o.colors as object) },
    fonts: { ...base.fonts, ...(o.fonts as object) },
    cover: { ...base.cover, ...(o.cover as object) },
    layout: { ...base.layout, ...(o.layout as object) },
  };
  return merged;
}

export interface ResolvedFormat {
  format: DocFormat;
  /** Where the selection came from — for honest reporting in tool output. */
  source: "config" | "default";
  /** True when format.json explicitly set colors.accent — palette detection then defers to it. */
  accentFromConfig: boolean;
  /** Non-fatal problems (unknown preset, bad JSON): surfaced, never thrown. */
  warnings: string[];
}

/**
 * Resolve the format for a project. Reads `.docmcp/format.json` when present;
 * otherwise uses `default`. Always returns a usable format — a bad file yields
 * the default plus a warning rather than an error.
 */
export async function resolveFormat(projectRoot: string): Promise<ResolvedFormat> {
  const file = path.join(projectRoot, DOCMCP_DIR, FORMAT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { format: FORMATS[DEFAULT_FORMAT], source: "default", accentFromConfig: false, warnings: [] };
    }
    return {
      format: FORMATS[DEFAULT_FORMAT],
      source: "default",
      accentFromConfig: false,
      warnings: [`Could not read ${FORMAT_FILE}: ${(err as Error).message}. Using default.`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      format: FORMATS[DEFAULT_FORMAT],
      source: "default",
      accentFromConfig: false,
      warnings: [`${FORMAT_FILE} is not valid JSON. Using default.`],
    };
  }

  const presetName = typeof parsed === "string" ? parsed : (parsed as { preset?: unknown })?.preset;
  const overrides = typeof parsed === "string" ? undefined : (parsed as { overrides?: unknown })?.overrides;
  const accentFromConfig = Boolean(
    overrides && typeof overrides === "object" && (overrides as { colors?: { accent?: unknown } }).colors?.accent,
  );

  const key = typeof presetName === "string" ? presetName : DEFAULT_FORMAT;
  const base = FORMATS[key];
  if (!base) {
    return {
      format: applyOverrides(FORMATS[DEFAULT_FORMAT], overrides),
      source: "config",
      accentFromConfig,
      warnings: [
        `Unknown format preset "${key}" in ${FORMAT_FILE}. ` +
          `Known presets: ${formatNames().join(", ")}. Using default.`,
      ],
    };
  }

  return { format: applyOverrides(base, overrides), source: "config", accentFromConfig, warnings: [] };
}
