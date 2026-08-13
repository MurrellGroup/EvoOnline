import type { JemsprSprMove } from "./types.js";

export type RootedNode = Readonly<{ leaf: number } | { children: readonly [RootedNode, RootedNode] }>;

export interface RootedSprNeighbour {
  readonly tree: RootedNode;
  readonly signature: string;
  readonly move: InternalSprMove;
  readonly inverse: InternalSprMove;
}

export interface InternalSprMove {
  readonly pruned: readonly number[];
  readonly sourceSibling: readonly number[];
  readonly destination: readonly number[];
  readonly destinationIsRoot: boolean;
}

const isLeaf = (node: RootedNode): node is Readonly<{ leaf: number }> => "leaf" in node;

export function canonicalTree(node: RootedNode): RootedNode {
  if (isLeaf(node)) return node;
  const left = canonicalTree(node.children[0]);
  const right = canonicalTree(node.children[1]);
  return treeSignature(left) <= treeSignature(right) ? { children: [left, right] } : { children: [right, left] };
}

export function treeSignature(node: RootedNode): string {
  if (isLeaf(node)) return `L${node.leaf}`;
  const a = treeSignature(node.children[0]);
  const b = treeSignature(node.children[1]);
  return a <= b ? `(${a},${b})` : `(${b},${a})`;
}

export function leafSet(node: RootedNode): readonly number[] {
  if (isLeaf(node)) return [node.leaf];
  return [...leafSet(node.children[0]), ...leafSet(node.children[1])].sort((a, b) => a - b);
}

const setKey = (values: readonly number[]): string => values.join(",");

interface IndexedNode {
  readonly node: RootedNode;
  readonly path: readonly number[];
  readonly leaves: readonly number[];
}

function indexTree(root: RootedNode): readonly IndexedNode[] {
  const result: IndexedNode[] = [];
  const visit = (node: RootedNode, path: readonly number[]): readonly number[] => {
    const leaves = isLeaf(node)
      ? [node.leaf]
      : [...visit(node.children[0], [...path, 0]), ...visit(node.children[1], [...path, 1])].sort((a, b) => a - b);
    result.push({ node, path, leaves });
    return leaves;
  };
  visit(root, []);
  return result;
}

function nodeAt(root: RootedNode, path: readonly number[]): RootedNode {
  let node = root;
  for (const direction of path) {
    if (isLeaf(node)) throw new Error("Tree path descends through a leaf.");
    node = node.children[direction]!;
  }
  return node;
}

function replaceAt(root: RootedNode, path: readonly number[], replacement: RootedNode): RootedNode {
  if (path.length === 0) return replacement;
  if (isLeaf(root)) throw new Error("Cannot replace below a leaf.");
  const [direction, ...rest] = path;
  if (direction === 0) return canonicalTree({ children: [replaceAt(root.children[0], rest, replacement), root.children[1]] });
  return canonicalTree({ children: [root.children[0], replaceAt(root.children[1], rest, replacement)] });
}

function detach(root: RootedNode, sourcePath: readonly number[]): { readonly remaining: RootedNode; readonly pruned: RootedNode; readonly siblingLeaves: readonly number[] } {
  if (sourcePath.length === 0) throw new Error("The root cannot be pruned.");
  const parentPath = sourcePath.slice(0, -1);
  const direction = sourcePath[sourcePath.length - 1]!;
  const parent = nodeAt(root, parentPath);
  if (isLeaf(parent)) throw new Error("A prune parent cannot be a leaf.");
  const pruned = parent.children[direction]!;
  const sibling = parent.children[1 - direction]!;
  return { remaining: replaceAt(root, parentPath, sibling), pruned, siblingLeaves: leafSet(sibling) };
}

function regraft(remaining: RootedNode, pruned: RootedNode, destinationPath: readonly number[]): RootedNode {
  const destination = nodeAt(remaining, destinationPath);
  return canonicalTree(replaceAt(remaining, destinationPath, canonicalTree({ children: [destination, pruned] })));
}

function findPathByLeaves(root: RootedNode, leaves: readonly number[]): readonly number[] | undefined {
  const key = setKey(leaves);
  return indexTree(root).find((entry) => setKey(entry.leaves) === key)?.path;
}

export function applyRootedSprMove(root: RootedNode, move: InternalSprMove): RootedNode | undefined {
  const result = inspectRootedSprMove(root, move);
  return result.status === "applied" ? result.tree : undefined;
}

export type RootedSprApplication =
  | { readonly status: "applied"; readonly tree: RootedNode }
  | { readonly status: "silent"; readonly tree: RootedNode }
  | { readonly status: "invalid" };

export function inspectRootedSprMove(root: RootedNode, move: InternalSprMove): RootedSprApplication {
  const sourcePath = findPathByLeaves(root, move.pruned);
  if (sourcePath === undefined || sourcePath.length === 0) return { status: "invalid" };
  const { remaining, pruned } = detach(root, sourcePath);
  const destinationPath = move.destinationIsRoot ? [] : findPathByLeaves(remaining, move.destination);
  if (destinationPath === undefined) return { status: "invalid" };
  const candidate = regraft(remaining, pruned, destinationPath);
  return treeSignature(candidate) === treeSignature(root)
    ? { status: "silent", tree: root }
    : { status: "applied", tree: candidate };
}

