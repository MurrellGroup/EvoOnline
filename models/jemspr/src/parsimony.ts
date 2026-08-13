import type { JemsprAlignment } from "./types.js";
import { rootedNodeIsLeaf, type RootedNode } from "./tree.js";

interface CompiledNode {
  readonly leaf?: number;
  readonly left?: number;
  readonly right?: number;
}

function compile(root: RootedNode): readonly CompiledNode[] {
  const nodes: CompiledNode[] = [];
  const visit = (node: RootedNode): number => {
    if (rootedNodeIsLeaf(node)) {
      nodes.push({ leaf: node.leaf });
      return nodes.length - 1;
    }
    const left = visit(node.children[0]);
    const right = visit(node.children[1]);
    nodes.push({ left, right });
    return nodes.length - 1;
  };
  visit(root);
  return nodes;
}

function fitchScore(nodes: readonly CompiledNode[], alignment: JemsprAlignment, position: number): number {
  const sets = new Uint8Array(nodes.length);
  let score = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.leaf !== undefined) sets[index] = alignment.masks[position * alignment.taxa + node.leaf] || 15;
    else {
      const intersection = sets[node.left!]! & sets[node.right!]!;
      if (intersection !== 0) sets[index] = intersection;
      else {
        sets[index] = sets[node.left!]! | sets[node.right!]!;
        score += 1;
      }
    }
  }
  return score;
}

function sankoffScore(nodes: readonly CompiledNode[], alignment: JemsprAlignment, position: number, transition: number, transversion: number): number {
  const costs = new Float64Array(nodes.length * 4);
  const q = (a: number, b: number): number => {
    if (a === b) return 0;
    const isTransition = (a === 0 && b === 2) || (a === 2 && b === 0) || (a === 1 && b === 3) || (a === 3 && b === 1);
    return isTransition ? transition : transversion;
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.leaf !== undefined) {
      const mask = alignment.masks[position * alignment.taxa + node.leaf] || 15;
      for (let state = 0; state < 4; state += 1) costs[index * 4 + state] = (mask & (1 << state)) !== 0 ? 0 : Number.POSITIVE_INFINITY;
    } else {
      for (let state = 0; state < 4; state += 1) {
        let left = Number.POSITIVE_INFINITY;
        let right = Number.POSITIVE_INFINITY;
        for (let childState = 0; childState < 4; childState += 1) {
          left = Math.min(left, costs[node.left! * 4 + childState]! + q(state, childState));
          right = Math.min(right, costs[node.right! * 4 + childState]! + q(state, childState));
        }
        costs[index * 4 + state] = left + right;
      }
    }
  }
  const rootOffset = (nodes.length - 1) * 4;
  return Math.min(costs[rootOffset]!, costs[rootOffset + 1]!, costs[rootOffset + 2]!, costs[rootOffset + 3]!);
}

export function scoreTree(
  root: RootedNode,
  alignment: JemsprAlignment,
  method: "fitch" | "sankoff",
  transitionCost: number,
  transversionCost: number,
): Float64Array {
  const nodes = compile(root);
  const scores = new Float64Array(alignment.sites);
  for (const position of alignment.informativePositions) {
    scores[position] = method === "fitch"
      ? fitchScore(nodes, alignment, position)
      : sankoffScore(nodes, alignment, position, transitionCost, transversionCost);
  }
  return scores;
}

export function scoreTreeSubset(
  root: RootedNode,
  alignment: JemsprAlignment,
  informativeIndexes: readonly number[],
  method: "fitch" | "sankoff",
  transitionCost: number,
  transversionCost: number,
): number {
  const nodes = compile(root);
  let total = 0;
  for (const index of informativeIndexes) {
    const position = alignment.informativePositions[index];
    if (position === undefined) continue;
    total += method === "fitch"
      ? fitchScore(nodes, alignment, position)
      : sankoffScore(nodes, alignment, position, transitionCost, transversionCost);
  }
  return total;
}

export function totalScore(scores: Float64Array): number {
  let total = 0;
  for (const value of scores) total += value;
  return total;
}
