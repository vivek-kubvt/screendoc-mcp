/**
 * Project palette detection — find the app's own primary/brand color so the
 * documentation's accent matches the product instead of a fixed default. The
 * accent is purely cosmetic (headings, top bar, links, `code`), so this is
 * best-effort: it checks a short list of the usual palette homes and returns the
 * first plausible brand hex, or null (caller keeps the preset default).
 *
 * A committed `.docmcp/format.json` accent override always wins over detection.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface DetectedColor {
  /** Normalized hex, e.g. "#4338ca". */
  color: string;
  /** Where it came from, for honest reporting. */
  source: string;
}

/** Files most likely to hold the palette, in priority order. */
const CANDIDATES = [
  "app.json",
  "app.config.json",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.cjs",
  "constants/Colors.ts",
  "constants/colors.ts",
  "src/constants/Colors.ts",
  "src/constants/colors.ts",
  "src/theme/colors.ts",
  "src/theme/index.ts",
  "src/theme.ts",
  "src/styles/colors.ts",
  "src/config/colors.ts",
  "src/utils/colors.ts",
];

const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

function normalize(hex: string): string {
  return hex.toLowerCase().slice(0, 7); // drop alpha for a solid accent
}

/** In JS/TS palette files: the hex nearest after a primary/brand/accent key. */
function brandHexFromSource(src: string): string | null {
  for (const kw of ["primary", "brand", "accent"]) {
    const re = new RegExp(kw, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const window = src.slice(m.index, m.index + 160);
      const hex = window.match(HEX);
      if (hex) return normalize(hex[0]);
    }
  }
  return null;
}

/** In app.json/app.config.json: expo's brand-ish color keys. */
function colorFromAppJson(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const expo = (json as { expo?: Record<string, unknown> })?.expo ?? (json as Record<string, unknown>);
  const candidates = [
    (expo as Record<string, unknown>)?.primaryColor,
    ((expo as Record<string, unknown>)?.notification as { color?: unknown })?.color,
    ((expo as Record<string, unknown>)?.splash as { backgroundColor?: unknown })?.backgroundColor,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && HEX.test(c)) return normalize(c.match(HEX)![0]);
  }
  return null;
}

export async function detectPrimaryColor(projectRoot: string): Promise<DetectedColor | null> {
  for (const rel of CANDIDATES) {
    const file = path.join(projectRoot, rel);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const isJson = rel.endsWith(".json");
    const color = isJson ? colorFromAppJson(raw) : brandHexFromSource(raw);
    if (color) return { color, source: rel };
  }
  return null;
}
