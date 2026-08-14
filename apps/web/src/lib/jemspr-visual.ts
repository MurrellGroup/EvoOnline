import {
  displayNetwork,
  type InternalSprMove,
  type RootedNode,
  type SwitchingNetwork,
} from "@phylo-workbench/model-jemspr/browser-source";
import { parseNewick, type TreeNode } from "@phylo-workbench/model-diffubar/browser-source";

interface SerializedNode {
  readonly id: string;
  readonly kind: "root" | "tree" | "attachment" | "reticulation" | "leaf";
  readonly leaf?: number;
  readonly parents: readonly string[];
  readonly children: readonly string[];
}

interface SerializedReticulation {
  readonly bit: number;
  readonly move: InternalSprMove;
  readonly sourceContextMask: number;
  readonly sourceContextSignature: string;
  readonly reticulationNode: string;
  readonly backgroundParentNode: string;
  readonly alternateParentNode: string;
  readonly recipientChildNode: string;
  readonly donorChildNode: string;
}

interface SerializedJemsprNetwork {
  readonly taxaNames: readonly string[];
  readonly switchingNetwork: {
    readonly root: string;
    readonly nodes: readonly SerializedNode[];
    readonly reticulations: readonly SerializedReticulation[];
  };
}

const numericId = (id: string): number => Number(id.replace(/^N/, ""));

export function parseJemsprSwitchingNetwork(networkJson: string): { readonly taxaNames: readonly string[]; readonly network: SwitchingNetwork } {
  const parsed = JSON.parse(networkJson) as SerializedJemsprNetwork;
  if (!Array.isArray(parsed.taxaNames) || !Array.isArray(parsed.switchingNetwork?.nodes)) throw new Error("JEMSPR network JSON is incomplete.");
  return {
    taxaNames: parsed.taxaNames,
    network: {
      root: numericId(parsed.switchingNetwork.root),
      nodes: parsed.switchingNetwork.nodes.map((node) => ({
        id: numericId(node.id),
        kind: node.kind,
        ...(node.leaf === undefined ? {} : { leaf: node.leaf }),
        parents: node.parents.map(numericId),
        children: node.children.map(numericId),
      })),
      reticulations: parsed.switchingNetwork.reticulations.map((event) => ({
        ...event,
        move: { ...event.move },
        reticulationNode: numericId(event.reticulationNode),
        backgroundParentNode: numericId(event.backgroundParentNode),
        alternateParentNode: numericId(event.alternateParentNode),
        recipientChildNode: numericId(event.recipientChildNode),
        donorChildNode: numericId(event.donorChildNode),
      })),
    },
  };
}

export interface SprTreeLayoutNode {
  readonly key: string;
  readonly leaves: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly leaf?: number;
}

export interface SprTreeLayoutEdge { readonly key: string; readonly parent: string; readonly child: string }
export interface SprTreeLayout { readonly nodes: ReadonlyMap<string, SprTreeLayoutNode>; readonly edges: readonly SprTreeLayoutEdge[]; readonly root: string }

export interface PolishedSprTreeLayoutNode extends SprTreeLayoutNode {
  readonly distance: number;
  readonly branchLength: number;
}

export interface PolishedSprTreeLayoutEdge extends SprTreeLayoutEdge { readonly length: number }

export interface PolishedSprTreeLayout {
  readonly nodes: ReadonlyMap<string, PolishedSprTreeLayoutNode>;
  readonly edges: readonly PolishedSprTreeLayoutEdge[];
  readonly root: string;
  readonly maximumDistance: number;
  readonly pixelsPerUnit: number;
}

const cladeKey = (leaves: readonly number[]): string => [...leaves].sort((a, b) => a - b).join(",");

export function taxaCladeKey(names: readonly string[], taxaNames: readonly string[]): string | undefined {
  const indexes = names.map((name) => taxaNames.indexOf(name));
  return indexes.some((index) => index < 0) ? undefined : cladeKey(indexes);
}

/** Branch-length phylogram layout for the linked-ML Newick of one exact display. */
export function layoutPolishedSprTree(newick: string, taxaNames: readonly string[], width = 770, height = 390, padding = 34, distanceCeiling?: number): PolishedSprTreeLayout {
  const tree = parseNewick(newick);
  const leafOrder: number[] = [];
  const leavesByNode = new Map<TreeNode, number[]>();
  const distances = new Map<TreeNode, number>();
  const visit = (node: TreeNode, distance: number): number[] => {
    distances.set(node, distance);
    if (node.children.length === 0) {
      const leaf = taxaNames.indexOf(node.name);
      if (leaf < 0) throw new Error(`Linked-ML tree tip '${node.name}' is absent from the JEMSPR taxon order.`);
      leafOrder.push(leaf);
      leavesByNode.set(node, [leaf]);
      return [leaf];
    }
    const leaves = node.children.flatMap((child) => visit(child, distance + Math.max(0, child.branchLength))).sort((a, b) => a - b);
    leavesByNode.set(node, leaves);
    return leaves;
  };
  visit(tree.root, 0);
  const maximumDistance = Math.max(distanceCeiling ?? 0, ...distances.values(), 1e-9);
  const pixelsPerUnit = (width - 2 * padding) / maximumDistance;
  const ranks = new Map(leafOrder.map((leaf, index) => [leaf, index]));
  const nodes = new Map<string, PolishedSprTreeLayoutNode>();
  const edges: PolishedSprTreeLayoutEdge[] = [];
  const place = (node: TreeNode): { readonly key: string; readonly y: number } => {
    const leaves = leavesByNode.get(node)!;
    const key = cladeKey(leaves);
    const children = node.children.map(place);
    const y = node.children.length === 0
      ? padding + (ranks.get(leaves[0]!) ?? 0) / Math.max(1, leafOrder.length - 1) * (height - 2 * padding)
      : children.reduce((sum, child) => sum + child.y / children.length, 0);
    nodes.set(key, {
      key,
      leaves,
      x: padding + (distances.get(node) ?? 0) * pixelsPerUnit,
      y,
      distance: distances.get(node) ?? 0,
      branchLength: Math.max(0, node.branchLength),
      ...(node.children.length === 0 ? { leaf: leaves[0] } : {}),
    });
    for (const child of children) {
      const childNode = nodes.get(child.key)!;
      edges.push({ key: `${key}>${child.key}`, parent: key, child: child.key, length: childNode.branchLength });
    }
    return { key, y };
  };
  const root = place(tree.root).key;
  return { nodes, edges, root, maximumDistance, pixelsPerUnit };
}

