import assert from "node:assert/strict";
import test from "node:test";
import {
  WasmBackend,
  ParallelWasmBackend,
  buildModelBank,
  codonEquilibriumFromF3x4,
  compileTree,
  encodeCodonTips,
  parseFasta,
  parseNewick,
  type BsrelKernelTree,
  type DifFUBARGrid,
  type ParsedTree,
  type TreeNode,
} from "../src/index.js";

function oneClassGrid(categories: readonly [number, number][]): DifFUBARGrid {
  return {
    alpha: Float64Array.from(categories, (category) => category[0]),
    omega: Float64Array.from(categories, (category) => category[1]),
    backgroundOmega: new Float64Array(0),
    categories: Float64Array.from(categories.flat()),
    categoryCount: categories.length,
    parameterCount: 2,
    hasBackground: false,
  };
}

function twoClassGrid(alpha: number, baselineOmega: number, shiftedOmega: number): DifFUBARGrid {
  return {
    alpha: Float64Array.of(alpha),
    omega: Float64Array.of(baselineOmega, shiftedOmega),
    backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(alpha, baselineOmega, shiftedOmega),
    categoryCount: 1,
    parameterCount: 3,
    hasBackground: false,
  };
}

function messageTree(tree: ParsedTree): { readonly kernel: BsrelKernelTree; readonly edgeNodes: readonly TreeNode[] } {
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
  const childOffsets = new Uint32Array(nodes.length + 1);
  const children: number[] = [];
  const tipForNode = new Int32Array(nodes.length).fill(-1);
  const edgeForNode = new Int32Array(nodes.length).fill(-1);
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    childOffsets[nodeIndex] = children.length;
    for (const child of node.children) children.push(index.get(child)!);
    if (node.parent !== null) parent[nodeIndex] = index.get(node.parent)!;
    if (node.tipIndex >= 0) tipForNode[nodeIndex] = node.tipIndex;
    edgeForNode[nodeIndex] = edgeIndex.get(node) ?? -1;
  }
  childOffsets[nodes.length] = children.length;
  return {
    edgeNodes,
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

function cloneWithShiftedClade(source: ParsedTree, targetName: string): ParsedTree {
  const target = source.nodes.find((node) => node.name === targetName);
  if (target === undefined) throw new Error(`Unknown target '${targetName}'.`);
  const withinTarget = (node: TreeNode): boolean => {
    for (let cursor: TreeNode | null = node; cursor !== null; cursor = cursor.parent) if (cursor === target) return true;
    return false;
  };
  const clones = new Map<TreeNode, TreeNode>();
  for (const node of source.nodes) clones.set(node, {
    id: node.id,
    name: node.name,
    branchLength: node.branchLength,
    branchClass: node === source.root ? 0 : withinTarget(node) ? 1 : 0,
    parent: null,
    children: [],
    tipIndex: node.tipIndex,
  });
  for (const node of source.nodes) {
    const clone = clones.get(node)!;
    clone.parent = node.parent === null ? null : clones.get(node.parent)!;
    clone.children = node.children.map((child) => clones.get(child)!);
  }
  return {
    root: clones.get(source.root)!,
    nodes: source.nodes.map((node) => clones.get(node)!),
    tips: source.tips.map((tip) => clones.get(tip)!),
    classCount: 2,
    hasBackground: false,
    tags: ["baseline", "shifted"],
  };
}

test("all-clade message contractions equal a full re-prune for internal and terminal shifts", async () => {
  const alignment = parseFasta(`>a\n${"ATGAAAGCTTTC".repeat(4)}\n>b\n${"ATGAAGGCTTTC".repeat(4)}\n>c\n${"ATGAAAGCCTTT".repeat(4)}\n>d\n${"ATGAAGGCTTTT".repeat(4)}\n`);
  const tree = parseNewick("(((a:0.08,b:0.11)n:0.17,c:0.13)m:0.21,d:0.19)root;");
  const alpha = 0.72;
  const baselineOmega = 0.31;
  const shiftedOmega = 0.63;
  const gtr = Float64Array.of(1, 1.2, 0.8, 1.1, 0.9, 1.3);
  const f3x4 = new Float64Array(12).fill(0.25);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const backend = new WasmBackend();
  const tipStates = encodeCodonTips(alignment, tree);
  const baselineGrid = oneClassGrid([[alpha, baselineOmega]]);
  const baselineBank = buildModelBank(baselineGrid, tree, gtr, f3x4);
  const baseline = await backend.evaluate({
    tree: compileTree(tree), tipStates, siteCount: alignment.codonSites,
    grid: baselineGrid, models: baselineBank, equilibrium,
  });

  const compiled = messageTree(tree);
  const candidateNames = ["n", "a"];
  const candidateBranches = Uint32Array.from(candidateNames, (name) => {
    const edge = compiled.edgeNodes.findIndex((node) => node.name === name);
    if (edge < 0) throw new Error(`No edge for '${name}'.`);
    return edge;
  });
  const unionGrid = oneClassGrid([[alpha, baselineOmega], [alpha, shiftedOmega]]);
  const unionBank = buildModelBank(unionGrid, tree, gtr, f3x4);
  const request = {
    tree: compiled.kernel,
    tipStates,
    siteCount: alignment.codonSites,
    branchLengths: Float64Array.from(compiled.edgeNodes, (node) => node.branchLength),
    baselineModels: new Uint32Array(alignment.codonSites).fill(unionBank.gridModels[0]!),
    shiftedModels: new Uint32Array(alignment.codonSites).fill(unionBank.gridModels[1]!),
    posteriorWeights: new Float64Array(alignment.codonSites).fill(1),
    componentCount: 1,
    intensityCount: 1,
    candidateBranches,
    models: unionBank,
    equilibrium,
  };
  const kernel = await backend.evaluateCladeShift(request);
  const parallel = new ParallelWasmBackend(2, 0);
  let parallelKernel;
  try {
    parallelKernel = await parallel.evaluateCladeShift(request);
  } finally {
    await parallel.dispose();
  }
  assert.equal(parallelKernel.backend, "wasm-parallel");
  assert.deepEqual([...parallelKernel.logLikelihoodRatios], [...kernel.logLikelihoodRatios]);

  for (let candidate = 0; candidate < candidateNames.length; candidate += 1) {
    const shiftedTree = cloneWithShiftedClade(tree, candidateNames[candidate]!);
    const shiftedGrid = twoClassGrid(alpha, baselineOmega, shiftedOmega);
    const shifted = await backend.evaluate({
      tree: compileTree(shiftedTree),
      tipStates: encodeCodonTips(alignment, shiftedTree),
      siteCount: alignment.codonSites,
      grid: shiftedGrid,
      models: buildModelBank(shiftedGrid, shiftedTree, gtr, f3x4),
      equilibrium,
    });
    for (let site = 0; site < alignment.codonSites; site += 1) {
      const expected = shifted.logLikelihoods[site]! - baseline.logLikelihoods[site]!;
      const observed = kernel.logLikelihoodRatios[site * candidateNames.length + candidate]!;
      assert.ok(Math.abs(observed - expected) < 2e-10, `${candidateNames[candidate]} site ${site + 1}: ${observed} versus ${expected}`);
    }
  }
});

test("all-clade kernel integrates retained null-posterior components in likelihood-ratio space", async () => {
  const alignment = parseFasta(">a\nATGAAAGCTTTC\n>b\nATGAAGGCTTTC\n>c\nATGAAAGCCTTT\n");
  const tree = parseNewick("((a:0.08,b:0.11)n:0.17,c:0.13)root;");
  const components = [
    { alpha: 0.55, omega: 0.22, shifted: 0.47 },
    { alpha: 1.35, omega: 1.7, shifted: 2.9 },
  ] as const;
  const gtr = Float64Array.of(1, 1.2, 0.8, 1.1, 0.9, 1.3);
  const f3x4 = new Float64Array(12).fill(0.25);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const backend = new WasmBackend();
  const compiled = messageTree(tree);
  const candidate = compiled.edgeNodes.findIndex((node) => node.name === "n");
  assert.ok(candidate >= 0);
  const unionGrid = oneClassGrid(components.flatMap((component) => [
    [component.alpha, component.omega] as [number, number],
    [component.alpha, component.shifted] as [number, number],
  ]));
  const unionBank = buildModelBank(unionGrid, tree, gtr, f3x4);
  const weights = Array.from({ length: alignment.codonSites }, (_unused, site) => site % 2 === 0 ? [0.72, 0.28] : [0.35, 0.65]);
  const kernel = await backend.evaluateCladeShift({
    tree: compiled.kernel,
    tipStates: encodeCodonTips(alignment, tree),
    siteCount: alignment.codonSites,
    branchLengths: Float64Array.from(compiled.edgeNodes, (node) => node.branchLength),
    baselineModels: Uint32Array.from(weights.flatMap(() => [unionBank.gridModels[0]!, unionBank.gridModels[2]!])),
    shiftedModels: Uint32Array.from(weights.flatMap(() => [unionBank.gridModels[1]!, unionBank.gridModels[3]!])),
    posteriorWeights: Float64Array.from(weights.flat()),
    componentCount: 2,
    intensityCount: 1,
    candidateBranches: Uint32Array.of(candidate),
    models: unionBank,
    equilibrium,
  });
  const shiftedTree = cloneWithShiftedClade(tree, "n");
  const componentRatios: Float64Array[] = [];
  for (const component of components) {
    const baselineGrid = oneClassGrid([[component.alpha, component.omega]]);
    const baseline = await backend.evaluate({
      tree: compileTree(tree),
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: alignment.codonSites,
      grid: baselineGrid,
      models: buildModelBank(baselineGrid, tree, gtr, f3x4),
      equilibrium,
    });
    const shiftedGrid = twoClassGrid(component.alpha, component.omega, component.shifted);
    const shifted = await backend.evaluate({
      tree: compileTree(shiftedTree),
      tipStates: encodeCodonTips(alignment, shiftedTree),
      siteCount: alignment.codonSites,
      grid: shiftedGrid,
      models: buildModelBank(shiftedGrid, shiftedTree, gtr, f3x4),
      equilibrium,
    });
    componentRatios.push(Float64Array.from(shifted.logLikelihoods, (value, site) => value - baseline.logLikelihoods[site]!));
  }
  for (let site = 0; site < alignment.codonSites; site += 1) {
    const expected = Math.log(
      weights[site]![0]! * Math.exp(componentRatios[0]![site]!)
      + weights[site]![1]! * Math.exp(componentRatios[1]![site]!),
    );
    assert.ok(Math.abs(kernel.logLikelihoodRatios[site]! - expected) < 2e-10);
  }
});
