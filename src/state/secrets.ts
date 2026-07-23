/**
 * Secrets store — logins, test IDs, API keys the tool needs to drive an app.
 *
 * Kept in `<project>/.docmcp/secrets.local.json`, which is force-added to
 * `.gitignore`. state.json and skills reference these by KEY only; the values
 * never enter git, never enter the generated PDF, and are read only at the
 * moment a screen needs them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DOCMCP_DIR, SECRETS_FILE } from "../util/types.js";
import { isGitRepo, isIgnored } from "../util/git.js";

export interface SecretStore {
  [key: string]: string;
}

function secretsPath(projectRoot: string): string {
  return path.join(projectRoot, DOCMCP_DIR, SECRETS_FILE);
}

/**
 * Guarantee `.docmcp/secrets.local.json` is git-ignored before anything is
 * written into it. Appends a rule to the project's root `.gitignore` if needed.
 * Returns true when the file is confirmed ignored (or the project isn't a repo).
 */
export async function ensureSecretsIgnored(projectRoot: string): Promise<boolean> {
  if (!(await isGitRepo(projectRoot))) return true; // folder mode: nothing to leak into

  const rel = `${DOCMCP_DIR}/${SECRETS_FILE}`;
  if (await isIgnored(projectRoot, rel)) return true;

  const gitignore = path.join(projectRoot, ".gitignore");
  const marker = `\n# doc-mcp: never commit captured credentials\n${rel}\n`;
  let existing = "";
  try {
    existing = await fs.readFile(gitignore, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (!existing.includes(rel)) {
    await fs.writeFile(gitignore, existing + marker, "utf8");
  }
  return isIgnored(projectRoot, rel);
}

export async function loadSecrets(projectRoot: string): Promise<SecretStore> {
  try {
    const raw = await fs.readFile(secretsPath(projectRoot), "utf8");
    return JSON.parse(raw) as SecretStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function setSecret(
  projectRoot: string,
  key: string,
  value: string,
): Promise<{ ignored: boolean }> {
  const ignored = await ensureSecretsIgnored(projectRoot);
  if (!ignored) {
    throw new Error(
      "Refusing to write secrets: could not confirm .docmcp/secrets.local.json is git-ignored. " +
        "Add it to .gitignore manually and retry.",
    );
  }
  const dir = path.join(projectRoot, DOCMCP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const store = await loadSecrets(projectRoot);
  store[key] = value;
  const target = secretsPath(projectRoot);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
  return { ignored };
}

/** Which of the required keys are missing from the store. */
export async function missingSecrets(
  projectRoot: string,
  requiredKeys: string[],
): Promise<string[]> {
  const store = await loadSecrets(projectRoot);
  return requiredKeys.filter((k) => !(k in store) || store[k] === "");
}
