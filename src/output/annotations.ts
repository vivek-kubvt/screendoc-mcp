/**
 * Per-screen annotations — the rich, semantic content the visual-flow template
 * renders around each screenshot: Purpose, Navigation exits, UI elements, and
 * data bindings. This is the content layer that the source scan can't infer.
 *
 * Sourcing is hybrid (see design):
 *   - Authored: a per-screen `.docmcp/annotations/<screen-id>.json` file. This
 *     loader reads those files today, so anything you (or a later analysis pass)
 *     write is rendered immediately.
 *   - Auto-extracted (next step): a source-analysis pass will pre-fill the
 *     mechanical parts — navigation exits + handlers + line numbers — into the
 *     same shape, to be merged with/overridden by the authored file.
 *
 * The screen id uses '/' separators (e.g. "(tabs)/more/application-settings");
 * the file name encodes them as '__', matching the screenshot file convention.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DOCMCP_DIR } from "../util/types.js";

/** One way to leave the screen. */
export interface NavExit {
  /** What the user interacts with, e.g. "Back chevron", "Language row". */
  label: string;
  /** Handler / call that fires, e.g. `router.push("/(tabs)/more/help")`. */
  handler?: string;
  /** Source line number of the handler (rendered as `:245`). */
  line?: number;
  /** Optional extra note. */
  note?: string;
}

/** A row in the UI Elements & Buttons table. */
export interface UiElement {
  element: string;
  handler?: string;
  /** "What it does" column. */
  does?: string;
}

/** A row in Labels & Data Binding. */
export interface DataBinding {
  label: string;
  /** What the label is bound to, e.g. `unitPref`, `currentLanguage`. */
  binding?: string;
}

/** A popup / modal / alert / toast the screen can show. */
export interface Popup {
  /** What triggers it, e.g. "Save button", or the raw call site. */
  trigger: string;
  /** alert | modal | sheet | toast | snackbar | menu | dialog. */
  kind?: string;
  /** Buttons/actions the popup offers and what each does. */
  buttons?: { label: string; does?: string }[];
  /** True if a screenshot of this popup was captured (rendered as a thumbnail). */
  screenshot?: boolean;
  line?: number;
}

/** An API endpoint hit from this screen. */
export interface ApiCall {
  method?: string;
  path: string;
  /** When it fires, e.g. "on mount", "on submit". */
  when?: string;
  /** Shape of the request payload (freeform). */
  requestShape?: string;
  /** Response fields the screen actually uses. */
  responseFields?: string[];
  line?: number;
}

/** A data model / type shown on the screen. */
export interface DataModel {
  name: string;
  /** Where the type lives, e.g. "src/types/user.ts". */
  source?: string;
  fields?: { name: string; type?: string; meaning?: string }[];
}

/** A local-storage key read or written on this screen. */
export interface StorageAccess {
  key: string;
  /** AsyncStorage | SecureStore | MMKV | … */
  api?: string;
  /** "read" | "write". */
  access?: string;
  /** What the value holds. */
  value?: string;
  when?: string;
  line?: number;
}

/** A push/local notification the screen sends, schedules, or reacts to. */
export interface NotificationRef {
  /** push | local | scheduled | in-app. */
  kind?: string;
  /** Source system, e.g. "FCM", "notifee", "MoEngage". */
  source?: string;
  trigger?: string;
  /** Where a tap routes to, if this handles a notification. */
  routesTo?: string;
  line?: number;
}

/** A deep link this screen creates or handles. */
export interface DeepLinkRef {
  link: string;
  params?: string[];
  routesTo?: string;
  line?: number;
}

/** A tracked analytics event fired from this screen. */
export interface AnalyticsEvent {
  event: string;
  attributes?: string;
  trigger?: string;
  line?: number;
}

/** A state/logic branch: context/store used, and a conditional UI effect. */
export interface StateBranch {
  /** Context or store involved, if any. */
  contextOrStore?: string;
  /** The condition, e.g. "isLoading", "list.length === 0". */
  condition: string;
  /** What the UI does under that condition. */
  uiEffect?: string;
  line?: number;
}

/** Native-module usage (BLE, health, maps, custom native modules…). */
export interface NativeModuleUse {
  module: string;
  usage?: string;
  line?: number;
}

export interface ScreenAnnotation {
  /** Prose describing what the screen is for. */
  purpose?: string;
  /** "Layout" metadata row, e.g. "More stack (custom header, scrollable cards)". */
  layout?: string;
  /** "Legacy parity" metadata row. */
  legacyParity?: string;
  navigation?: {
    entryPoints?: string[];
    exits?: NavExit[];
  };
  uiElements?: UiElement[];
  labels?: DataBinding[];
  popups?: Popup[];
  apis?: ApiCall[];
  dataModels?: DataModel[];
  storage?: StorageAccess[];
  notifications?: NotificationRef[];
  deepLinks?: DeepLinkRef[];
  analytics?: AnalyticsEvent[];
  stateBranches?: StateBranch[];
  nativeModules?: NativeModuleUse[];
}

/** Keys of every list-shaped annotation section, in render order. */
export const ANNOTATION_LIST_KEYS: (keyof ScreenAnnotation)[] = [
  "uiElements",
  "labels",
  "popups",
  "apis",
  "dataModels",
  "storage",
  "notifications",
  "deepLinks",
  "analytics",
  "stateBranches",
  "nativeModules",
];

export const ANNOTATIONS_DIR = "annotations";

/** Encode a screen id ('/'-separated) into its annotation file basename. */
export function annotationKey(screenId: string): string {
  return screenId.replace(/\//g, "__");
}

/**
 * Load authored annotations for the given screens. Missing or invalid files are
 * skipped silently per-screen (a screen simply renders without its rich sections)
 * — a bad annotation never aborts a documentation run.
 */
export async function loadAnnotations(
  projectRoot: string,
  screenIds: string[],
): Promise<Record<string, ScreenAnnotation>> {
  const dir = path.join(projectRoot, DOCMCP_DIR, ANNOTATIONS_DIR);
  const out: Record<string, ScreenAnnotation> = {};
  for (const id of screenIds) {
    const file = path.join(dir, `${annotationKey(id)}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      out[id] = JSON.parse(raw) as ScreenAnnotation;
    } catch {
      /* no annotation for this screen — render what we have */
    }
  }
  return out;
}
