/**
 * set_credential — store one secret (login, test ID, API key) by key.
 *
 * The value goes straight into `.docmcp/secrets.local.json`, which is verified
 * git-ignored first. The value is never echoed back, never committed, and never
 * enters the generated documentation — only its key is referenced elsewhere.
 */
import { z } from "zod";
import { setSecret } from "../state/secrets.js";
import { text, errorText, resolveProjectRoot } from "../util/result.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const setCredentialSchema = {
  key: z.string().min(1).describe('Secret key, e.g. "auth.email", "tester-1.password", "api.key".'),
  value: z.string().min(1).describe("Secret value. Stored locally, gitignored, never committed."),
  projectRoot: z.string().optional().describe("Project path. Defaults to the server's cwd."),
};

export async function setCredential(args: {
  key: string;
  value: string;
  projectRoot?: string;
}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  try {
    await setSecret(projectRoot, args.key, args.value);
    return text(
      `Stored secret \`${args.key}\` in .docmcp/secrets.local.json (git-ignored). ` +
        `Value is not committed and will not appear in generated docs.`,
    );
  } catch (err) {
    return errorText(`Could not store secret: ${(err as Error).message}`);
  }
}
