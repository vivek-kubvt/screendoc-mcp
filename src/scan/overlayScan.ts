/**
 * Per-screen source scan: find the popups, alerts, toasters, sheets, and named
 * visual states a screen can show, so the capture loop knows to reach each one.
 *
 * This is heuristic by design — it reads source text, not a running app — and
 * errs toward listing a candidate so nothing is silently missed. The capture
 * engine confirms reality; anything it can't reach is reported at the gate.
 */
import { promises as fs } from "node:fs";

interface Signal {
  /** Regex over source text. */
  re: RegExp;
  /** What to record when it matches. */
  label: string;
  kind: "overlay" | "state";
}

const SIGNALS: Signal[] = [
  // Overlays.
  { re: /Alert\.alert\s*\(/, label: "alert", kind: "overlay" },
  { re: /<Modal\b/, label: "modal", kind: "overlay" },
  { re: /BottomSheet|@gorhom\/bottom-sheet|ActionSheet/, label: "sheet", kind: "overlay" },
  { re: /showToast|useToast|Toast\.(show|success|error)|react-native-toast/, label: "toast", kind: "overlay" },
  { re: /Snackbar/, label: "snackbar", kind: "overlay" },
  { re: /<Menu\b|ContextMenu|Popover/, label: "menu", kind: "overlay" },
  // Named states — inferred from common conditional-render idioms.
  { re: /isLoading|loading\s*\?|<ActivityIndicator|Skeleton/, label: "loading", kind: "state" },
  { re: /\berror\b\s*[?&]|isError|hasError|catch\s*\(/, label: "error", kind: "state" },
  { re: /isEmpty|length\s*===\s*0|EmptyState|no .*results/i, label: "empty", kind: "state" },
  { re: /disabled\s*[=:]/, label: "disabled", kind: "state" },
  { re: /paused|isPaused/, label: "paused", kind: "state" },
];

export async function scanScreenSource(
  file: string,
): Promise<{ overlays: string[]; states: string[] }> {
  let src = "";
  try {
    src = await fs.readFile(file, "utf8");
  } catch {
    return { overlays: [], states: [] };
  }
  const overlays = new Set<string>();
  const states = new Set<string>();
  for (const sig of SIGNALS) {
    if (sig.re.test(src)) {
      (sig.kind === "overlay" ? overlays : states).add(sig.label);
    }
  }
  return { overlays: [...overlays], states: [...states] };
}
