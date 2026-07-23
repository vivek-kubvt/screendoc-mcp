# screendoc-mcp

A reusable **documentation MCP server**. Registered once, it can document any
project — mobile, web, or other — by driving the real app, capturing every
screen, and producing versioned, trackable PDF documentation.

Two primary operations:

- **`create_document`** — full documentation from scratch: detect the platform,
  map every screen, gather the credentials it needs, capture each screen and its
  popups/alerts/toasters/states, and build a named PDF.
- **`update_document`** — incremental: diff since the last documented commit, find
  the affected screens, re-capture only those, and rebuild the PDF with change
  markers and a changelog.

See the [design plan](https://claude.ai/code/artifact/fb2aeabf-9f79-4894-ab39-e0b744c92c96)
for the full architecture.

## Workspace discipline (core rule)

doc-mcp works **only on its own documentation branch** (`docs/mcp-documentation`)
or, in a non-git project, its own `.docmcp/` folder. It **never** modifies other
branches. If another branch is checked out, every tool refuses to write and
**escalates to you** to switch — it never switches, stashes, or commits on your
behalf outside its branch.

## Live progress, fewer prompts, auto-cleanup

Documentation runs walk a UI screen-by-screen and can take minutes, so the
long-running tools report progress and clean up after themselves:

- **Live progress.** `create_document`, `update_document`, and `run_flow` stream
  MCP `notifications/progress` (per-screen / per-chunk) whenever the client asks
  for them, and always mirror each step to the server's stderr log
  (`[create_document] 62% (8/13) Captured Profile`). No config needed.
- **Fewer permission prompts.** This repo's `.claude/settings.local.json`
  allowlists every `mcp__doc-mcp__*` tool, so Claude Code runs the whole capture
  pipeline without asking to approve each call. To get the same in a project
  you're documenting, add the same `mcp__doc-mcp__*` entries to that project's
  `.claude/settings.json`.
- **Auto-cleanup after the PDF.** Screenshots are base64-baked into the PDF at
  build time, so once a PDF is written the raw captures are scratch.
  `create_document` / `update_document` delete `.docmcp/captures/**` after a
  successful build and report how much space was freed. Everything reusable is
  kept — the PDFs, the Maestro flow `.yaml` files, recipes, plans, and
  `.docmcp/state.json`. Pass `keepCaptures: true` to keep the raw screenshots.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | MCP skeleton, workspace guard, state store, `doc_status`, `set_credential` | ✅ done |
| 2 | `project_scan` — platform detection + screen graph | ✅ done |
| 3 | Maestro capture engine (iOS+Android) + `capture_screen` + secrets/recipes | ✅ built |
| 4 | `create_document` + coverage gate + PDF builder | ✅ built (PDF output proven on real app screens) |
| 5 | `update_document` + change badges + changelog | ✅ built |
| 6a | Coordinate-tap navigation driver + `save_recipe` | ✅ built (proven auto-capturing a real app's onboarding) |
| 6b | Web (Playwright) engine | ⬜ pending |

### Navigation & capture — Maestro-flow-first

Capture is **Maestro-flow-first**: the app is documented by driving its real UI with
Maestro, not by deep-linking each route. Deep links are an **opt-in fallback**
(`allowDeepLinks: true`), off by default — they diverge from real navigation and, on
Expo iOS prebuilds, often fail with `LSApplicationWorkspace error 115` (wrong scheme).

The flow-first pipeline:

1. **`project_scan`** → the full screen graph (all routes + detected states).
2. **`plan_capture`** → groups screens into **chunks** (auth · one per tab · root
   modals) and writes one **editable Maestro flow per chunk** at
   `.docmcp/flows/<chunk>.yaml`. Each is a scaffold: `launchApp` + auth, then a
   labelled block per screen with best-effort tab navigation and `# TODO` markers
   where you fill the taps, plus a `takeScreenshot` whose filename the PDF reads.
3. Edit the flows' `# TODO` taps, then **`run_flow chunk:"<id>"`** — runs one chunk's
   flow (one by one), captures its screens in a single UI walk, records which landed.
4. **`reconcile_capture`** → diffs expected screens vs PNGs on disk. It **adopts**
   manually-added screenshots, and for each still-missing screen prints the two fixes:
   **retry** (edit the chunk flow + re-run) or **add manually** (the exact PNG path to
   drop a file at). Non-default states are listed separately as optional.
5. **`create_document format:visual-flow`** → builds the PDF; its coverage gate points
   back to `reconcile_capture` for anything still missing.

**Coordinate-tap recipes** (`save_recipe`, `.docmcp/skills/recipes/<id>/<state>.json`)
remain the way to script a single tricky screen/state precisely; a recipe always wins
over the chunk flow for that screen. `{{secretKey}}` injects stored credentials.

The scheme/appId are still resolved from the **native project**, not app.json
(`src/scan/nativeIdentity.ts`), and printed in `create_document`'s output (`Device: …`)
for when the deep-link fallback is explicitly enabled.

Scan and PDF generation work regardless of navigation.

### Document format (house style)

The PDF's look — page structure, colors, fonts, cover, table-of-contents columns,
screenshot sizing — comes from a **named format preset**, not from hardcoded
template code, so every run (create *or* update) renders identically. Presets:

- `default` (green), `brand` (indigo), `compact` (dense grayscale) — the standard
  layout: cover + table of contents + flowing per-screen sections.
- `visual-flow` — one screen per page: a device frame beside a source-linked
  breakdown (metadata table, **Purpose**, **Navigation** exits with handlers +
  line numbers, **UI Elements & Buttons**, **Labels & Data Binding**, plus
  **Popups**, **APIs**, **Data models**, **Storage**, **Notifications**,
  **Deep links**, **Analytics**, **State branches**, **Native modules**) with a
  running footer + page numbers. The rich sections are filled from per-screen
  **annotations** (see below); a screen with no annotation still renders its
  device frame + route/source/states. After the per-screen pages, it appends
  **cross-cutting catalogs** — API, data-model, storage-key, deep-link,
  analytics, and notification reference tables aggregated across every screen,
  each listing which screens use it.

  **Accent color:** for `visual-flow`, the accent is auto-detected from the
  project's own palette (`app.json` `primaryColor`, `tailwind.config`,
  `src/theme/colors.ts`, `constants/Colors.ts`, …) so the docs match the product.
  A `colors.accent` override in `.docmcp/format.json` always wins; if nothing is
  found, the preset default is used. The applied color + its source are printed
  in the run output (`Accent: …`).

Pin a format by committing `.docmcp/format.json`. Either a bare preset name:

```json
"brand"
```

or a preset plus shallow overrides (override individual keys, not whole groups):

```json
{
  "preset": "brand",
  "overrides": {
    "colors": { "accent": "#7A1FA2" },
    "cover":  { "eyebrow": "Acme Product Docs" }
  }
}
```

No file → `default`. An unknown preset or malformed JSON falls back to `default`
with a warning in the tool output (a bad file never breaks a run). Because the
file is committed on the docs branch, the same format is applied every time. The
applied format and its source are printed in each run's output (`Format: …`).

#### Per-screen annotations (visual-flow content)

The `visual-flow` template's rich sections come from per-screen annotation files
at `.docmcp/annotations/<screen-id>.json`, where the screen id's `/` separators
become `__` (e.g. `(tabs)__more__application-settings.json`). Shape:

```json
{
  "purpose": "App-wide preferences: units, language, …",
  "layout": "More stack (custom header, back chevron, scrollable card list)",
  "legacyParity": "Mirrors the legacy SettingsViewController",
  "navigation": {
    "entryPoints": ["More tab menu → \"Application Settings\""],
    "exits": [
      { "label": "Language row", "handler": "router.push(\"/(tabs)/more/select-language\")", "line": 229 }
    ]
  },
  "uiElements": [
    { "element": "Effort Scores Switch", "handler": "setEffortScoresEnabled", "does": "master toggle" }
  ],
  "labels": [{ "label": "Current language", "binding": "currentLanguage" }]
}
```

Every field is optional — sections with no data are omitted. Beyond the fields
above, an annotation may carry `popups`, `apis`, `dataModels`, `storage`,
`notifications`, `deepLinks`, `analytics`, `stateBranches`, and `nativeModules`
(see `src/output/annotations.ts` for exact shapes) — each rendered as its own
section on the page.

Sourcing is **hybrid**:

- **Auto-extract** — the **`extract_annotations`** tool runs a source-analysis
  pass over the screen graph and writes a skeleton per screen with the mechanical
  fields pre-filled (navigation exits, UI handlers, popups, API calls, storage
  keys, notifications, deep links, analytics events, state branches, native
  modules) — each with the source line number. Re-running is safe: authored,
  non-empty fields are preserved (merge unless `overwrite: true`).
- **Author** — you (or an analysis pass) fill the semantic fields the extractor
  can't infer: `purpose`, each element's `does`, data-model field meanings,
  `legacyParity`.

Missing/invalid annotation files are skipped per-screen and never abort a run.

Typical flow: `project_scan` → `extract_annotations` → author the gaps →
`create_document` with `format: visual-flow`.

### Capture playbook (validated on iOS, Expo/RN)

Deep-links reach only **static, stateless routes**. Real apps need more, so the recipe
system is the primary path. Patterns that generalize (author these as recipes under
`.docmcp/skills/`):

- **Preconditions** — run once in `prepare()`: `auth-flow.yaml` (sign in with
  `{{secretKey}}` creds), then any app-state gate (feature-flag / channel / "default
  experience" toggle) that changes the whole layout. Capture each such mode as its own run.
- **First-launch takeovers** — onboarding carousels, permission-priming, "sync your watch"
  and password-manager prompts appear over the app; dismiss them with guarded
  `runFlow: { when: { visible } }` blocks before asserting the target screen.
- **Custom-drawn controls** — RN cards/rows/buttons frequently aren't in the a11y tree
  (`tapOn: text` fails). Tap them by point `%`. Hub cards, friend rows, and session
  controls were all point-tapped.
- **Live/WebRTC surfaces** — in-call / recording screens render controls on a native
  overlay Maestro's synthetic taps **cannot** hit. Capture those screens with the sim
  driver (`xcrun simctl io <udid> screenshot`) and document the limitation; don't block the
  run on them.
- **iOS `- back` is a no-op** (no hardware back button) — tap the header chevron by point
  instead; works on both platforms.
- **Per-platform PDFs** — regenerate with a freshness window so a run's shots don't mix with
  the other platform's stale captures (iOS vs Android side-by-side).
- **Stop before irreversible actions** — send/commit/start-call/create buttons. Capture the
  confirm screen, then back out or discard; never leave a live session running.

## Develop

```bash
npm install
npm run build        # compile to dist/
npm run dev          # run the server via tsx (stdio)
node scripts/mcp-smoke.mjs   # boot server + call a tool over MCP
```

## Register with Claude

Point your MCP client at the built server:

```json
{
  "mcpServers": {
    "doc-mcp": { "command": "node", "args": ["/absolute/path/to/doc-mcp/dist/server.js"] }
  }
}
```

The tools take an optional `projectRoot` argument; when omitted they operate on
the server's working directory.

> **Naming:** the npm package / repo is `screendoc-mcp`, but the MCP server id
> stays `doc-mcp` (the key above), so tools are namespaced `mcp__doc-mcp__*` and
> existing registrations keep working. Rename the server id in `src/server.ts` if
> you want the `mcp__screendoc-mcp__*` namespace instead.
