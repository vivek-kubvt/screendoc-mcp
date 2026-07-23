// End-to-end proof: feed sample screens through the tool's own output pipeline
// (buildDocumentHtml + htmlToPdf) to produce a genuine PDF. Self-contained —
// generates its own placeholder screenshots, no external files needed.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { buildDocumentHtml } from "../dist/output/html.js";
import { htmlToPdf } from "../dist/output/pdf.js";

// --- tiny pure-JS PNG encoder (solid color) for placeholder screenshots ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[1 + x * 3 + 1] = g; row[1 + x * 3 + 2] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(os.tmpdir(), "docmcp-sample-demo");
const capturesDir = path.join(outDir, "captures");
await fs.mkdir(capturesDir, { recursive: true });

// A small fictional "Acme" app: a few screens with placeholder screenshots.
const map = [
  ["(auth)/welcome", "Welcome", "/welcome", [235, 240, 245], "default", []],
  ["(auth)/sign-in", "Sign In", "/sign-in", [232, 238, 242], "default", []],
  ["(tabs)/home/index", "Home", "/(tabs)/home", [238, 243, 238], "default", ["toast"]],
  ["(tabs)/more/settings", "Settings", "/(tabs)/more/settings", [244, 246, 245], "default", []],
];

const nodes = [];
for (const [id, title, route, color, state, overlays] of map) {
  await fs.writeFile(path.join(capturesDir, `${id.replace(/\//g, "__")}__${state}.png`), solidPng(270, 560, color));
  nodes.push({
    id, title, route, sourceFiles: [`src/app/${id}.tsx`],
    states: [state], overlays, captured: { [state]: "2026-01-01" },
    contentHash: "demo", requires: id.startsWith("(auth)") ? [] : ["auth"],
  });
}

const state = {
  version: 1,
  project: {
    name: "acme-app", platform: "mobile-expo",
    frameworks: ["expo", "react-native", "expo-router"],
    entryPoints: ["src/app"], captureEngines: ["ios-sim"],
  },
  workspace: { mode: "git-branch", branch: "docs/mcp-documentation" },
  baseline: { lastDocumentedCommit: "abc1234", lastRunDate: "2026-01-01", docVersion: 0 },
  screenGraph: { nodes, edges: [] },
  run: { status: "done", currentNode: null, queue: [], startedAt: null },
  documents: [],
};

const html = await buildDocumentHtml(state, {
  capturesDir, kind: "create", version: 1, commit: "abc1234", date: "2026-01-01",
});

const outPdf = path.join(outDir, "acme-app-docs-v1.pdf");
const res = await htmlToPdf(html, outPdf);
console.log(res.ok ? `PDF OK → ${outPdf}` : `PDF FAILED: ${res.reason}`);

await fs.writeFile(path.join(outDir, "preview.html"), html);
console.log(`HTML → ${path.join(outDir, "preview.html")}`);
