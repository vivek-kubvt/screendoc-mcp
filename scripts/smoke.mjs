// Functional smoke test: call tools directly (no MCP transport) to prove the
// guard, state store, and status reporting work.
//
// Usage: node scripts/smoke.mjs [projectRoot]
import { docStatus } from "../dist/tools/docStatus.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const selfRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv[2];
const noGit = "/tmp";

async function run(label, args) {
  console.log(`\n========== ${label} ==========`);
  const res = await docStatus(args);
  console.log(res.content[0].text);
}

// 1) This repo — on its default branch, no docs branch yet → needsBranchCreation.
await run("doc-mcp self (expect: docs branch not created yet)", { projectRoot: selfRepo });

// 2) Non-git folder → folder mode, no state.
await run("/tmp (expect: folder mode, no state)", { projectRoot: noGit });

// 3) Optional: any project you pass on the command line.
if (extra) {
  await run(`custom project: ${extra}`, { projectRoot: extra });
}
