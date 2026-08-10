import { DifFUBARError, PruningOpCode, type CompiledTree, type ParsedTree, type TreeNode } from "../types.js";

function registerNeed(node: TreeNode, memo: Map<TreeNode, number>): number {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  if (node.children.length === 0) {
    memo.set(node, 1);
    return 1;
  }
  const needs = node.children.map((child) => registerNeed(child, memo)).sort((a, b) => b - a);
  let result = 1;
  for (let index = 0; index < needs.length; index += 1) result = Math.max(result, needs[index]! + (index === 0 ? 0 : 1));
  memo.set(node, result);
  return result;
}

class SlotAllocator {
  private readonly free: number[] = [];
  private next = 0;
  maximum = 0;

  acquire(): number {
    const slot = this.free.pop() ?? this.next++;
    this.maximum = Math.max(this.maximum, this.next - this.free.length);
    return slot;
  }

  release(slot: number): void {
    this.free.push(slot);
  }
}

interface Program {
  readonly ops: number[];
  readonly rootSlot: number;
  readonly slotCount: number;
}

/**
 * Find the highest edge-subtrees that omit at least one grid axis. Their
 * complete contribution can be reused across that omitted Cartesian axis.
 */
function cacheHierarchy(tree: ParsedTree): ReadonlyMap<TreeNode, number> {
  const below = new Map<TreeNode, number>();
  const dependencies = (node: TreeNode): number => {
    let mask = 0;
    for (const child of node.children) mask |= (1 << child.branchClass) | dependencies(child);
    below.set(node, mask);
    return mask;
  };
  dependencies(tree.root);
  const result = new Map<TreeNode, number>();
  const fullMask = (1 << tree.classCount) - 1;
  const visit = (node: TreeNode, contextMask: number): void => {
    for (const child of node.children) {
      const mask = (1 << child.branchClass) | (below.get(child) ?? 0);
      if (mask !== contextMask) {
        // Postorder insertion guarantees a nested cache is ready before any
        // cache program that loads it.
        visit(child, mask);
        result.set(child, mask);
      } else visit(child, contextMask);
    }
  };
  visit(tree.root, fullMask);
  return result;
}

function compileProgram(
  node: TreeNode,
  edgeIndex: ReadonlyMap<TreeNode, number>,
  cachedChildren?: ReadonlyMap<TreeNode, number>,
  includeRootEdge = false,
): Program {
  const allocator = new SlotAllocator();
  const words: number[] = [];
  const needs = new Map<TreeNode, number>();
  registerNeed(node, needs);
  const emit = (opcode: PruningOpCode, a: number, b: number, payload: number): void => {
    words.push(opcode, a, b, payload);
  };
  const descend = (current: TreeNode): number => {
    if (current.children.length === 0) {
      const slot = allocator.acquire();
      emit(PruningOpCode.LoadTip, slot, 0, current.tipIndex);
      return slot;
    }
    const children = [...current.children].sort((a, b) => (needs.get(b) ?? 1) - (needs.get(a) ?? 1));
    let accumulator = -1;
    for (const child of children) {
      let childSlot: number;
      const cache = cachedChildren?.get(child);
      if (cache !== undefined) {
        childSlot = allocator.acquire();
        emit(PruningOpCode.LoadCache, childSlot, child.branchClass, cache);
      } else {
        childSlot = descend(child);
        const branch = edgeIndex.get(child);
        if (branch === undefined) throw new DifFUBARError("MISSING_EDGE", "Tree compiler lost a branch index.");
        emit(PruningOpCode.Transform, childSlot, child.branchClass, branch);
      }
      if (accumulator < 0) accumulator = childSlot;
      else {
        emit(PruningOpCode.MultiplyNormalize, accumulator, childSlot, 0);
        allocator.release(childSlot);
      }
    }
    return accumulator;
  };
  const rootSlot = descend(node);
  if (includeRootEdge) {
    const branch = edgeIndex.get(node);
    if (branch === undefined) throw new DifFUBARError("MISSING_EDGE", "Cached subtree root has no parent branch.");
    emit(PruningOpCode.Transform, rootSlot, node.branchClass, branch);
  }
  return { ops: words, rootSlot, slotCount: allocator.maximum };
}

