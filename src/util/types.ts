/**
 * Shared type definitions for doc-mcp.
 *
 * These describe the on-disk `.docmcp/state.json` contract. Everything the
 * tool knows about a project — its platform, its screens, where a run got to —
 * lives here so a fresh process can pick up exactly where the last one stopped.
 */

export type Platform =
  | "mobile-expo"
  | "mobile-rn"
  | "mobile-flutter"
  | "mobile-native-ios"
  | "mobile-native-android"
  | "web"
  | "other"
  | "unknown";

export type CaptureEngine = "ios-sim" | "android-maestro" | "web-playwright";

export type WorkspaceMode = "git-branch" | "folder";

export type RunStatus =
  | "idle"
  | "scanning"
  | "eliciting"
  | "capturing"
  | "writing"
  | "done";

/** A capturable UI surface: a screen and each of the visual states it can show. */
export interface ScreenNode {
  id: string;
  title: string;
  /** Route / deep-link path when the router exposes one. */
  route: string | null;
  /** Source files that render this screen (used by update-flow diff mapping). */
  sourceFiles: string[];
  /** Named states to capture: "default", "loading", "error", "empty", "paused"… */
  states: string[];
  /** Popups / alerts / toasters detected on this screen, captured as sub-shots. */
  overlays: string[];
  /** capture date (ISO) per state, or null if not yet captured. */
  captured: Record<string, string | null>;
  /** Content hash of the source files at last capture — drives drift detection. */
  contentHash: string | null;
  /** Secret keys required to reach this screen (e.g. "auth"). */
  requires: string[];
  /** Set when a node could not be captured; carries the reason. */
  blocked?: { reason: string; at: string };
}

export interface ScreenEdge {
  from: string;
  to: string;
  /** Human description of the transition ("Start walk button"). */
  via: string;
}

export interface ScreenGraph {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
}

export interface ProjectInfo {
  name: string;
  platform: Platform;
  frameworks: string[];
  /** Router entry points, e.g. ["src/app"] for expo-router. */
  entryPoints: string[];
  captureEngines: CaptureEngine[];
}

export interface WorkspaceInfo {
  mode: WorkspaceMode;
  /** Branch we are pinned to (git-branch mode only). */
  branch: string | null;
}

export interface Baseline {
  /** Commit the last document described — the update-flow diff anchor. */
  lastDocumentedCommit: string | null;
  lastRunDate: string | null;
  docVersion: number;
}

export interface RunState {
  status: RunStatus;
  currentNode: string | null;
  queue: string[];
  startedAt: string | null;
}

export interface GeneratedDocument {
  file: string;
  version: number;
  date: string;
  commit: string | null;
  kind: "create" | "update";
  screensChanged: string[];
}

/** The complete persisted state for one documented project. */
export interface DocState {
  version: 1;
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  baseline: Baseline;
  screenGraph: ScreenGraph;
  run: RunState;
  documents: GeneratedDocument[];
}

export const STATE_VERSION = 1 as const;
export const DOCMCP_DIR = ".docmcp";
export const STATE_FILE = "state.json";
export const SECRETS_FILE = "secrets.local.json";
export const DEFAULT_DOCS_BRANCH = "docs/mcp-documentation";
