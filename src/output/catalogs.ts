/**
 * Cross-cutting catalogs — aggregate the per-screen annotation corpus into
 * app-wide reference tables so the per-screen pages can stay concise and point
 * here. Each catalog lists a distinct entity (endpoint, storage key, event…)
 * once, with the screens that use it.
 *
 * Pure: takes the screen graph + the loaded annotations map and returns
 * structured rows. Rendering lives in visualFlow.ts.
 */
import { DocState } from "../util/types.js";
import { ScreenAnnotation } from "./annotations.js";

export interface ApiCatalogRow {
  method: string;
  path: string;
  screens: string[];
}
export interface StorageCatalogRow {
  key: string;
  api: string;
  access: string;
  screens: string[];
}
export interface DataModelCatalogRow {
  name: string;
  source: string;
  screens: string[];
}
export interface DeepLinkCatalogRow {
  link: string;
  params: string[];
  routesTo: string;
  screens: string[];
}
export interface AnalyticsCatalogRow {
  event: string;
  screens: string[];
}
export interface NotificationCatalogRow {
  source: string;
  kind: string;
  screens: string[];
}

export interface Catalogs {
  apis: ApiCatalogRow[];
  storage: StorageCatalogRow[];
  dataModels: DataModelCatalogRow[];
  deepLinks: DeepLinkCatalogRow[];
  analytics: AnalyticsCatalogRow[];
  notifications: NotificationCatalogRow[];
}

/** Accumulate a screen title under a keyed row, creating the row on first sight. */
class Agg<T extends { screens: string[] }> {
  private map = new Map<string, T>();
  add(key: string, make: () => T, screen: string): T {
    let row = this.map.get(key);
    if (!row) {
      row = make();
      this.map.set(key, row);
    }
    if (!row.screens.includes(screen)) row.screens.push(screen);
    return row;
  }
  rows(sortKey: (t: T) => string): T[] {
    return [...this.map.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }
}

export function buildCatalogs(
  state: DocState,
  annotations: Record<string, ScreenAnnotation>,
): Catalogs {
  const apis = new Agg<ApiCatalogRow>();
  const storage = new Agg<StorageCatalogRow>();
  const dataModels = new Agg<DataModelCatalogRow>();
  const deepLinks = new Agg<DeepLinkCatalogRow>();
  const analytics = new Agg<AnalyticsCatalogRow>();
  const notifications = new Agg<NotificationCatalogRow>();

  for (const node of state.screenGraph.nodes) {
    const a = annotations[node.id];
    if (!a) continue;
    const title = node.title;

    for (const x of a.apis ?? []) {
      const method = (x.method ?? "").toUpperCase();
      apis.add(`${method} ${x.path}`, () => ({ method: method || "—", path: x.path, screens: [] }), title);
    }
    for (const s of a.storage ?? []) {
      const key = `${s.api ?? "?"}:${s.key}`;
      const row = storage.add(
        key,
        () => ({ key: s.key, api: s.api ?? "—", access: s.access ?? "—", screens: [] }),
        title,
      );
      // Same key seen with the other access mode → widen to read/write.
      if (s.access && row.access !== "—" && row.access !== s.access) row.access = "read/write";
    }
    for (const m of a.dataModels ?? []) {
      dataModels.add(m.name, () => ({ name: m.name, source: m.source ?? "—", screens: [] }), title);
    }
    for (const d of a.deepLinks ?? []) {
      deepLinks.add(
        d.link,
        () => ({ link: d.link, params: d.params ?? [], routesTo: d.routesTo ?? "—", screens: [] }),
        title,
      );
    }
    for (const e of a.analytics ?? []) {
      analytics.add(e.event, () => ({ event: e.event, screens: [] }), title);
    }
    for (const n of a.notifications ?? []) {
      const source = n.source ?? "—";
      const kind = n.kind ?? "—";
      notifications.add(`${source}:${kind}`, () => ({ source, kind, screens: [] }), title);
    }
  }

  return {
    apis: apis.rows((r) => `${r.path} ${r.method}`),
    storage: storage.rows((r) => r.key),
    dataModels: dataModels.rows((r) => r.name),
    deepLinks: deepLinks.rows((r) => r.link),
    analytics: analytics.rows((r) => r.event),
    notifications: notifications.rows((r) => `${r.source} ${r.kind}`),
  };
}

/** True when at least one catalog has rows (so we know whether to render any). */
export function hasAnyCatalog(c: Catalogs): boolean {
  return (
    c.apis.length > 0 ||
    c.storage.length > 0 ||
    c.dataModels.length > 0 ||
    c.deepLinks.length > 0 ||
    c.analytics.length > 0 ||
    c.notifications.length > 0
  );
}
