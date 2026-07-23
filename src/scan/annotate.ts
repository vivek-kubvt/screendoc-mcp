/**
 * Annotation extractor — a deterministic grep/AST-lite pass over a screen's
 * source file(s) that pre-fills the *mechanical* fields of a ScreenAnnotation:
 * navigation exits, UI handlers, popups, API calls, storage keys, notifications,
 * deep links, analytics events, state branches, and native-module usage — each
 * with the source line number where it was found.
 *
 * It intentionally does NOT invent the semantic fields (Purpose, "what it does",
 * field meanings) — those are authored on top of this skeleton. Re-running the
 * extractor refreshes the mechanical fields without clobbering authored prose
 * (see mergeAnnotations: authored, non-empty values win).
 *
 * Heuristic by design: it reads source text, errs toward listing a candidate,
 * and caps each category so a pathological file can't produce unbounded output.
 */
import { promises as fs } from "node:fs";
import {
  ScreenAnnotation,
  ANNOTATION_LIST_KEYS,
  NavExit,
  UiElement,
  Popup,
  ApiCall,
  StorageAccess,
  NotificationRef,
  DeepLinkRef,
  AnalyticsEvent,
  StateBranch,
  NativeModuleUse,
} from "../output/annotations.js";

const MAX_PER_CATEGORY = 60;

interface Line {
  file: string;
  n: number;
  text: string;
}

