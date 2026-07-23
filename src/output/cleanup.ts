/**
 * Post-build cleanup. Screenshots are base64-baked into the HTML before the PDF
 * is rendered (see output/html.ts), so once a PDF exists the raw capture files
 * are pure scratch — regenerable by re-running the flows. Deleting them reclaims
 * the bulk of the disk a run uses (PNGs are large; a PDF is small).
 *
 * What we KEEP is deliberate — everything reusable survives:
 *   .docmcp/output/*.pdf     the docs themselves
 *   .docmcp/flows/*.yaml     hand-editable Maestro chunk flows
 *   .docmcp/skills/**        recipes, auth-flow.yaml
 *   .docmcp/format.json      format/accent config
 *   .docmcp/state.json       the screen graph + baseline (plan/state)
 * What we DELETE is only .docmcp/captures/** (screenshots + capture scratch).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface CleanupResult {
  removed: number;
  bytesFreed: number;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Delete the capture scratch under `capturesDir` (kept as an empty directory so
 * the next run can write straight into it). Best-effort: a file that can't be
 * removed is skipped, never fatal — the PDF is already safely written.
 */
export async function cleanupCaptures(capturesDir: string): Promise<CleanupResult> {
  let removed = 0;
  let bytesFreed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(capturesDir);
  } catch {
    return { removed, bytesFreed }; // no captures dir → nothing to do
  }
  for (const name of entries) {
    const full = path.join(capturesDir, name);
    try {
      const st = await fs.stat(full);
      bytesFreed += await dirSize(full, st);
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* skip anything we can't stat/remove */
    }
  }
  return { removed, bytesFreed };
}

async function dirSize(full: string, st: import("node:fs").Stats): Promise<number> {
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    for (const name of await fs.readdir(full)) {
      try {
        const child = path.join(full, name);
        total += await dirSize(child, await fs.stat(child));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return total;
}

/** One-line summary for the tool result, or null when nothing was freed. */
export function cleanupLine(res: CleanupResult): string | null {
  if (res.removed === 0) return null;
  return `🧹 Cleaned ${res.removed} capture file${res.removed === 1 ? "" : "s"} (${humanBytes(res.bytesFreed)} freed) — screenshots are embedded in the PDF; flows, recipes & plans kept.`;
}
