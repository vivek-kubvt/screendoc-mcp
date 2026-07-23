/**
 * State store — the single source of truth for a documented project.
 *
 * Reads/writes `<project>/.docmcp/state.json`. Writes are atomic (temp file +
 * rename) so an interrupted run can never leave a half-written state behind.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DocState,
  DOCMCP_DIR,
  STATE_FILE,
  STATE_VERSION,
  Platform,
} from "../util/types.js";

export function docmcpDir(projectRoot: string): string {
  return path.join(projectRoot, DOCMCP_DIR);
}

export function statePath(projectRoot: string): string {
  return path.join(docmcpDir(projectRoot), STATE_FILE);
}

export async function stateExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.access(statePath(projectRoot));
    return true;
  } catch {
    return false;
  }
}

/** A blank state for a project we have never documented before. */
export function defaultState(projectName: string, platform: Platform = "unknown"): DocState {
  return {
    version: STATE_VERSION,
    project: {
      name: projectName,
      platform,
      frameworks: [],
      entryPoints: [],
      captureEngines: [],
    },
    workspace: { mode: "folder", branch: null },
    baseline: { lastDocumentedCommit: null, lastRunDate: null, docVersion: 0 },
    screenGraph: { nodes: [], edges: [] },
    run: { status: "idle", currentNode: null, queue: [], startedAt: null },
    documents: [],
  };
}

export async function loadState(projectRoot: string): Promise<DocState | null> {
  try {
    const raw = await fs.readFile(statePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as DocState;
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `state.json version ${parsed.version} is not supported by this doc-mcp (expects ${STATE_VERSION})`,
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveState(projectRoot: string, state: DocState): Promise<void> {
  const dir = docmcpDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const target = statePath(projectRoot);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target); // atomic on same filesystem
}

/**
 * Load, mutate, and save in one shot. The mutator may be async (e.g. it needs
 * to hash files). Returns the state that was persisted.
 */
export async function updateState(
  projectRoot: string,
  mutate: (s: DocState) => void | Promise<void>,
): Promise<DocState> {
  const current = (await loadState(projectRoot)) ?? defaultState(path.basename(projectRoot));
  await mutate(current);
  await saveState(projectRoot, current);
  return current;
}
