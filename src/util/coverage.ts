/**
 * Coverage math over the screen graph — how much of the app is documented,
 * and what remains. Used by doc_status now and by the create-flow's coverage
 * gate later (no PDF until coverage is complete or gaps are explicitly waived).
 */
import { ScreenGraph, ScreenNode } from "./types.js";

export interface Coverage {
  totalStates: number;
  capturedStates: number;
  percent: number;
  uncaptured: { node: string; states: string[] }[];
  blocked: { node: string; reason: string }[];
}

function nodeUncapturedStates(node: ScreenNode): string[] {
  return node.states.filter((s) => !node.captured[s]);
}

export function computeCoverage(graph: ScreenGraph): Coverage {
  let total = 0;
  let captured = 0;
  const uncaptured: Coverage["uncaptured"] = [];
  const blocked: Coverage["blocked"] = [];

  for (const node of graph.nodes) {
    total += node.states.length;
    const missing = nodeUncapturedStates(node);
    captured += node.states.length - missing.length;
    if (missing.length > 0) uncaptured.push({ node: node.id, states: missing });
    if (node.blocked) blocked.push({ node: node.id, reason: node.blocked.reason });
  }

  return {
    totalStates: total,
    capturedStates: captured,
    percent: total === 0 ? 0 : Math.round((captured / total) * 100),
    uncaptured,
    blocked,
  };
}
