export interface LinkedTreeInput {
  readonly id: string;
  readonly root: number;
  /** -1 for a leaf; otherwise the first child node. */
  readonly childA: Int32Array;
  /** -1 for a leaf; otherwise the second child node. */
  readonly childB: Int32Array;
  /** Taxon index for leaves and -1 for internal nodes. */
  readonly leaf: Int32Array;
  /** Atomic edge ids whose lengths sum to the branch above each node. */
  readonly atomicEdgesByNode: readonly Int32Array[];
}

export interface CompiledLinkedTree extends LinkedTreeInput {
  readonly parent: Int32Array;
  readonly postorder: Int32Array;
  readonly preorder: Int32Array;
  readonly taxonCount: number;
  readonly atomicEdgeCount: number;
}

export function compileLinkedTree(input: LinkedTreeInput): CompiledLinkedTree {
  const nodes = input.childA.length;
  if (nodes < 3 || input.childB.length !== nodes || input.leaf.length !== nodes || input.atomicEdgesByNode.length !== nodes) throw new RangeError("Linked tree arrays have inconsistent sizes.");
  if (input.root < 0 || input.root >= nodes) throw new RangeError("Linked tree root is outside the node array.");
  const parent = new Int32Array(nodes).fill(-1);
  const seen = new Uint8Array(nodes);
  const postorder: number[] = [];
  const preorder: number[] = [];
  let maximumTaxon = -1;
  let maximumAtomic = -1;
  const visit = (node: number): void => {
    if (node < 0 || node >= nodes || seen[node] !== 0) throw new RangeError("Linked tree is cyclic or references a node more than once.");
    seen[node] = 1;
    preorder.push(node);
    const left = input.childA[node]!;
    const right = input.childB[node]!;
    const taxon = input.leaf[node]!;
    if (left < 0 || right < 0) {
      if (left !== -1 || right !== -1 || taxon < 0) throw new RangeError("Every linked-tree leaf must have two -1 children and a taxon index.");
      maximumTaxon = Math.max(maximumTaxon, taxon);
    } else {
      if (taxon !== -1 || left === right) throw new RangeError("Every linked-tree internal node must have two distinct children and leaf=-1.");
      parent[left] = node;
      parent[right] = node;
      visit(left);
      visit(right);
    }
    for (const atomic of input.atomicEdgesByNode[node]!) {
      if (atomic < 0 || !Number.isInteger(atomic)) throw new RangeError("Atomic edge ids must be nonnegative integers.");
      maximumAtomic = Math.max(maximumAtomic, atomic);
    }
    postorder.push(node);
  };
  visit(input.root);
  if (seen.some((value) => value === 0)) throw new RangeError("Linked tree contains unreachable nodes.");
  if (input.atomicEdgesByNode[input.root]!.length !== 0) throw new RangeError("The root cannot have an incoming atomic-edge path.");
  const taxa = new Uint8Array(maximumTaxon + 1);
  for (const taxon of input.leaf) {
    if (taxon < 0) continue;
    if (taxa[taxon] !== 0) throw new RangeError(`Taxon ${taxon} occurs more than once in linked tree '${input.id}'.`);
    taxa[taxon] = 1;
  }
  if (taxa.some((value) => value === 0)) throw new RangeError("Linked-tree taxon ids must be contiguous from zero.");
  return {
    ...input,
    parent,
    postorder: Int32Array.from(postorder),
    preorder: Int32Array.from(preorder),
    taxonCount: maximumTaxon + 1,
    atomicEdgeCount: maximumAtomic + 1,
  };
}

export function branchLength(tree: CompiledLinkedTree, node: number, atomicLengths: ArrayLike<number>): number {
  let total = 0;
  for (const atomic of tree.atomicEdgesByNode[node]!) total += atomicLengths[atomic]!;
  return total;
}