async function readLines(files: string[]): Promise<Line[]> {
  const out: Line[] = [];
  for (const file of files) {
    let src = "";
    try {
      src = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    src.split("\n").forEach((text, i) => out.push({ file, n: i + 1, text }));
  }
  return out;
}

/** First string literal on a line (single, double, or backtick quotes). */
function firstString(text: string): string | undefined {
  const m = text.match(/["'`]([^"'`\n]+)["'`]/);
  return m?.[1];
}

/** The snippet starting at the match, trimmed to the line (noise-tolerant). */
function callSnippet(text: string, fromIndex: number): string {
  return text
    .slice(fromIndex)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[;,]\s*$/, "")
    .slice(0, 120);
}

/**
 * A balanced `fn(...)` call starting at `start`, given the index of its opening
 * paren — so inline-JSX handlers don't drag trailing markup into the snippet.
 * Falls back to a line-trimmed snippet if the parens don't close on this line.
 */
function balancedCall(text: string, start: number, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1).replace(/\s+/g, " ").trim();
    }
  }
  return callSnippet(text, start);
}

/** Humanize a route's last segment: "select-language" → "Select Language". */
function humanizeSegment(route: string): string {
  const seg = route.split(/[/?]/).filter(Boolean).pop() ?? route;
  return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= MAX_PER_CATEGORY) break;
  }
  return out;
}

function extractNav(lines: Line[]): NavExit[] {
  const re = /\brouter\s*\.\s*(push|replace|back|navigate)\s*\(/g;
  const out: NavExit[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(ln.text))) {
      const method = m[1];
      const arg = firstString(ln.text.slice(m.index));
      const label =
        method === "back" ? "Back" : arg ? `${humanizeSegment(arg)} navigation` : "Navigate";
      const openParen = m.index + m[0].length - 1;
      out.push({ label, handler: balancedCall(ln.text, m.index, openParen), line: ln.n });
    }
  }
  return dedupe(out, (e) => `${e.handler}@${e.line}`);
}

function extractUi(lines: Line[]): UiElement[] {
  const re = /\bon(?:Press|LongPress|PressIn)\s*=\s*\{([^}]{1,80})\}/g;
  const out: UiElement[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(ln.text))) {
      const handler = m[1].replace(/\s+/g, " ").trim();
      out.push({ element: "(control — label me)", handler, does: "" });
    }
  }
  return dedupe(out, (e) => e.handler ?? "");
}

const POPUP_SIGNALS: { re: RegExp; kind: string }[] = [
  { re: /Alert\.alert\s*\(|AppAlert\b/, kind: "alert" },
  { re: /<Modal\b/, kind: "modal" },
  { re: /BottomSheet|@gorhom\/bottom-sheet|ActionSheet/, kind: "sheet" },
  { re: /showToast|useToast|Toast\.(show|success|error)|react-native-toast/, kind: "toast" },
  { re: /Snackbar/, kind: "snackbar" },
  { re: /<Menu\b|ContextMenu|Popover/, kind: "menu" },
];

function extractPopups(lines: Line[]): Popup[] {
  const out: Popup[] = [];
  for (const ln of lines) {
    for (const sig of POPUP_SIGNALS) {
      if (sig.re.test(ln.text)) {
        out.push({ trigger: callSnippet(ln.text, ln.text.search(/\S/)), kind: sig.kind, line: ln.n });
        break;
      }
    }
  }
  return dedupe(out, (p) => `${p.kind}@${p.line}`);
}

function extractApis(lines: Line[]): ApiCall[] {
  const verb = /\b(?:api|axios|http|client|service)\s*\.\s*(get|post|put|patch|delete)\s*\(/i;
  const fetchRe = /\bfetch\s*\(/;
  const out: ApiCall[] = [];
  for (const ln of lines) {
    const v = ln.text.match(verb);
    if (v) {
      out.push({ method: v[1].toUpperCase(), path: firstString(ln.text.slice(v.index)) ?? "(dynamic)", line: ln.n });
      continue;
    }
    const f = ln.text.match(fetchRe);
    if (f) out.push({ method: "FETCH", path: firstString(ln.text.slice(f.index!)) ?? "(dynamic)", line: ln.n });
  }
  return dedupe(out, (a) => `${a.method} ${a.path}@${a.line}`);
}

function extractStorage(lines: Line[]): StorageAccess[] {
  const re = /\b(AsyncStorage|SecureStore|MMKV|EncryptedStorage)\s*\.\s*(getItem|setItem|removeItem|multiGet|multiSet|getString|getAllKeys|get|set|delete)\w*\s*\(/g;
  const out: StorageAccess[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(ln.text))) {
      const op = m[2].toLowerCase();
      const access = /^(get|multiget|getstring|getallkeys)/.test(op) ? "read" : "write";
      out.push({ api: m[1], access, key: firstString(ln.text.slice(m.index)) ?? "(dynamic)", line: ln.n });
    }
  }
  return dedupe(out, (s) => `${s.api} ${s.key} ${s.access}@${s.line}`);
}

function extractNotifications(lines: Line[]): NotificationRef[] {
  const re = /messaging\(\)|getMessaging|firebaseSchedule\w*|\bnotifee\b|scheduleLocalNotification|PushNotification|setBackgroundMessageHandler|MoEngage/;
  const out: NotificationRef[] = [];
  for (const ln of lines) {
    if (!re.test(ln.text)) continue;
    const source = /MoEngage/.test(ln.text)
      ? "MoEngage"
      : /notifee/.test(ln.text)
        ? "notifee"
        : /messaging|firebase|Messaging/.test(ln.text)
          ? "FCM"
          : "local";
    out.push({ source, trigger: callSnippet(ln.text, ln.text.search(/\S/)), line: ln.n });
  }
  return dedupe(out, (n) => `${n.source}@${n.line}`);
}

function extractDeepLinks(lines: Line[]): DeepLinkRef[] {
  const re = /\bBranch\b|branch\s*\.|LinkService|createBranchUniversalObject|generateShortUrl|buildLink|Linking\.(openURL|getInitialURL|addEventListener)/;
  const out: DeepLinkRef[] = [];
  for (const ln of lines) {
    if (re.test(ln.text)) out.push({ link: callSnippet(ln.text, ln.text.search(/\S/)), line: ln.n });
  }
  return dedupe(out, (d) => `${d.link}@${d.line}`);
}

function extractAnalytics(lines: Line[]): AnalyticsEvent[] {
  const re = /\b(?:trackEvent|logEvent|logCustomEvent|track|capture)\s*\(/g;
  const out: AnalyticsEvent[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(ln.text))) {
      const event = firstString(ln.text.slice(m.index));
      if (!event) continue; // only keep calls with a literal event name — reduces noise
      out.push({ event, line: ln.n });
    }
  }
  return dedupe(out, (e) => `${e.event}@${e.line}`);
}

function extractStateBranches(lines: Line[]): StateBranch[] {
  const ctxRe = /\buse([A-Z]\w*?)(Context|Store)\s*\(/g;
  const condRe = /\b(isLoading|isFetching|isError|hasError|isEmpty|isRefreshing)\b|\.length\s*===?\s*0/g;
  const out: StateBranch[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    ctxRe.lastIndex = 0;
    while ((m = ctxRe.exec(ln.text))) {
      out.push({ contextOrStore: `use${m[1]}${m[2]}`, condition: "in use", line: ln.n });
    }
    condRe.lastIndex = 0;
    while ((m = condRe.exec(ln.text))) {
      out.push({ condition: m[0].trim(), line: ln.n });
    }
  }
  return dedupe(out, (s) => `${s.contextOrStore ?? ""}|${s.condition}@${s.line}`);
}

function extractNativeModules(lines: Line[]): NativeModuleUse[] {
  const localRe = /(?:from|require\(\s*)\s*['"][^'"]*modules\/([\w-]+)/g;
  const knownRe = /react-native-(ble[\w-]*|health|maps|geolocation|camera)|expo-(camera|location|sensors|barcode-scanner)/g;
  const out: NativeModuleUse[] = [];
  for (const ln of lines) {
    let m: RegExpExecArray | null;
    localRe.lastIndex = 0;
    while ((m = localRe.exec(ln.text))) out.push({ module: m[1], line: ln.n });
    knownRe.lastIndex = 0;
    while ((m = knownRe.exec(ln.text))) out.push({ module: m[0], line: ln.n });
  }
  return dedupe(out, (m) => m.module);
}

/** Run every extractor over a screen's source files → an annotation skeleton. */
export async function extractAnnotation(sourceFiles: string[]): Promise<ScreenAnnotation> {
  const lines = await readLines(sourceFiles);
  const exits = extractNav(lines);
  const ann: ScreenAnnotation = {
    navigation: exits.length ? { exits } : undefined,
    uiElements: nonEmpty(extractUi(lines)),
    popups: nonEmpty(extractPopups(lines)),
    apis: nonEmpty(extractApis(lines)),
    storage: nonEmpty(extractStorage(lines)),
    notifications: nonEmpty(extractNotifications(lines)),
    deepLinks: nonEmpty(extractDeepLinks(lines)),
    analytics: nonEmpty(extractAnalytics(lines)),
    stateBranches: nonEmpty(extractStateBranches(lines)),
    nativeModules: nonEmpty(extractNativeModules(lines)),
  };
  return ann;
}

function nonEmpty<T>(arr: T[]): T[] | undefined {
  return arr.length ? arr : undefined;
}

/** A short per-category count summary, e.g. "5 exits · 9 handlers · 3 apis". */
export function summarize(ann: ScreenAnnotation): string {
  const parts: string[] = [];
  if (ann.navigation?.exits?.length) parts.push(`${ann.navigation.exits.length} exits`);
  const labels: Partial<Record<keyof ScreenAnnotation, string>> = {
    uiElements: "handlers",
    popups: "popups",
    apis: "apis",
    storage: "storage",
    notifications: "notifs",
    deepLinks: "links",
    analytics: "events",
    stateBranches: "branches",
    nativeModules: "native",
  };
  for (const key of ANNOTATION_LIST_KEYS) {
    const v = ann[key];
    if (Array.isArray(v) && v.length && labels[key]) parts.push(`${v.length} ${labels[key]}`);
  }
  return parts.join(" · ") || "nothing found";
}

/**
 * Merge a freshly extracted skeleton with an existing (possibly authored) file.
 * Rule: authored, non-empty values win. Any field the existing file has set
 * (prose or a non-empty list) is kept; everything else is taken from extraction.
 * This lets you re-run the extractor safely after code changes.
 */
export function mergeAnnotations(
  extracted: ScreenAnnotation,
  existing: ScreenAnnotation | undefined,
): ScreenAnnotation {
  if (!existing) return extracted;
  const merged: ScreenAnnotation = { ...extracted };
  for (const [k, v] of Object.entries(existing) as [keyof ScreenAnnotation, unknown][]) {
    const isEmpty =
      v == null ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "string" && v.trim() === "");
    if (!isEmpty) (merged as Record<string, unknown>)[k] = v;
  }
  // Authored purpose/layout/legacyParity are never produced by extraction — always keep.
  return merged;
}
