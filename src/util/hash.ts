/** Content hashing for screen source files — powers update-flow drift detection. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

/** Stable short hash of a set of files' contents (order-independent). */
export async function hashFiles(files: string[]): Promise<string> {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    try {
      h.update(await fs.readFile(f));
      h.update("\0");
    } catch {
      h.update("\0missing\0");
    }
  }
  return h.digest("hex").slice(0, 12);
}