/**
 * Compile a tree to a Sethi-Ullman-style program. Only `registerNumber * 61`
 * likelihood values are live for a grid/site pair, independent of tree size.
 */
export function compileTree(tree: ParsedTree, maximumSlots = 24): CompiledTree {
  const needs = new Map<TreeNode, number>();
  const registerNumber = registerNeed(tree.root, needs);
  if (registerNumber > maximumSlots) {
    throw new DifFUBARError(
      "TREE_REGISTER_PRESSURE",
      `This tree needs ${registerNumber} pruning registers; the selected kernel permits ${maximumSlots}.`,
    );
  }

  const allocator = new SlotAllocator();
  const words: number[] = [];
  const edgeLengths: number[] = [];
  const emit = (opcode: PruningOpCode, a: number, b: number, payload: number): void => {
    words.push(opcode, a, b, payload);
  };

  const compileNode = (node: TreeNode): number => {
    if (node.children.length === 0) {
      const slot = allocator.acquire();
      emit(PruningOpCode.LoadTip, slot, 0, node.tipIndex);
      return slot;
    }
    const children = [...node.children].sort((a, b) => (needs.get(b) ?? 1) - (needs.get(a) ?? 1));
    let accumulator = -1;
    for (const child of children) {
      const childSlot = compileNode(child);
      const edgeIndex = edgeLengths.length;
      edgeLengths.push(child.branchLength);
      emit(PruningOpCode.Transform, childSlot, child.branchClass, edgeIndex);
      if (accumulator < 0) {
        accumulator = childSlot;
      } else {
        emit(PruningOpCode.MultiplyNormalize, accumulator, childSlot, 0);
        allocator.release(childSlot);
      }
    }
    return accumulator;
  };

  const rootSlot = compileNode(tree.root);
  if (rootSlot < 0) throw new DifFUBARError("EMPTY_TREE", "The parsed tree contains no branches.");
  const flat: CompiledTree = {
    ops: Uint32Array.from(words),
    edgeLengths: Float64Array.from(edgeLengths),
    rootSlot,
    slotCount: Math.max(allocator.maximum, registerNumber),
    tipCount: tree.tips.length,
    classCount: tree.classCount,
    registerNumber,
  };

  const frontier = cacheHierarchy(tree);
  if (frontier.size === 0) return flat;
  const indexedEdges = tree.nodes.filter((node) => node !== tree.root);
  const edgeIndex = new Map(indexedEdges.map((node, index) => [node, index]));
  const cachedEdgeLengths = Float64Array.from(indexedEdges.map((node) => node.branchLength));
  const cacheId = new Map<TreeNode, number>();
  let nextCache = 0;
  for (const node of frontier.keys()) cacheId.set(node, nextCache++);

  const cacheWords: number[] = [];
  const descriptors: number[] = [];
  let cachedSlotCount = 0;
  for (const [node, dependencyMask] of frontier) {
    // Reuse already-built descendant caches inside mixed-class caches.  The
    // frontier is inserted in postorder, so every child descriptor referenced
    // by this program is evaluated before its parent.  Without this map the
    // expensive mixed caches silently recomputed every pure descendant for
    // every Cartesian parameter combination.
    const program = compileProgram(node, edgeIndex, cacheId, true);
    descriptors.push(cacheWords.length, program.ops.length / 4, program.rootSlot, dependencyMask);
    cacheWords.push(...program.ops);
    cachedSlotCount = Math.max(cachedSlotCount, program.slotCount);
  }
  const main = compileProgram(tree.root, edgeIndex, cacheId);
  cachedSlotCount = Math.max(cachedSlotCount, main.slotCount);
  if (cachedSlotCount > maximumSlots) return flat;
  return {
    ...flat,
    cachedMainOps: Uint32Array.from(main.ops),
    cacheOps: Uint32Array.from(cacheWords),
    cacheDescriptors: Uint32Array.from(descriptors),
    cachedEdgeLengths,
    cachedRootSlot: main.rootSlot,
    cachedSlotCount,
  };
}
