import type { BsrelKernelTree, ParsedTree, TreeNode } from "@phylo-workbench/model-diffubar";

export interface CompiledCladeShiftTree {
  readonly kernel: BsrelKernelTree;
  readonly nodes: readonly TreeNode[];
  readonly edgeNodes: readonly TreeNode[];
  readonly descendantTips: Uint32Array;
}

export function cloneSingleClassTree(tree: ParsedTree): ParsedTree {
  const clones = new Map<TreeNode, TreeNode>();
  for (const node of tree.nodes) clones.set(node, {
    id: node.id,
    name: node.name.replaceAll(/\{[^}]+\}/g, ""),
    branchLength: node.branchLength,
    branchClass: 0,
    parent: null,
    children: [],
    tipIndex: node.tipIndex,
  });
  for (const node of tree.nodes) {
    const clone = clones.get(node)!;
    clone.parent = node.parent === null ? null : clones.get(node.parent)!;
    clone.children = node.children.map((child) => clones.get(child)!);
  }
  return {
    root: clones.get(tree.root)!,
    nodes: tree.nodes.map((node) => clones.get(node)!),
    tips: tree.tips.map((tip) => clones.get(tip)!),
    classCount: 1,
    hasBackground: false,
    tags: [],
  };
}

export function compileCladeShiftTree(tree: ParsedTree): CompiledCladeShiftTree {
  const nodes: TreeNode[] = [];
  const preorder: number[] = [];
  const postorder: number[] = [];
  const index = new Map<TreeNode, number>();
  const visit = (node: TreeNode): void => {
    const nodeIndex = nodes.length;
    nodes.push(node);
    index.set(node, nodeIndex);
    preorder.push(nodeIndex);
    for (const child of node.children) visit(child);
    postorder.push(nodeIndex);
  };
  visit(tree.root);
  const edgeNodes = nodes.filter((node) => node !== tree.root);
  const edgeIndex = new Map(edgeNodes.map((node, edge) => [node, edge]));
  const parent = new Int32Array(nodes.length).fill(-1);
  const tipForNode = new Int32Array(nodes.length).fill(-1);
  const edgeForNode = new Int32Array(nodes.length).fill(-1);
  const childOffsets = new Uint32Array(nodes.length + 1);
  const children: number[] = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    childOffsets[nodeIndex] = children.length;
    for (const child of node.children) children.push(index.get(child)!);
    if (node.parent !== null) parent[nodeIndex] = index.get(node.parent)!;
    if (node.tipIndex >= 0) tipForNode[nodeIndex] = node.tipIndex;
    edgeForNode[nodeIndex] = edgeIndex.get(node) ?? -1;
  }
  childOffsets[nodes.length] = children.length;
  const descendantByNode = new Uint32Array(nodes.length);
  for (const nodeIndex of postorder) {
    const start = childOffsets[nodeIndex]!;
    const end = childOffsets[nodeIndex + 1]!;
    if (start === end) descendantByNode[nodeIndex] = 1;
    else {
      let total = 0;
      for (let cursor = start; cursor < end; cursor += 1) total += descendantByNode[children[cursor]!]!;
      descendantByNode[nodeIndex] = total;
    }
  }
  return {
    nodes,
    edgeNodes,
    descendantTips: Uint32Array.from(edgeNodes, (node) => descendantByNode[index.get(node)!]!),
    kernel: {
      parent,
      childOffsets,
      children: Uint32Array.from(children),
      tipForNode,
      edgeForNode,
      nodeForEdge: Uint32Array.from(edgeNodes, (node) => index.get(node)!),
      postorder: Uint32Array.from(postorder),
      preorder: Uint32Array.from(preorder),
      root: index.get(tree.root)!,
      nodeCount: nodes.length,
      edgeCount: edgeNodes.length,
      tipCount: tree.tips.length,
    },
  };
}
