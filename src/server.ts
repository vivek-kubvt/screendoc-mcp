#!/usr/bin/env node
/**
 * doc-mcp — reusable documentation MCP server.
 *
 * Creates and incrementally updates versioned, screenshot-driven PDF
 * documentation for any mobile / web / other project. Speaks MCP over stdio.
 *
 * Phase 1 surface: doc_status, set_credential. Later phases add project_scan,
 * capture_screen, create_document, update_document, list_documents.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { docStatus, docStatusSchema } from "./tools/docStatus.js";
import { setCredential, setCredentialSchema } from "./tools/setCredential.js";
import { projectScan, projectScanSchema } from "./tools/projectScan.js";
import { captureScreen, captureScreenSchema } from "./tools/captureScreen.js";
import { createDocument, createDocumentSchema } from "./tools/createDocument.js";
import { updateDocument, updateDocumentSchema } from "./tools/updateDocument.js";
import { listDocuments, listDocumentsSchema } from "./tools/listDocuments.js";
import { saveRecipe, saveRecipeSchema } from "./tools/saveRecipe.js";
import { extractAnnotations, extractAnnotationsSchema } from "./tools/extractAnnotations.js";
import { planCapture, planCaptureSchema } from "./tools/planCapture.js";
import { runFlow, runFlowSchema } from "./tools/runFlow.js";
import { reconcileCapture, reconcileCaptureSchema } from "./tools/reconcileCapture.js";

const server = new McpServer({
  name: "doc-mcp",
  version: "0.1.0",
});

server.registerTool(
  "doc_status",
  {
    title: "Documentation status",
    description:
      "Report the documentation state for a project: branch/workspace check, platform, " +
      "screen coverage, current run, blocked screens, and the latest generated document. Read-only.",
    inputSchema: docStatusSchema,
  },
  docStatus,
);

server.registerTool(
  "project_scan",
  {
    title: "Scan project & build screen graph",
    description:
      "Detect the project's platform and build the full screen graph (every screen plus its " +
      "detected popups/alerts/toasters/states) without capturing. Read-only preview unless persist:true.",
    inputSchema: projectScanSchema,
  },
  projectScan,
);

server.registerTool(
  "capture_screen",
  {
    title: "Capture one screen",
    description:
      "Capture a single screen (all its states, or one) via the mobile engine and record it in state. " +
      "For retakes and spot fixes.",
    inputSchema: captureScreenSchema,
  },
  captureScreen,
);

server.registerTool(
  "create_document",
  {
    title: "Create documentation",
    description:
      "Full pipeline: detect platform, build the screen graph, capture every screen (and its states), " +
      "and build a versioned PDF. Resumable; reports coverage gaps. First run creates the docs branch (with consent).",
    inputSchema: createDocumentSchema,
  },
  createDocument,
);

server.registerTool(
  "update_document",
  {
    title: "Update documentation",
    description:
      "Incremental refresh: diff since the last documented commit, recapture only affected screens, " +
      "and rebuild the PDF with UPDATED badges and a changelog.",
    inputSchema: updateDocumentSchema,
  },
  updateDocument,
);

server.registerTool(
  "list_documents",
  {
    title: "List documents",
    description: "Every generated document with version, date, commit, kind, and which screens changed.",
    inputSchema: listDocumentsSchema,
  },
  listDocuments,
);

server.registerTool(
  "plan_capture",
  {
    title: "Plan Maestro capture flows",
    description:
      "Maestro-flow-first capture: group the screen graph into chunks (auth · one per tab · root modals) " +
      "and write one editable Maestro flow file per chunk (.docmcp/flows/<chunk>.yaml) that walks the UI and " +
      "screenshots each screen. Scaffolds with best-effort tab navigation + TODO markers; no deep-linking.",
    inputSchema: planCaptureSchema,
  },
  planCapture,
);

server.registerTool(
  "run_flow",
  {
    title: "Run a capture chunk flow",
    description:
      "Run one chunk's Maestro flow (or all) to capture its screens in a single UI walk, then record which " +
      "screenshots landed. Generates a missing flow on the fly; prefers your hand-edited one.",
    inputSchema: runFlowSchema,
  },
  runFlow,
);

server.registerTool(
  "reconcile_capture",
  {
    title: "Reconcile captured screenshots",
    description:
      "Diff expected screens vs screenshots on disk before building the PDF. Adopts manually-added PNGs and, " +
      "for each still-missing screen, prints the exact path to drop a file at (add manually) and the chunk flow " +
      "to edit + re-run (retry).",
    inputSchema: reconcileCaptureSchema,
  },
  reconcileCapture,
);

server.registerTool(
  "save_recipe",
  {
    title: "Save a navigation recipe",
    description:
      "Store a coordinate-tap recipe (tap/swipe/input/wait/back steps) that tells the capture engine " +
      "how to reach one screen by driving the UI — works even when deep links are blocked.",
    inputSchema: saveRecipeSchema,
  },
  saveRecipe,
);

server.registerTool(
  "extract_annotations",
  {
    title: "Extract per-screen annotations",
    description:
      "Source-analysis pass over the screen graph: pre-fill each screen's annotation skeleton " +
      "(navigation exits, UI handlers, popups, APIs, storage keys, notifications, deep links, analytics, " +
      "state branches, native modules) with line numbers, for the visual-flow format. Merges with " +
      "authored fields (kept) unless overwrite:true.",
    inputSchema: extractAnnotationsSchema,
  },
  extractAnnotations,
);

server.registerTool(
  "set_credential",
  {
    title: "Store a credential",
    description:
      "Store one secret (login, signup test data, test ID, API key) by key in the project's " +
      "gitignored secrets file. Never committed, never shown in generated docs.",
    inputSchema: setCredentialSchema,
  },
  setCredential,
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport: stdout is the protocol channel, so log to stderr only.
  process.stderr.write("doc-mcp server running (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`doc-mcp failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