export function enumerateRootedSprNeighbours(rootInput: RootedNode): readonly RootedSprNeighbour[] {
  const root = canonicalTree(rootInput);
  const original = treeSignature(root);
  const neighbours = new Map<string, RootedSprNeighbour>();
  for (const source of indexTree(root)) {
    if (source.path.length === 0) continue;
    const { remaining, pruned, siblingLeaves } = detach(root, source.path);
    for (const destination of indexTree(remaining)) {
      const tree = regraft(remaining, pruned, destination.path);
      const signature = treeSignature(tree);
      if (signature === original || neighbours.has(signature)) continue;
      const move: InternalSprMove = {
        pruned: source.leaves,
        sourceSibling: siblingLeaves,
        destination: destination.leaves,
        destinationIsRoot: destination.path.length === 0,
      };
      const inverse: InternalSprMove = {
        pruned: source.leaves,
        sourceSibling: destination.leaves,
        destination: siblingLeaves,
        destinationIsRoot: source.path.length === 1,
      };
      neighbours.set(signature, { tree, signature, move, inverse });
    }
  }
  return [...neighbours.values()];
}

export function rootedClades(root: RootedNode): ReadonlySet<string> {
  const all = leafSet(root).length;
  return new Set(indexTree(root)
    .filter((entry) => entry.leaves.length > 1 && entry.leaves.length < all)
    .map((entry) => setKey(entry.leaves)));
}

export function rootedRfDistance(a: RootedNode, b: RootedNode): number {
  const left = rootedClades(a);
  const right = rootedClades(b);
  let distance = 0;
  for (const clade of left) if (!right.has(clade)) distance += 1;
  for (const clade of right) if (!left.has(clade)) distance += 1;
  return distance;
}

function quoteName(name: string): string {
  return /[\s,:;()\[\]'\"]/.test(name) ? `'${name.replaceAll("'", "''")}'` : name;
}

export function treeToNewick(root: RootedNode, names: readonly string[]): string {
  const render = (node: RootedNode): string => isLeaf(node)
    ? quoteName(names[node.leaf] ?? `taxon_${node.leaf + 1}`)
    : `(${render(node.children[0])}:1,${render(node.children[1])}:1)`;
  return `${render(root)};`;
}

export function publicMove(move: InternalSprMove, names: readonly string[]): JemsprSprMove {
  const labels = (indices: readonly number[]): readonly string[] => indices.map((index) => names[index] ?? `taxon_${index + 1}`);
  return {
    prunedTaxa: labels(move.pruned),
    sourceSiblingTaxa: labels(move.sourceSibling),
    destinationTaxa: labels(move.destination),
    destinationIsRoot: move.destinationIsRoot,
  };
}

export function parsePublicMove(move: JemsprSprMove, names: readonly string[]): InternalSprMove {
  const byName = new Map(names.map((name, index) => [name, index]));
  const indices = (labels: readonly string[]): readonly number[] => labels.map((label) => {
    const index = byName.get(label);
    if (index === undefined) throw new Error(`Unknown taxon '${label}' in rSPR move.`);
    return index;
  }).sort((a, b) => a - b);
  return {
    pruned: indices(move.prunedTaxa),
    sourceSibling: indices(move.sourceSiblingTaxa),
    destination: indices(move.destinationTaxa),
    destinationIsRoot: move.destinationIsRoot,
  };
}

export function treeDepths(root: RootedNode): ReadonlyMap<string, number> {
  const depths = new Map<string, number>();
  const visit = (node: RootedNode, depth: number): void => {
    depths.set(setKey(leafSet(node)), depth);
    if (!isLeaf(node)) {
      visit(node.children[0], depth + 1);
      visit(node.children[1], depth + 1);
    }
  };
  visit(root, 0);
  return depths;
}

export function rootPlacements(rootInput: RootedNode): readonly RootedNode[] {
  interface GraphNode { readonly leaf?: number; readonly neighbours: number[] }
  const graph: GraphNode[] = [];
  const build = (node: RootedNode): number => {
    const id = graph.length;
    graph.push(isLeaf(node) ? { leaf: node.leaf, neighbours: [] } : { neighbours: [] });
    if (!isLeaf(node)) {
      for (const child of node.children) {
        const childId = build(child);
        graph[id]!.neighbours.push(childId);
        graph[childId]!.neighbours.push(id);
      }
    }
    return id;
  };
  const oldRoot = build(rootInput);
  const rootNeighbours = graph[oldRoot]!.neighbours;
  if (rootNeighbours.length === 2) {
    const [a, b] = rootNeighbours as [number, number];
    graph[a]!.neighbours.splice(graph[a]!.neighbours.indexOf(oldRoot), 1);
    graph[b]!.neighbours.splice(graph[b]!.neighbours.indexOf(oldRoot), 1);
    graph[a]!.neighbours.push(b);
    graph[b]!.neighbours.push(a);
    graph[oldRoot]!.neighbours.length = 0;
  }
  const orient = (nodeId: number, parentId: number): RootedNode => {
    const node = graph[nodeId]!;
    if (node.leaf !== undefined) return { leaf: node.leaf };
    const children = node.neighbours.filter((value) => value !== parentId).map((value) => orient(value, nodeId));
    if (children.length === 1) return children[0]!;
    if (children.length !== 2) throw new Error("Root placement encountered a non-binary node.");
    return canonicalTree({ children: [children[0]!, children[1]!] });
  };
  const result = new Map<string, RootedNode>();
  for (let a = 0; a < graph.length; a += 1) {
    for (const b of graph[a]!.neighbours) {
      if (a >= b) continue;
      const rooted = canonicalTree({ children: [orient(a, b), orient(b, a)] });
      result.set(treeSignature(rooted), rooted);
    }
  }
  return [...result.values()];
}

export const rootedNodeIsLeaf = isLeaf;
