/**
 * Platform detection — sniff a project's manifests to decide what kind of app
 * it is and which capture engine(s) can drive it.
 *
 * Deliberately conservative: when signals are ambiguous it returns "unknown"
 * and the create-flow asks the user rather than guessing wrong.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Platform, CaptureEngine } from "../util/types.js";

export interface PlatformDetection {
  platform: Platform;
  frameworks: string[];
  entryPoints: string[];
  captureEngines: CaptureEngine[];
  /** Human notes on how the decision was reached (surfaced to the user). */
  evidence: string[];
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** First directory in `candidates` that exists, relative to root. */
async function firstDir(root: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await exists(path.join(root, c))) return c;
  }
  return null;
}

export async function detectPlatform(projectRoot: string): Promise<PlatformDetection> {
  const evidence: string[] = [];
  const frameworks: string[] = [];
  const engines = new Set<CaptureEngine>();

  const pkg = await readJson(path.join(projectRoot, "package.json"));
  const deps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const has = (name: string) => name in deps;

  // Flutter — pubspec.yaml is definitive.
  if (await exists(path.join(projectRoot, "pubspec.yaml"))) {
    evidence.push("Found pubspec.yaml → Flutter project.");
    return {
      platform: "mobile-flutter",
      frameworks: ["flutter"],
      entryPoints: ["lib"],
      captureEngines: ["ios-sim", "android-maestro"],
      evidence,
    };
  }

  // Expo / React Native.
  const appConfig =
    (await readJson(path.join(projectRoot, "app.json"))) ??
    (await readJson(path.join(projectRoot, "app.config.json")));
  const isExpo = has("expo") || appConfig?.expo != null;
  const isRN = has("react-native");

  if (isExpo || isRN) {
    if (isExpo) {
      frameworks.push("expo");
      evidence.push("expo dependency / app.json expo block present.");
    }
    if (isRN) frameworks.push("react-native");
    if (has("expo-router")) {
      frameworks.push("expo-router");
      evidence.push("expo-router present → file-based routing under app/ or src/app/.");
    }
    if (has("@react-navigation/native")) frameworks.push("react-navigation");

    const entry = await firstDir(projectRoot, ["src/app", "app"]);
    const entryPoints = entry ? [entry] : [];

    // Both mobile engines apply; iOS is our proven default.
    engines.add("ios-sim");
    engines.add("android-maestro");

    return {
      platform: isExpo ? "mobile-expo" : "mobile-rn",
      frameworks,
      entryPoints,
      captureEngines: [...engines],
      evidence,
    };
  }

  // Web frameworks.
  const webSignals: Array<[string, string]> = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@remix-run/react", "Remix"],
    ["vite", "Vite"],
    ["react-scripts", "Create React App"],
    ["@angular/core", "Angular"],
    ["svelte", "Svelte"],
  ];
  const webHits = webSignals.filter(([d]) => has(d));
  if (webHits.length) {
    for (const [, label] of webHits) frameworks.push(label);
    evidence.push(`Web framework detected: ${webHits.map(([, l]) => l).join(", ")}.`);
    const entry = await firstDir(projectRoot, ["src/pages", "app", "pages", "src"]);
    return {
      platform: "web",
      frameworks,
      entryPoints: entry ? [entry] : [],
      captureEngines: ["web-playwright"],
      evidence,
    };
  }

  evidence.push("No decisive mobile or web signals found.");
  return {
    platform: "unknown",
    frameworks,
    entryPoints: [],
    captureEngines: [],
    evidence,
  };
}
