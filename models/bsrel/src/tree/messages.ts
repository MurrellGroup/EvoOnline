import type { BsrelKernelTree, ParsedTree, TreeNode } from "@phylo-workbench/model-diffubar";

export interface CompiledBsrelTree {
  readonly kernel: BsrelKernelTree;
  readonly nodes: readonly TreeNode[];
  readonly edgeNodes: readonly TreeNode[];
}

export function compileBsrelTree(tree: ParsedTree): CompiledBsrelTree {
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

  const parent = new Int32Array(nodes.length).fill(-1);
  const tipForNode = new Int32Array(nodes.length).fill(-1);
  const edgeForNode = new Int32Array(nodes.length).fill(-1);
  const childOffsets = new Uint32Array(nodes.length + 1);
  const children: number[] = [];
  const edgeNodes = nodes.filter((node) => node !== tree.root);
  const edgeIndex = new Map(edgeNodes.map((node, edge) => [node, edge]));

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    childOffsets[nodeIndex] = children.length;
    for (const child of node.children) children.push(index.get(child)!);
    if (node.parent !== null) parent[nodeIndex] = index.get(node.parent)!;
    if (node.tipIndex >= 0) tipForNode[nodeIndex] = node.tipIndex;
    const edge = edgeIndex.get(node);
    if (edge !== undefined) edgeForNode[nodeIndex] = edge;
  }
  childOffsets[nodes.length] = children.length;
  const nodeForEdge = Uint32Array.from(edgeNodes, (node) => index.get(node)!);
  return {
    kernel: {
      parent,
      childOffsets,
      children: Uint32Array.from(children),
      tipForNode,
      edgeForNode,
      nodeForEdge,
      postorder: Uint32Array.from(postorder),
      preorder: Uint32Array.from(preorder),
      root: index.get(tree.root)!,
      nodeCount: nodes.length,
      edgeCount: edgeNodes.length,
      tipCount: tree.tips.length,
    },
    nodes,
    edgeNodes,
  };
}
