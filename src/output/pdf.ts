/**
 * HTML → PDF via headless Chrome (no heavy Playwright/Chromium download).
 * Writes the HTML to a temp file and runs Chrome's --print-to-pdf.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { run } from "../util/exec.js";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

async function findChrome(): Promise<string | null> {
  for (const c of CHROME_CANDIDATES) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function htmlToPdf(html: string, outPdf: string): Promise<{ ok: boolean; reason?: string }> {
  const chrome = await findChrome();
  if (!chrome) {
    return { ok: false, reason: "No Chrome/Chromium/Edge found for PDF rendering." };
  }
  const tmpHtml = path.join(os.tmpdir(), `docmcp-${process.pid}-${Date.now()}.html`);
  await fs.writeFile(tmpHtml, html, "utf8");
  await fs.mkdir(path.dirname(outPdf), { recursive: true });

  const res = await run(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--no-sandbox",
      `--print-to-pdf=${outPdf}`,
      `file://${tmpHtml}`,
    ],
    { timeoutMs: 120_000 },
  );
  await fs.rm(tmpHtml, { force: true });

  try {
    const stat = await fs.stat(outPdf);
    if (stat.size > 0) return { ok: true };
  } catch {
    /* fall through */
  }
  return { ok: false, reason: `Chrome print failed (exit ${res.code}): ${res.stderr.slice(-300)}` };
}
