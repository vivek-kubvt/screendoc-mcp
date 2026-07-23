/**
 * Visual-flow document template — one screen per page, laid out as a device
 * frame beside a source-linked breakdown (metadata table, Purpose, Navigation,
 * UI elements, Labels & data binding), with a running footer + page numbers.
 *
 * A device-frame-plus-source-map reference layout with a running footer. The rich
 * sections render only when a screen has an annotation (see annotations.ts); a
 * screen with no annotation still gets its device frame + metadata (route,
 * source file + line count, states) and a hint pointing to where to author more.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DocState, ScreenNode } from "../util/types.js";
import { FORMATS, DEFAULT_FORMAT } from "./formats.js";
import { annotationKey, ScreenAnnotation } from "./annotations.js";
import { buildCatalogs, Catalogs, hasAnyCatalog } from "./catalogs.js";
import type { BuildDocOptions, ChangelogEntry } from "./html.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/** Screenshot as a data URI, or null if that state was never captured. */
async function shotDataUri(capturesDir: string, node: ScreenNode, state: string): Promise<string | null> {
  const file = path.join(capturesDir, `${node.id.replace(/\//g, "__")}__${state}.png`);
  try {
    const buf = await fs.readFile(file);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function lineCount(file: string): Promise<number | null> {
  try {
    const src = await fs.readFile(file, "utf8");
    return src.split("\n").length;
  } catch {
    return null;
  }
}

/** Source file cell: repo-relative path + line count, e.g. "src/app/x.tsx (578 lines)". */
async function sourceCell(node: ScreenNode, projectRoot?: string): Promise<string> {
  const file = node.sourceFiles[0];
  if (!file) return "—";
  const rel = projectRoot ? path.relative(projectRoot, file) : path.basename(file);
  const lines = await lineCount(file);
  return `<code>${esc(rel)}</code>${lines != null ? ` (${lines} lines)` : ""}`;
}

function metaTable(rows: Array<[string, string | null]>): string {
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`)
    .join("");
  return `<table class="vf-meta">${body}</table>`;
}

function purposeSection(a?: ScreenAnnotation): string {
  if (!a?.purpose) return "";
  return `<h3 class="vf-h">Purpose</h3><p class="vf-prose">${esc(a.purpose)}</p>`;
}

function navSection(a?: ScreenAnnotation): string {
  const nav = a?.navigation;
  if (!nav || (!nav.entryPoints?.length && !nav.exits?.length)) return "";
  const entry = nav.entryPoints?.length
    ? `<p class="vf-prose"><strong>Entry points:</strong> ${nav.entryPoints.map(esc).join(", ")}.</p>`
    : "";
  const exits = nav.exits?.length
    ? `<p class="vf-prose"><strong>Exits:</strong></p><ul class="vf-list">${nav.exits
        .map(
          (e) =>
            `<li><strong>${esc(e.label)}</strong>` +
            (e.handler ? ` → <code>${esc(e.handler)}</code>` : "") +
            (e.line != null ? ` (<code>:${e.line}</code>)` : "") +
            (e.note ? ` — ${esc(e.note)}` : "") +
            `</li>`,
        )
        .join("")}</ul>`
    : "";
  return `<h3 class="vf-h">Navigation</h3>${entry}${exits}`;
}

function uiElementsSection(a?: ScreenAnnotation): string {
  if (!a?.uiElements?.length) return "";
  const rows = a.uiElements
    .map(
      (u) =>
        `<tr><td>${esc(u.element)}</td><td>${u.handler ? `<code>${esc(u.handler)}</code>` : "—"}</td><td>${esc(u.does ?? "")}</td></tr>`,
    )
    .join("");
  return (
    `<h3 class="vf-h">UI Elements &amp; Buttons</h3>` +
    `<table class="vf-table"><thead><tr><th>Element</th><th>Handler</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function labelsSection(a?: ScreenAnnotation): string {
  if (!a?.labels?.length) return "";
  const rows = a.labels
    .map((l) => `<tr><td>${esc(l.label)}</td><td>${l.binding ? `<code>${esc(l.binding)}</code>` : "—"}</td></tr>`)
    .join("");
  return (
    `<h3 class="vf-h">Labels &amp; Data Binding</h3>` +
    `<table class="vf-table"><thead><tr><th>Label</th><th>Bound to</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

/** Render a titled table from headers + rows of cells; empty rows → "". */
function tableSection(title: string, headers: string[], rows: string[][]): string {
  if (!rows.length) return "";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return (
    `<h3 class="vf-h">${title}</h3>` +
    `<table class="vf-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  );
}

function code(s?: string): string {
  return s ? `<code>${esc(s)}</code>` : "—";
}

function withLine(s: string, line?: number): string {
  return line != null ? `${s} <span class="vf-ln">:${line}</span>` : s;
}

function popupsSection(a?: ScreenAnnotation): string {
  if (!a?.popups?.length) return "";
  return tableSection(
    "Popups, Modals &amp; Alerts",
    ["Trigger", "Kind", "Buttons"],
    a.popups.map((p) => [
      withLine(esc(p.trigger), p.line) + (p.screenshot ? ` 📷` : ""),
      esc(p.kind ?? "—"),
      p.buttons?.length
        ? p.buttons.map((b) => `<strong>${esc(b.label)}</strong>${b.does ? ` — ${esc(b.does)}` : ""}`).join("<br/>")
        : "—",
    ]),
  );
}

function apisSection(a?: ScreenAnnotation): string {
  if (!a?.apis?.length) return "";
  return tableSection(
    "APIs Called",
    ["Method", "Path", "When", "Response fields"],
    a.apis.map((x) => [
      esc(x.method?.toUpperCase() ?? "—"),
      withLine(code(x.path), x.line),
      esc(x.when ?? "—"),
      x.responseFields?.length ? x.responseFields.map((f) => code(f)).join(" ") : "—",
    ]),
  );
}

function dataModelsSection(a?: ScreenAnnotation): string {
  if (!a?.dataModels?.length) return "";
  return tableSection(
    "Data Models",
    ["Type", "Source", "Fields"],
    a.dataModels.map((m) => [
      code(m.name),
      m.source ? code(m.source) : "—",
      m.fields?.length
        ? m.fields.map((f) => `${code(f.name)}${f.type ? `: <em>${esc(f.type)}</em>` : ""}${f.meaning ? ` — ${esc(f.meaning)}` : ""}`).join("<br/>")
        : "—",
    ]),
  );
}

function storageSection(a?: ScreenAnnotation): string {
  if (!a?.storage?.length) return "";
  return tableSection(
    "Local Storage",
    ["Key", "API", "Access", "Value"],
    a.storage.map((s) => [withLine(code(s.key), s.line), esc(s.api ?? "—"), esc(s.access ?? "—"), esc(s.value ?? "—")]),
  );
}

function notificationsSection(a?: ScreenAnnotation): string {
  if (!a?.notifications?.length) return "";
  return tableSection(
    "Notifications",
    ["Kind", "Source", "Trigger", "Routes to"],
    a.notifications.map((n) => [
      esc(n.kind ?? "—"),
      esc(n.source ?? "—"),
      withLine(esc(n.trigger ?? "—"), n.line),
      n.routesTo ? code(n.routesTo) : "—",
    ]),
  );
}

function deepLinksSection(a?: ScreenAnnotation): string {
  if (!a?.deepLinks?.length) return "";
  return tableSection(
    "Deep Links",
    ["Link", "Params", "Routes to"],
    a.deepLinks.map((d) => [
      withLine(code(d.link), d.line),
      d.params?.length ? d.params.map((p) => code(p)).join(" ") : "—",
      d.routesTo ? code(d.routesTo) : "—",
    ]),
  );
}

function analyticsSection(a?: ScreenAnnotation): string {
  if (!a?.analytics?.length) return "";
  return tableSection(
    "Analytics Events",
    ["Event", "Attributes", "Trigger"],
    a.analytics.map((e) => [withLine(code(e.event), e.line), esc(e.attributes ?? "—"), esc(e.trigger ?? "—")]),
  );
}

function stateBranchesSection(a?: ScreenAnnotation): string {
  if (!a?.stateBranches?.length) return "";
  const items = a.stateBranches
    .map(
      (s) =>
        `<li>${s.contextOrStore ? `${code(s.contextOrStore)} · ` : ""}` +
        `${withLine(`<code>${esc(s.condition)}</code>`, s.line)}${s.uiEffect ? ` → ${esc(s.uiEffect)}` : ""}</li>`,
    )
    .join("");
  return `<h3 class="vf-h">State &amp; Logic Branches</h3><ul class="vf-list">${items}</ul>`;
}

function nativeModulesSection(a?: ScreenAnnotation): string {
  if (!a?.nativeModules?.length) return "";
  const items = a.nativeModules
    .map((m) => `<li>${withLine(`<code>${esc(m.module)}</code>`, m.line)}${m.usage ? ` — ${esc(m.usage)}` : ""}</li>`)
    .join("");
  return `<h3 class="vf-h">Native Module Usage</h3><ul class="vf-list">${items}</ul>`;
}

async function screenPage(
  node: ScreenNode,
  index: number,
  opts: BuildDocOptions,
  projectName: string,
): Promise<string> {
  const a = opts.annotations?.[node.id];
  const updated = opts.updatedScreens?.has(node.id);

  // Device frame shows the default state; other captured states become thumbnails.
  const primary = await shotDataUri(opts.capturesDir, node, "default");
  const device = primary
    ? `<div class="vf-device"><img alt="${esc(node.title)}" src="${primary}"/></div>`
    : `<div class="vf-device vf-device--empty"><span>No screenshot captured</span></div>`;

  const otherStates = node.states.filter((s) => s !== "default");
  const thumbs: string[] = [];
  for (const st of otherStates) {
    const uri = await shotDataUri(opts.capturesDir, node, st);
    if (uri) {
      thumbs.push(`<figure class="vf-thumb"><img alt="${esc(st)}" src="${uri}"/><figcaption>${esc(st)}</figcaption></figure>`);
    }
  }
  const thumbsBlock = thumbs.length ? `<div class="vf-thumbs">${thumbs.join("")}</div>` : "";

  const source = await sourceCell(node, opts.projectRoot);
  const meta = metaTable([
    ["Route", `<code>${esc(node.route ?? "—")}</code>`],
    ["Source file", source],
    ["Layout", a?.layout ? esc(a.layout) : null],
    ["Legacy parity", a?.legacyParity ? esc(a.legacyParity) : null],
    ["States", node.states.map(esc).join(", ")],
  ]);

  const badge = updated ? `<span class="vf-badge">UPDATED ${esc(opts.date)}</span>` : "";
  const blocked = node.blocked
    ? `<p class="vf-blocked">⚠️ Not fully captured: ${esc(node.blocked.reason)}</p>`
    : "";

  const richSections = [
    purposeSection(a),
    navSection(a),
    uiElementsSection(a),
    labelsSection(a),
    popupsSection(a),
    apisSection(a),
    dataModelsSection(a),
    storageSection(a),
    notificationsSection(a),
    deepLinksSection(a),
    analyticsSection(a),
    stateBranchesSection(a),
    nativeModulesSection(a),
  ].join("");
  const noContentHint = a
    ? ""
    : `<p class="vf-hint">Add <code>.docmcp/annotations/${esc(annotationKey(node.id))}.json</code> ` +
      `to document purpose, navigation, UI elements, and data bindings.</p>`;

  return `
  <section class="vf-page">
    <div class="vf-bar"></div>
    <header class="vf-head">
      <h1>${esc(node.title)} ${badge}</h1>
      <div class="vf-route"><code>${esc(node.route ?? "")}</code></div>
    </header>
    <div class="vf-body">
      <div class="vf-left">
        ${device}
        ${thumbsBlock}
      </div>
      <div class="vf-right">
        ${meta}
        ${blocked}
        ${richSections}
        ${noContentHint}
      </div>
    </div>
    <footer class="vf-footer"><span>${esc(projectName)} — Visual Flow Documentation</span><span>p. ${index + 1}</span></footer>
  </section>`;
}

function changelogPage(entries: ChangelogEntry[], projectName: string, pageNo: number): string {
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) =>
        `<div class="vf-cl-entry"><div class="vf-cl-date">${esc(e.date)}${e.commit ? ` · <code>${esc(e.commit)}</code>` : ""}</div>` +
        `<div><strong>Screens updated:</strong> ${e.screens.map(esc).join(", ") || "—"}` +
        (e.notes.length ? `<ul class="vf-list">${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "") +
        `</div></div>`,
    )
    .join("");
  return `
  <section class="vf-page">
    <div class="vf-bar"></div>
    <header class="vf-head"><h1>Changelog</h1></header>
    <div class="vf-changelog">${rows}</div>
    <footer class="vf-footer"><span>${esc(projectName)} — Visual Flow Documentation</span><span>p. ${pageNo}</span></footer>
  </section>`;
}

/** A full reference-catalog page: title + subtitle + one wide table. */
function catalogPage(
  title: string,
  subtitle: string,
  headers: string[],
  rows: string[][],
  name: string,
  pageNo: number,
): string {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `
  <section class="vf-page">
    <div class="vf-bar"></div>
    <header class="vf-head"><h1>${esc(title)}</h1><div class="vf-route">${esc(subtitle)}</div></header>
    <table class="vf-table vf-catalog"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <footer class="vf-footer"><span>${esc(name)} — Visual Flow Documentation</span><span>p. ${pageNo}</span></footer>
  </section>`;
}

/** Render every non-empty cross-cutting catalog, numbered from `firstPageNo`. */
function renderCatalogs(cat: Catalogs, name: string, firstPageNo: number): { html: string; count: number } {
  const specs: { title: string; subtitle: string; headers: string[]; rows: string[][] }[] = [];
  const usedBy = (s: string[]) => esc(s.join(", "));

  if (cat.apis.length)
    specs.push({
      title: "API Catalog",
      subtitle: `${cat.apis.length} endpoint${cat.apis.length === 1 ? "" : "s"}`,
      headers: ["Method", "Path", "Used by"],
      rows: cat.apis.map((r) => [esc(r.method), code(r.path), usedBy(r.screens)]),
    });
  if (cat.dataModels.length)
    specs.push({
      title: "Data-Model Catalog",
      subtitle: `${cat.dataModels.length} type${cat.dataModels.length === 1 ? "" : "s"}`,
      headers: ["Type", "Source", "Used by"],
      rows: cat.dataModels.map((r) => [code(r.name), r.source === "—" ? "—" : code(r.source), usedBy(r.screens)]),
    });
  if (cat.storage.length)
    specs.push({
      title: "Storage-Key Catalog",
      subtitle: `${cat.storage.length} key${cat.storage.length === 1 ? "" : "s"}`,
      headers: ["Key", "API", "Access", "Used by"],
      rows: cat.storage.map((r) => [code(r.key), esc(r.api), esc(r.access), usedBy(r.screens)]),
    });
  if (cat.deepLinks.length)
    specs.push({
      title: "Deep-Link Map",
      subtitle: `${cat.deepLinks.length} link${cat.deepLinks.length === 1 ? "" : "s"}`,
      headers: ["Link", "Params", "Routes to", "Used by"],
      rows: cat.deepLinks.map((r) => [
        code(r.link),
        r.params.length ? r.params.map((p) => code(p)).join(" ") : "—",
        r.routesTo === "—" ? "—" : code(r.routesTo),
        usedBy(r.screens),
      ]),
    });
  if (cat.analytics.length)
    specs.push({
      title: "Analytics Events",
      subtitle: `${cat.analytics.length} event${cat.analytics.length === 1 ? "" : "s"}`,
      headers: ["Event", "Fired by"],
      rows: cat.analytics.map((r) => [code(r.event), usedBy(r.screens)]),
    });
  if (cat.notifications.length)
    specs.push({
      title: "Notification Architecture",
      subtitle: `${cat.notifications.length} source${cat.notifications.length === 1 ? "" : "s"}`,
      headers: ["Source", "Kind", "Used by"],
      rows: cat.notifications.map((r) => [esc(r.source), esc(r.kind), usedBy(r.screens)]),
    });

  const html = specs.map((s, idx) => catalogPage(s.title, s.subtitle, s.headers, s.rows, name, firstPageNo + idx)).join("\n");
  return { html, count: specs.length };
}

export async function buildVisualFlowHtml(state: DocState, opts: BuildDocOptions): Promise<string> {
  const fmt = opts.format ?? FORMATS[DEFAULT_FORMAT];
  const c = fmt.colors;
  const name = state.project.name;

  const pages: string[] = [];
  let i = 0;
  for (const node of state.screenGraph.nodes) {
    pages.push(await screenPage(node, i, opts, name));
    i++;
  }

  // Cross-cutting catalogs (after per-screen pages), then changelog — page-numbered continuously.
  const catalogs = buildCatalogs(state, opts.annotations ?? {});
  const cat = hasAnyCatalog(catalogs) ? renderCatalogs(catalogs, name, i + 1) : { html: "", count: 0 };
  const cl = changelogPage(opts.changelog ?? [], name, i + 1 + cat.count);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(name)} — Visual Flow Documentation v${opts.version}</title>
<style>
  :root { --ink:${c.ink}; --muted:${c.muted}; --accent:${c.accent}; --line:${c.line}; --soft:${c.soft}; --badge-bg:${c.badgeBg}; --badge-ink:${c.badgeInk}; --body-font:${fmt.fonts.body}; --mono-font:${fmt.fonts.mono}; }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.55 var(--body-font); color: var(--ink); margin: 0; }
  code { font-family: var(--mono-font); font-size: .88em; color: var(--accent); }
  .vf-ln { font-family: var(--mono-font); font-size: .78em; color: var(--muted); }
  .vf-table em { color: var(--muted); font-style: normal; }
  .vf-page { break-after: page; position: relative; min-height: 96vh; display: flex; flex-direction: column; padding: 0 ${fmt.layout.pagePadding} ${fmt.layout.pagePadding}; }
  .vf-page:last-child { break-after: auto; }
  .vf-bar { height: 12px; background: var(--accent); margin: 0 -${fmt.layout.pagePadding} 2rem; }
  .vf-head h1 { font-size: 1.7rem; margin: 0 0 .15rem; letter-spacing: -.01em; }
  .vf-route code { font-size: 1rem; }
  .vf-body { display: grid; grid-template-columns: ${fmt.layout.shotMaxWidth + 40}px 1fr; gap: 2.5rem; margin-top: 1.5rem; flex: 1; }
  .vf-device { border: 10px solid #111; border-radius: 34px; background: #111; overflow: hidden; align-self: start; max-width: ${fmt.layout.shotMaxWidth + 20}px; }
  .vf-device img { display: block; width: 100%; border-radius: 24px; }
  .vf-device--empty { min-height: ${fmt.layout.shotMaxHeight}px; display: flex; align-items: center; justify-content: center; color: #888; font-style: italic; border-radius: 34px; }
  .vf-thumbs { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .9rem; }
  .vf-thumb { margin: 0; width: 84px; text-align: center; }
  .vf-thumb img { width: 100%; border: 1px solid var(--line); border-radius: 8px; }
  .vf-thumb figcaption { color: var(--muted); font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; margin-top: .2rem; }
  .vf-h { color: var(--accent); font-size: 1.05rem; text-transform: uppercase; letter-spacing: .03em; margin: 1.4rem 0 .5rem; }
  .vf-prose { margin: .3rem 0; }
  .vf-list { margin: .3rem 0 .3rem 0; padding-left: 1.1rem; }
  .vf-list li { margin: .25rem 0; }
  table.vf-meta { border-collapse: collapse; width: 100%; font-size: .9rem; }
  table.vf-meta th, table.vf-meta td { border: 1px solid var(--line); text-align: left; padding: .35rem .7rem; vertical-align: top; }
  table.vf-meta th { color: var(--ink); font-weight: 700; white-space: nowrap; width: 8.5rem; background: var(--soft); }
  table.vf-table { border-collapse: collapse; width: 100%; font-size: .86rem; margin-top: .3rem; }
  table.vf-table th { text-align: left; background: var(--soft); border-bottom: 2px solid var(--line); padding: .4rem .6rem; }
  table.vf-table td { border-bottom: 1px solid var(--line); padding: .35rem .6rem; vertical-align: top; }
  .vf-badge { font-size: .58rem; font-weight: 700; letter-spacing: .06em; padding: .12rem .5rem; border-radius: 999px; background: var(--badge-bg); color: var(--badge-ink); vertical-align: middle; }
  .vf-blocked { color: var(--badge-ink); background: var(--badge-bg); padding: .4rem .7rem; border-radius: 6px; font-size: .85rem; }
  .vf-hint { color: var(--muted); font-style: italic; font-size: .85rem; margin-top: 1.4rem; }
  .vf-footer { margin-top: auto; padding-top: 1.5rem; display: flex; justify-content: space-between; color: var(--muted); font-size: .72rem; border-top: 1px solid var(--line); }
  .vf-cl-entry { display: grid; grid-template-columns: 12rem 1fr; gap: 1rem; padding: .7rem 0; border-top: 1px solid var(--line); }
  .vf-cl-date { color: var(--muted); font-size: .85rem; }
</style></head>
<body>
  ${pages.join("\n")}
  ${cat.html}
  ${cl}
</body></html>`;
}
