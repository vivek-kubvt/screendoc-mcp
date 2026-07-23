/**
 * Workspace guard — enforces the project's central rule:
 *
 *   "We work only in our branch. We never touch other branches. If another
 *    branch is checked out, stop and escalate to the user to switch."
 *
 * EVERY tool that writes anything runs `guardWorkspace` first. On a failed
 * check it performs zero writes and returns a `blocked` result carrying an
 * escalation message. The guard never switches branches, never stashes, never
 * decides for the user — it only reports and asks.
 */
import {
  isGitRepo,
  currentBranch,
  branchExists,
  isDirty,
} from "../util/git.js";
import { DEFAULT_DOCS_BRANCH, WorkspaceMode } from "../util/types.js";

export interface GuardOk {
  ok: true;
  mode: WorkspaceMode;
  branch: string | null;
  /** True on the very first run when the docs branch does not exist yet. */
  needsBranchCreation: boolean;
}

export interface GuardBlocked {
  ok: false;
  mode: WorkspaceMode;
  reason: string;
  /** Human-facing escalation the tool surfaces verbatim. */
  escalation: string;
}

export type GuardResult = GuardOk | GuardBlocked;

export interface GuardOptions {
  projectRoot: string;
  /** Docs branch this project is pinned to; defaults to docs/mcp-documentation. */
  docsBranch?: string;
}

export async function guardWorkspace(opts: GuardOptions): Promise<GuardResult> {
  const { projectRoot } = opts;
  const docsBranch = opts.docsBranch ?? DEFAULT_DOCS_BRANCH;

  // Folder mode: no git → no branch rules; .docmcp/ is the whole workspace.
  if (!(await isGitRepo(projectRoot))) {
    return { ok: true, mode: "folder", branch: null, needsBranchCreation: false };
  }

  const branch = await currentBranch(projectRoot);

  // Detached HEAD — we can't reason about "our branch"; refuse and escalate.
  if (branch === null) {
    return {
      ok: false,
      mode: "git-branch",
      reason: "detached-head",
      escalation:
        `The repository is in a detached-HEAD state, so doc-mcp cannot verify it is on its ` +
        `documentation branch. Please check out \`${docsBranch}\` (creating it if needed) and retry.`,
    };
  }

  const exists = await branchExists(projectRoot, docsBranch);

  // First run: docs branch doesn't exist yet. Signal the caller to create it
  // (with user consent) rather than assuming permission.
  if (!exists) {
    return {
      ok: true,
      mode: "git-branch",
      branch,
      needsBranchCreation: true,
    };
  }

  // The core rule: we must be ON the docs branch. Any other branch → escalate.
  if (branch !== docsBranch) {
    const dirty = await isDirty(projectRoot);
    const dirtyNote = dirty
      ? `\n\nNote: the working tree has uncommitted changes, so you may need to commit or stash them ` +
        `before switching. doc-mcp will not do this for you.`
      : "";
    return {
      ok: false,
      mode: "git-branch",
      reason: "wrong-branch",
      escalation:
        `doc-mcp only operates on its documentation branch. You are currently on \`${branch}\`, ` +
        `but this task must run on \`${docsBranch}\`.${dirtyNote}\n\n` +
        `Switch with:\n\n    git checkout ${docsBranch}\n\n` +
        `then re-run the tool. doc-mcp will never modify \`${branch}\` or any branch other than \`${docsBranch}\`.`,
    };
  }

  return { ok: true, mode: "git-branch", branch, needsBranchCreation: false };
}
