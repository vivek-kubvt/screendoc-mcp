/**
 * Screen-graph builder for expo-router (file-based routing).
 *
 * Walks the router directory and applies expo-router conventions to turn files
 * into screen nodes with real route paths. Building the full screen list *up
 * front* is the key idea: "capture everything" becomes a checklist enforced by
 * the coverage gate, not a hope that exploration stumbles onto every screen.
 *
 * Conventions handled:
 *   (group)/      → route group, contributes no path segment
 *   [param]       → dynamic segment → :param
 *   [...rest]     → catch-all → *rest
 *   index         → the folder's index route
 *   _layout       → navigator config, not a screen (parsed for tab edges later)
 *   +not-found, +native-intent, +html → framework files, skipped
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ScreenGraph, ScreenNode, ScreenEdge } from "../util/types.js";

const ROUTE_EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);

function isSpecialFile(base: string): boolean {
  return base.startsWith("+") || base === "_layout";
}

/** Turn a filename segment into its route contribution (null if it adds none). */
function segmentToRoute(segment: string): string | null {
  if (segment.startsWith("(") && segment.endsWith(")")) return null; // group
  if (segment === "index") return ""; // index route
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `*${catchAll[1]}`;
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

/** A human title from a route id: "settings/profile" → "Settings / Profile". */
function titleFromId(id: string): string {
  return id
    .split("/")
    .map((seg) =>
      seg
        .replace(/^\(|\)$/g, "")
        .replace(/^\[\.\.\.|\]$/g, "")
        .replace(/^\[|\]$/g, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim(),
    )
    .filter(Boolean)
    .join(" / ") || "Index";
}

interface RawRoute {
  id: string; // stable id: relative path without extension, e.g. "(tabs)/feed/index"
  route: string; // resolved route path, e.g. "/(tabs)/feed"
  file: string; // absolute source file
  group: string | null; // nearest (group) it belongs to
}

async function walk(
  dir: string,
  rootDir: string,
  segments: string[],
  currentGroup: string | null,
  out: RawRoute[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      const seg = segmentToRoute(entry.name);
      const nextSegments = seg === null ? segments : [...segments, seg];
      const nextGroup = isGroup ? entry.name : currentGroup;
      await walk(full, rootDir, nextSegments, nextGroup, out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!ROUTE_EXTS.has(ext)) continue;
    const base = entry.name.slice(0, -ext.length);
    if (isSpecialFile(base)) continue;

    const seg = segmentToRoute(base);
    const routeSegments = seg === null || seg === "" ? segments : [...segments, seg];
    const route = "/" + routeSegments.filter(Boolean).join("/");
    const relNoExt = path.relative(rootDir, full).slice(0, -ext.length);
    out.push({
      id: relNoExt,
      route: route === "/" ? "/" : route,
      file: full,
      group: currentGroup,
    });
  }
}

/**
 * Build the screen graph from an expo-router directory.
 * `overlaysFor` and `statesFor` inject per-screen overlays/states discovered by
 * the source scan (see overlayScan.ts) so nodes arrive fully populated.
 */
export async function buildExpoRouterGraph(
  routerDir: string,
  enrich?: (file: string) => Promise<{ overlays: string[]; states: string[] }>,
): Promise<ScreenGraph> {
  const raw: RawRoute[] = [];
  await walk(routerDir, routerDir, [], null, raw);
  raw.sort((a, b) => a.id.localeCompare(b.id));

  const nodes: ScreenNode[] = [];
  for (const r of raw) {
    const extra = enrich ? await enrich(r.file) : { overlays: [], states: [] };
    const states = ["default", ...extra.states.filter((s) => s !== "default")];
    const captured: Record<string, string | null> = {};
    for (const s of states) captured[s] = null;
    nodes.push({
      id: r.id.replace(/\\/g, "/"),
      title: titleFromId(r.id),
      route: r.route,
      sourceFiles: [r.file],
      states,
      overlays: extra.overlays,
      captured,
      contentHash: null,
      requires: r.group === "(auth)" ? [] : inferRequires(r),
    });
  }

  const edges = inferTabEdges(nodes);
  return { nodes, edges };
}

/** Screens outside the auth group generally require a logged-in session. */
function inferRequires(r: RawRoute): string[] {
  if (r.group === "(auth)") return [];
  return ["auth"];
}

/**
 * Lightweight edge inference: every tab screen is reachable from the tab bar.
 * Deeper navigation edges (button → screen) are added by the capture engine as
 * it learns paths; this seeds the obvious structural ones.
 */
function inferTabEdges(nodes: ScreenNode[]): ScreenEdge[] {
  const edges: ScreenEdge[] = [];
  const tabRoots = nodes.filter((n) => /\(tabs\)\/[^/]+\/index$/.test(n.id));
  for (const t of tabRoots) {
    const tabName = t.id.replace(/\(tabs\)\//, "").replace(/\/index$/, "");
    edges.push({ from: "(tabs)", to: t.id, via: `${tabName} tab` });
  }
  return edges;
}
