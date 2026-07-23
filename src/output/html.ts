/**
 * Documentation HTML builder. Produces a print-ready HTML document from state +
 * captured screenshots: cover, optional changelog, table of contents, one
 * section per screen (screenshots + metadata), and an appendix. Screenshots are
 * embedded as data URIs so the PDF renders with zero external dependencies.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DocState, ScreenNode } from "../util/types.js";
import { DocFormat, FORMATS, DEFAULT_FORMAT } from "./formats.js";
import type { ScreenAnnotation } from "./annotations.js";

export interface ChangelogEntry {
  date: string;
  commit: string | null;
  screens: string[];
  notes: string[];
}

export interface BuildDocOptions {
  capturesDir: string;
  /** Screen ids marked UPDATED in this build (update flow). */
  updatedScreens?: Set<string>;
  /** Changelog entries to render up front (update flow). */
  changelog?: ChangelogEntry[];
  kind: "create" | "update";
  version: number;
  commit: string | null;
  date: string;
  /** The named format to render with. Defaults to the `default` preset. */
  format?: DocFormat;
  /** Project root — lets renderers show repo-relative source paths + line counts. */
  projectRoot?: string;
  /** Per-screen rich content (Purpose, Navigation, UI elements…), keyed by id. */
  annotations?: Record<string, ScreenAnnotation>;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

async function imgTag(capturesDir: string, node: ScreenNode, state: string): Promise<string | null> {
  const file = path.join(capturesDir, `${node.id.replace(/\//g, "__")}__${state}.png`);
  try {
    const buf = await fs.readFile(file);
    const b64 = buf.toString("base64");
    return `<figure class="shot"><img alt="${esc(node.title)} — ${esc(state)}" src="data:image/png;base64,${b64}"/><figcaption>${esc(state)}</figcaption></figure>`;
  } catch {
    return null;
  }
}

async function screenSection(
  node: ScreenNode,
  opts: BuildDocOptions,
): Promise<string> {
  const shots: string[] = [];
  for (const st of node.states) {
    const tag = await imgTag(opts.capturesDir, node, st);
    if (tag) shots.push(tag);
  }
  const updated = opts.updatedScreens?.has(node.id);
  const capturedDates = Object.values(node.captured).filter(Boolean) as string[];
  const captureDate = capturedDates.sort().slice(-1)[0] ?? "—";

  const badge = updated
    ? `<span class="badge updated">UPDATED ${esc(opts.date)}</span>`
    : "";
  const blocked = node.blocked
    ? `<p class="blocked">⚠️ Not fully captured: ${esc(node.blocked.reason)}</p>`
    : "";
  const overlays = node.overlays.length
    ? `<tr><th>Overlays</th><td>${node.overlays.map(esc).join(", ")}</td></tr>`
    : "";
  const requires = node.requires.length
    ? `<tr><th>Requires</th><td>${node.requires.map(esc).join(", ")}</td></tr>`
    : "";

  return `
  <section class="screen" id="scr-${esc(node.id)}">
    <h2>${esc(node.title)} ${badge}</h2>
    <table class="meta">
      <tr><th>Route</th><td><code>${esc(node.route ?? "—")}</code></td></tr>
      <tr><th>Source</th><td>${node.sourceFiles.map((f) => `<code>${esc(path.basename(f))}</code>`).join(" ")}</td></tr>
      <tr><th>States</th><td>${node.states.map(esc).join(", ")}</td></tr>
      ${overlays}
      ${requires}
      <tr><th>Captured</th><td>${esc(captureDate)}</td></tr>
    </table>
    ${blocked}
    <div class="shots">${shots.join("\n") || '<p class="nocap">No screenshot captured.</p>'}</div>
  </section>`;
}

