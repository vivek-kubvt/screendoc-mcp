/**
 * Capture-engine interface. Every engine (Maestro for mobile, Playwright/Chrome
 * for web) implements the same contract, so the orchestrators are engine-blind.
 */
import { ScreenNode } from "../util/types.js";

export interface CaptureContext {
  projectRoot: string;
  /** App identity: iOS/Android bundle id, or base URL for web. */
  appId: string;
  /**
   * Deep-link scheme that resolves on the target device — resolved from the
   * NATIVE project (iOS Info.plist / Android manifest), not app.json, since the
   * two commonly diverge on iOS. Null → tap-path navigation only.
   */
  scheme: string | null;
  /** Device platform the scheme/appId were resolved for (null when unknown). */
  platform?: "ios" | "android" | null;
  /** Secrets available for auth recipes (values, resolved by key). */
  secrets: Record<string, string>;
  /** Absolute directory screenshots are written under. */
  capturesDir: string;
  /** How scheme/appId/platform were chosen — surfaced to the user for diagnosis. */
  identityEvidence?: string[];
  /**
   * Opt-in deep-link fallback. Default OFF — capture is Maestro-flow-first
   * (chunk flows + recipes). When true, a screen with no recipe/flow screenshot
   * may fall back to `openLink` deep-linking (legacy behavior).
   */
  allowDeepLinks?: boolean;
}

export interface CaptureOutcome {
  ok: boolean;
  /** Absolute PNG path when ok. */
  file?: string;
  /** Reason when !ok — surfaced at the coverage gate. */
  reason?: string;
}

export interface CaptureEngine {
  readonly id: string;
  /** One-time setup: verify tooling, launch app, run the auth recipe if present. */
  prepare(ctx: CaptureContext): Promise<{ ok: boolean; reason?: string }>;
  /** Navigate to `node` in visual `state`, screenshot to a file named `label`. */
  capture(
    ctx: CaptureContext,
    node: ScreenNode,
    state: string,
    label: string,
  ): Promise<CaptureOutcome>;
  teardown(ctx: CaptureContext): Promise<void>;
}
