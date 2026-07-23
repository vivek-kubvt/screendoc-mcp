// Prove the coordinate-tap driver: author a recipe that drives a sample app's
// onboarding by tapping "Next", then run it through the REAL MaestroEngine and
// confirm an automated screenshot is produced — no manual taps.
//
// This demo assumes a booted simulator with a sample app installed; adjust the
// appId/scheme and recipe steps to match your own build.
import { promises as fs } from "node:fs";
import path from "node:path";
import { MaestroEngine } from "../dist/capture/maestroEngine.js";

const projectRoot = "/tmp/docmcp-recipe-demo";
const capturesDir = path.join(projectRoot, ".docmcp", "captures");
await fs.mkdir(capturesDir, { recursive: true });

// Author a recipe: clean launch → tap Next x2 → settle. Reaches the permission screen.
const node = {
  id: "onboarding/get-started",
  title: "Get Started",
  route: null,
  sourceFiles: [],
  states: ["default"],
  overlays: [],
  captured: { default: null },
  contentHash: null,
  requires: [],
};
const recipeDir = path.join(projectRoot, ".docmcp", "skills", "recipes", node.id.replace(/\//g, "__"));
await fs.mkdir(recipeDir, { recursive: true });
await fs.writeFile(
  path.join(recipeDir, "default.json"),
  JSON.stringify(
    {
      description: "Drive onboarding to the 'get started' screen",
      steps: [
        { launch: { clearState: false } },
        { tap: { text: "Next" } },
        { wait: 1200 },
        { tap: { text: "Next" } },
        { wait: 2500 },
        { assertVisible: { text: "Allow & Continue" } },
      ],
    },
    null,
    2,
  ),
);

const ctx = {
  projectRoot,
  appId: process.env.DOCMCP_APP_ID ?? "com.acme.app",
  scheme: process.env.DOCMCP_SCHEME ?? "exp+acme",
  secrets: {},
  capturesDir,
};

const engine = new MaestroEngine();
const prep = await engine.prepare(ctx);
console.log("prepare:", prep);
if (!prep.ok) process.exit(1);

const outcome = await engine.capture(ctx, node, "default", "onboarding__get-started__default");
console.log("capture outcome:", outcome);
if (outcome.ok) {
  const stat = await fs.stat(outcome.file);
  console.log(`✅ AUTOMATED screenshot: ${outcome.file} (${stat.size} bytes)`);
}