function changelogHtml(entries: ChangelogEntry[]): string {
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) => `
      <div class="cl-entry">
        <div class="cl-date">${esc(e.date)}${e.commit ? ` · <code>${esc(e.commit)}</code>` : ""}</div>
        <div class="cl-body">
          <div><strong>Screens updated:</strong> ${e.screens.map(esc).join(", ") || "—"}</div>
          ${e.notes.length ? `<ul>${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        </div>
      </div>`,
    )
    .join("");
  return `<section class="changelog page-break"><h1>Changelog</h1>${rows}</section>`;
}

export async function buildDocumentHtml(state: DocState, opts: BuildDocOptions): Promise<string> {
  const fmt = opts.format ?? FORMATS[DEFAULT_FORMAT];
  const c = fmt.colors;
  const sections: string[] = [];
  for (const node of state.screenGraph.nodes) {
    sections.push(await screenSection(node, opts));
  }

  const toc = state.screenGraph.nodes
    .map((n) => `<li><a href="#scr-${esc(n.id)}">${esc(n.title)}</a> <span class="toc-route">${esc(n.route ?? "")}</span></li>`)
    .join("");

  const engines = state.project.captureEngines.join(", ") || "—";
  const coverRows = [
    `<dt>Version</dt><dd>v${opts.version} (${esc(opts.kind)})</dd>`,
    `<dt>Generated</dt><dd>${esc(opts.date)}</dd>`,
    `<dt>Commit</dt><dd><code>${esc(opts.commit ?? "—")}</code></dd>`,
    fmt.cover.showFrameworks
      ? `<dt>Frameworks</dt><dd>${esc(state.project.frameworks.join(", ") || "—")}</dd>`
      : "",
    fmt.cover.showEngines ? `<dt>Capture engines</dt><dd>${esc(engines)}</dd>` : "",
  ].join("\n      ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(state.project.name)} — Documentation v${opts.version}</title>
<style>
  :root { --ink:${c.ink}; --muted:${c.muted}; --accent:${c.accent}; --line:${c.line}; --soft:${c.soft}; --badge-bg:${c.badgeBg}; --badge-ink:${c.badgeInk}; --body-font:${fmt.fonts.body}; --mono-font:${fmt.fonts.mono}; }
  * { box-sizing: border-box; }
  body { font: 14px/1.6 var(--body-font); color: var(--ink); margin: 0; }
  code { font-family: var(--mono-font); font-size: .9em; background: var(--soft); padding: .05em .35em; border-radius: 4px; }
  .page-break { break-before: page; }
  .cover { min-height: 96vh; display: flex; flex-direction: column; justify-content: center; padding: ${fmt.layout.pagePadding}; }
  .cover h1 { font-size: 2.6rem; margin: 0 0 .3rem; letter-spacing: -.02em; }
  .cover .sub { color: var(--muted); font-size: 1.1rem; }
  .cover dl { margin-top: 2rem; display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1.2rem; font-size: .95rem; }
  .cover dt { color: var(--muted); }
  .accent { color: var(--accent); }
  h1 { font-size: 1.8rem; }
  .toc { padding: 2rem ${fmt.layout.pagePadding}; }
  .toc h1 { border-bottom: 2px solid var(--accent); padding-bottom: .3rem; }
  .toc ol { columns: ${fmt.layout.tocColumns}; column-gap: 2.5rem; font-size: .9rem; padding-left: 1.2rem; }
  .toc li { margin: .2rem 0; break-inside: avoid; }
  .toc a { color: var(--ink); text-decoration: none; }
  .toc-route { color: var(--muted); font-family: var(--mono-font); font-size: .8em; }
  .content { padding: 0 ${fmt.layout.pagePadding}; }
  .screen { break-inside: avoid; padding: 1.6rem 0; border-top: 1px solid var(--line); }
  .screen h2 { font-size: 1.3rem; margin: 0 0 .6rem; }
  table.meta { border-collapse: collapse; font-size: .85rem; margin-bottom: .8rem; }
  table.meta th { text-align: left; color: var(--muted); font-weight: 600; padding: .15rem .8rem .15rem 0; vertical-align: top; white-space: nowrap; }
  table.meta td { padding: .15rem 0; }
  .shots { display: flex; flex-wrap: wrap; gap: 1rem; }
  figure.shot { margin: 0; text-align: center; }
  figure.shot img { max-height: ${fmt.layout.shotMaxHeight}px; max-width: ${fmt.layout.shotMaxWidth}px; border: 1px solid var(--line); border-radius: 12px; }
  figure.shot figcaption { color: var(--muted); font-size: .78rem; margin-top: .3rem; text-transform: uppercase; letter-spacing: .04em; }
  .badge { font-size: .62rem; font-weight: 700; letter-spacing: .06em; padding: .12rem .5rem; border-radius: 999px; vertical-align: middle; }
  .badge.updated { background: var(--badge-bg); color: var(--badge-ink); }
  .blocked { color: var(--badge-ink); background: var(--badge-bg); padding: .4rem .7rem; border-radius: 6px; font-size: .85rem; }
  .nocap { color: var(--muted); font-style: italic; }
  .changelog { padding: 2rem ${fmt.layout.pagePadding}; }
  .cl-entry { display: grid; grid-template-columns: 10rem 1fr; gap: 1rem; padding: .7rem 0; border-top: 1px solid var(--line); }
  .cl-date { color: var(--muted); font-size: .85rem; }
  footer { color: var(--muted); font-size: .75rem; text-align: center; padding: 2rem; }
</style></head>
<body>
  <div class="cover">
    <div class="accent" style="font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:.8rem">${esc(fmt.cover.eyebrow)}</div>
    <h1>${esc(state.project.name)}</h1>
    <div class="sub">${esc(state.project.platform)} · ${state.screenGraph.nodes.length} screens</div>
    <dl>
      ${coverRows}
    </dl>
  </div>
  ${changelogHtml(opts.changelog ?? [])}
  <nav class="toc page-break"><h1>Screens</h1><ol>${toc}</ol></nav>
  <div class="content page-break">${sections.join("\n")}</div>
  <footer>Generated by doc-mcp · ${esc(state.project.name)} · v${opts.version} · ${esc(opts.date)}</footer>
</body></html>`;
}
