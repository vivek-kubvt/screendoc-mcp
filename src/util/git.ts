/**
 * Thin, safe wrappers around git. Every call is scoped to an explicit `cwd`
 * (the documented project's root) and never mutates branch state — the tool
 * inspects git and asks the user to switch; it never switches for them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, maxBuffer: 1024 * 1024 * 16 });
  return stdout.trim();
}

/** True when `dir` sits inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Current branch name, or null on a true detached HEAD.
 *
 * Uses `symbolic-ref`, which resolves the branch name even for an *unborn*
 * branch (a freshly `git init`-ed repo with no commits yet) and errors only on
 * a genuine detached HEAD — the distinction `rev-parse --abbrev-ref` blurs.
 */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    return await git(dir, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return null; // detached HEAD
  }
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Short SHA of HEAD, or null. */
export async function headShort(dir: string): Promise<string | null> {
  try {
    return await git(dir, ["rev-parse", "--short", "HEAD"]);
  } catch {
    return null;
  }
}

/** True when the working tree has uncommitted changes. */
export async function isDirty(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["status", "--porcelain"]);
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Files changed between `baseCommit` and HEAD. */
export async function changedFilesSince(dir: string, baseCommit: string): Promise<string[]> {
  const out = await git(dir, ["diff", "--name-only", `${baseCommit}..HEAD`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** One-line commit subjects between `baseCommit` and HEAD (newest first). */
export async function commitsSince(dir: string, baseCommit: string): Promise<string[]> {
  const out = await git(dir, ["log", "--pretty=%h %s", `${baseCommit}..HEAD`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Create and check out `branch` from `base`. Used only on the first documented
 * run, and only after the user has explicitly consented — never as a silent
 * side effect. Returns an error string on failure, or null on success.
 */
export async function createAndCheckoutBranch(
  dir: string,
  branch: string,
  base: string,
): Promise<string | null> {
  try {
    await git(dir, ["checkout", "-b", branch, base]);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Verify a path is git-ignored — a hard precondition before writing secrets. */
export async function isIgnored(dir: string, relPath: string): Promise<boolean> {
  try {
    await git(dir, ["check-ignore", "-q", relPath]);
    return true;
  } catch {
    return false;
  }
}