/** Rectangular cladogram layout keyed by clade, enabling stable SVG morphs. */
export function layoutSprTree(tree: RootedNode, width = 920, height = 440, padding = 38): SprTreeLayout {
  const leafOrder: number[] = [];
  const collectOrder = (node: RootedNode): void => {
    if ("leaf" in node) leafOrder.push(node.leaf);
    else node.children.forEach(collectOrder);
  };
  collectOrder(tree);
  const rank = new Map(leafOrder.map((leaf, index) => [leaf, index]));
  const raw = new Map<string, { leaves: number[]; depth: number; y: number; leaf?: number }>();
  const edges: SprTreeLayoutEdge[] = [];
  let maximumDepth = 0;
  const visit = (node: RootedNode, depth: number): { key: string; leaves: number[]; y: number } => {
    maximumDepth = Math.max(maximumDepth, depth);
    if ("leaf" in node) {
      const leaves = [node.leaf];
      const key = cladeKey(leaves);
      const y = rank.get(node.leaf) ?? 0;
      raw.set(key, { leaves, depth, y, leaf: node.leaf });
      return { key, leaves, y };
    }
    const children = node.children.map((child) => visit(child, depth + 1));
    const leaves = children.flatMap((child) => child.leaves).sort((a, b) => a - b);
    const key = cladeKey(leaves);
    const y = children.reduce((sum, child) => sum + child.y / children.length, 0);
    raw.set(key, { leaves, depth, y });
    for (const child of children) edges.push({ key: `${key}>${child.key}`, parent: key, child: child.key });
    return { key, leaves, y };
  };
  const root = visit(tree, 0).key;
  const usableHeight = Math.max(1, height - 2 * padding);
  const nodes = new Map<string, SprTreeLayoutNode>();
  for (const [key, value] of raw) {
    nodes.set(key, {
      key,
      leaves: value.leaves,
      x: padding + value.depth / Math.max(1, maximumDepth) * (width - 2 * padding),
      y: padding + value.y / Math.max(1, leafOrder.length - 1) * usableHeight,
      ...(value.leaf === undefined ? {} : { leaf: value.leaf }),
    });
  }
  return { nodes, edges, root };
}

export function maskPath(mask: number, bitCount: number): readonly number[] {
  const values = [0];
  let current = 0;
  for (let bit = 0; bit < bitCount; bit += 1) if ((mask & (1 << bit)) !== 0) {
    current |= 1 << bit;
    values.push(current);
  }
  return values;
}

/**
 * Find a shortest exact-display path whose every parent-choice toggle changes
 * topology (a genuine forward or inverse rooted SPR). Monotone activation is
 * preferred; the complete small mask cube is a fallback for context-dependent
 * overlapping events.
 */
export function displayMaskPath(network: SwitchingNetwork, targetMask: number): readonly number[] {
  const bits = network.reticulations.length;
  if (targetMask === 0 || bits === 0) return [0];
  const signatures = Array.from({ length: 1 << bits }, (_value, mask) => displayNetwork(network, mask)?.signature);
  const active = Array.from({ length: bits }, (_value, bit) => bit).filter((bit) => (targetMask & (1 << bit)) !== 0);
  const monotone = (current: number, remaining: readonly number[], path: readonly number[]): readonly number[] | undefined => {
    if (remaining.length === 0) return current === targetMask ? path : undefined;
    for (const bit of remaining) {
      const next = current | (1 << bit);
      if (signatures[current] === undefined || signatures[next] === undefined || signatures[current] === signatures[next]) continue;
      const found = monotone(next, remaining.filter((candidate) => candidate !== bit), [...path, next]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const preferred = monotone(0, active, [0]);
  if (preferred !== undefined) return preferred;
  const queue = [0];
  const previous = new Int32Array(1 << bits).fill(-2);
  previous[0] = -1;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (let bit = 0; bit < bits; bit += 1) {
      const next = current ^ (1 << bit);
      if (previous[next] !== -2 || signatures[current] === undefined || signatures[next] === undefined || signatures[current] === signatures[next]) continue;
      previous[next] = current;
      if (next === targetMask) {
        const reversed = [next];
        let cursor = current;
        while (cursor >= 0) { reversed.push(cursor); cursor = previous[cursor]!; }
        return reversed.reverse();
      }
      queue.push(next);
    }
  }
  return maskPath(targetMask, bits);
}

export function exactDisplayLayout(network: SwitchingNetwork, mask: number): SprTreeLayout {
  const display = displayNetwork(network, mask);
  if (display === undefined) throw new Error(`Mask ${mask} is not a valid display of this JEMSPR network.`);
  return layoutSprTree(display.tree);
}
