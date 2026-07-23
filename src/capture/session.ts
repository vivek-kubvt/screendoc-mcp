/**
 * Build a CaptureContext from the project + state: resolve the app's bundle id
 * and URL scheme (from app.json for Expo), load secrets, and ensure the
 * captures directory exists.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CaptureContext } from "./engine.js";
import { DocState } from "../util/types.js";
import { loadSecrets } from "../state/secrets.js";
import { detectNativeIdentity } from "../scan/nativeIdentity.js";

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function buildContext(
  projectRoot: string,
  state: DocState,
  opts?: { allowDeepLinks?: boolean },
): Promise<CaptureContext> {
  const appConfig =
    (await readJson(path.join(projectRoot, "app.json"))) ??
    (await readJson(path.join(projectRoot, "app.config.json")));
  const expo = appConfig?.expo ?? {};

  const iosBundleId: string | null = expo?.ios?.bundleIdentifier ?? null;
  const androidPackage: string | null = expo?.android?.package ?? null;

  let jsScheme: string | null = null;
  if (Array.isArray(expo?.scheme)) jsScheme = expo.scheme[0] ?? null;
  else if (typeof expo?.scheme === "string") jsScheme = expo.scheme;

  // Resolve the scheme + app id that ACTUALLY work on the booted device — the
  // native project is the source of truth, not app.json (see nativeIdentity).
  const native = await detectNativeIdentity(projectRoot, {
    jsScheme,
    iosBundleId,
    androidPackage,
  });

  const appId: string =
    native.appId ?? iosBundleId ?? androidPackage ?? state.project.name;
  const scheme: string | null = native.scheme ?? jsScheme;

  const capturesDir = path.join(projectRoot, ".docmcp", "captures");
  await fs.mkdir(capturesDir, { recursive: true });

  const secrets = await loadSecrets(projectRoot);

  return {
    projectRoot,
    appId,
    scheme,
    platform: native.targetPlatform,
    secrets,
    capturesDir,
    identityEvidence: native.evidence,
    allowDeepLinks: opts?.allowDeepLinks ?? false,
  };
}
