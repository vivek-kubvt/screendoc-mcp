/**
 * Native identity resolution — the deep-link scheme and app id that ACTUALLY
 * work on the device we're about to drive.
 *
 * Why this exists: for Expo/React-Native apps the `scheme` in app.json (e.g.
 * "acme") is NOT necessarily what iOS registers. Expo's iOS prebuild often
 * registers the bundle-id scheme ("com.acme.app") plus SDK schemes
 * (Google/Facebook/`exp+…`) and may omit the bare app.json scheme entirely.
 * Deep-linking with the app.json scheme then fails with
 *   LSApplicationWorkspaceErrorDomain error 115  (nothing handles the URL),
 * which reads as "capture failed" even though the app is installed and fine.
 *
 * So instead of trusting app.json, we read the registered schemes straight from
 * the native project (iOS Info.plist CFBundleURLTypes, Android manifest
 * intent-filters) for whichever platform is actually booted, and pick the
 * scheme that will resolve.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { run, commandExists } from "../util/exec.js";

export type TargetPlatform = "ios" | "android";

export interface NativeIdentity {
  /** Platform we resolved for (booted device, else the native project present). */
  targetPlatform: TargetPlatform | null;
  /** Deep-link scheme that resolves on the target platform (no trailing "://"). */
  scheme: string | null;
  /** Bundle id / package for the target platform. */
  appId: string | null;
  iosSchemes: string[];
  androidSchemes: string[];
  /** Human notes on how each value was chosen (surfaced to the user). */
  evidence: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Prefer a device that is actually running; fall back to the native project present. */
async function resolveTargetPlatform(projectRoot: string): Promise<TargetPlatform | null> {
  if (await commandExists("xcrun")) {
    const r = await run("xcrun", ["simctl", "list", "devices", "booted"], { timeoutMs: 15_000 });
    if (r.code === 0 && /\(Booted\)/.test(r.stdout)) return "ios";
  }
  if (await commandExists("adb")) {
    const r = await run("adb", ["devices"], { timeoutMs: 15_000 });
    // lines like "emulator-5554\tdevice"
    if (r.code === 0 && /\bdevice\b/.test(r.stdout.split("\n").slice(1).join("\n"))) return "android";
  }
  if (await exists(path.join(projectRoot, "ios"))) return "ios";
  if (await exists(path.join(projectRoot, "android"))) return "android";
  return null;
}

/** CFBundleURLSchemes from the app's Info.plist (skips Pods / project wrappers). */
async function readIosSchemes(projectRoot: string): Promise<string[]> {
  const iosDir = path.join(projectRoot, "ios");
  if (!(await exists(iosDir))) return [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(iosDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    if (e.name === "Pods" || e.name.endsWith(".xcodeproj") || e.name.endsWith(".xcworkspace")) continue;
    const plist = path.join(iosDir, e.name, "Info.plist");
    if (await exists(plist)) {
      const schemes = await parsePlistSchemes(plist);
      if (schemes.length) return schemes;
    }
  }
  return [];
}

async function parsePlistSchemes(plist: string): Promise<string[]> {
  // plutil (macOS) gives clean JSON; regex is the cross-platform fallback.
  if (await commandExists("plutil")) {
    const r = await run("plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist], {
      timeoutMs: 15_000,
    });
    if (r.code === 0) {
      try {
        const types = JSON.parse(r.stdout) as Array<{ CFBundleURLSchemes?: string[] }>;
        return types.flatMap((t) => t.CFBundleURLSchemes ?? []);
      } catch {
        /* fall through to regex */
      }
    }
  }
  try {
    const xml = await fs.readFile(plist, "utf8");
    const schemes: string[] = [];
    const arrays = /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g;
    let a: RegExpExecArray | null;
    while ((a = arrays.exec(xml))) {
      const strings = /<string>([^<]+)<\/string>/g;
      let s: RegExpExecArray | null;
      while ((s = strings.exec(a[1]))) schemes.push(s[1]);
    }
    return schemes;
  } catch {
    return [];
  }
}

/** android:scheme values from intent-filters in the app manifest. */
async function readAndroidSchemes(projectRoot: string): Promise<string[]> {
  const manifest = path.join(projectRoot, "android", "app", "src", "main", "AndroidManifest.xml");
  try {
    const xml = await fs.readFile(manifest, "utf8");
    const out = new Set<string>();
    const re = /<data\s+[^>]*android:scheme="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) out.add(m[1]);
    return [...out];
  } catch {
    return [];
  }
}

/** SDK/system schemes that exist but should never be used for app deep links. */
function isAppScheme(scheme: string): boolean {
  return (
    !scheme.startsWith("exp+") &&
    !scheme.startsWith("fb") &&
    !scheme.startsWith("com.googleusercontent") &&
    !scheme.startsWith("twitterkit-") &&
    !scheme.startsWith("pinterest") &&
    !scheme.startsWith("msauth")
  );
}

/** Pick the scheme most likely to resolve: the app.json scheme if it's actually
 *  registered, else the bundle-id scheme (Expo's default), else the cleanest
 *  registered app scheme, else the app.json value as a last resort. */
function pickScheme(registered: string[], jsScheme: string | null, bundle: string | null): string | null {
  if (!registered.length) return jsScheme;
  if (jsScheme && registered.includes(jsScheme)) return jsScheme;
  if (bundle && registered.includes(bundle)) return bundle;
  const clean = registered.filter(isAppScheme);
  return clean[0] ?? registered[0] ?? jsScheme;
}

export async function detectNativeIdentity(
  projectRoot: string,
  opts: { jsScheme: string | null; iosBundleId: string | null; androidPackage: string | null },
): Promise<NativeIdentity> {
  const { jsScheme, iosBundleId, androidPackage } = opts;
  const evidence: string[] = [];
  const [target, iosSchemes, androidSchemes] = await Promise.all([
    resolveTargetPlatform(projectRoot),
    readIosSchemes(projectRoot),
    readAndroidSchemes(projectRoot),
  ]);

  let scheme = jsScheme;
  let appId: string | null = iosBundleId ?? androidPackage;

  if (target === "ios") {
    appId = iosBundleId ?? androidPackage;
    scheme = pickScheme(iosSchemes, jsScheme, iosBundleId);
    evidence.push(
      `iOS target — registered schemes: [${iosSchemes.join(", ") || "none"}] → deep-link scheme "${scheme}".`,
    );
    if (jsScheme && iosSchemes.length && !iosSchemes.includes(jsScheme)) {
      evidence.push(
        `app.json scheme "${jsScheme}" is NOT in the iOS Info.plist — using "${scheme}". ` +
          `(Bare app.json schemes are the usual cause of LSApplicationWorkspace error 115.)`,
      );
    }
  } else if (target === "android") {
    appId = androidPackage ?? iosBundleId;
    scheme = pickScheme(androidSchemes, jsScheme, androidPackage);
    evidence.push(
      `Android target — registered schemes: [${androidSchemes.join(", ") || "none"}] → "${scheme}".`,
    );
  } else {
    evidence.push("No booted device or native project found — falling back to app.json scheme/appId.");
  }

  return { targetPlatform: target, scheme, appId, iosSchemes, androidSchemes, evidence };
}
