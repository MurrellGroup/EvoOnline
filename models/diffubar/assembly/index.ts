export const Uint8Array_ID: u32 = idof<Uint8Array>();
export const Uint32Array_ID: u32 = idof<Uint32Array>();
export const Int32Array_ID: u32 = idof<Int32Array>();
export const Float64Array_ID: u32 = idof<Float64Array>();

const LOAD_TIP: u32 = 0;
const TRANSFORM: u32 = 1;
const MULTIPLY_NORMALIZE: u32 = 2;
const LOAD_CACHE: u32 = 3;

const SITE_BLOCK: i32 = 16;

@inline function loadF64x2(values: Float64Array, index: i32): v128 {
  return v128.load(values.dataStart + (<usize>index << 3));
}

@inline function storeF64x2(values: Float64Array, index: i32, value: v128): void {
  v128.store(values.dataStart + (<usize>index << 3), value);
}

@inline function copyF64Range(
  destination: Float64Array,
  destinationIndex: i32,
  source: Float64Array,
  sourceIndex: i32,
  count: i32,
): void {
  memory.copy(
    destination.dataStart + (<usize>destinationIndex << 3),
    source.dataStart + (<usize>sourceIndex << 3),
    <usize>count << 3,
  );
}

/** Apply exp(Qt) to a state-by-site block, with sites contiguous for SIMD. */
function propagateBlock(
  values: Float64Array,
  slot: i32,
  blockCount: i32,
  branchLength: f64,
  model: i32,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
): void {
  if (branchLength == 0.0) return;
  const lambda = mu[model] * branchLength;
  const segmentLimit = poissonTerms <= 0 ? Math.min(maxLambdaPerStep, 64.0) : maxLambdaPerStep;
  let steps = <i32>Math.ceil(lambda / segmentLimit);
  if (steps < 1) steps = 1;
  const stepLambda = lambda / <f64>steps;
  const valueOffset = slot * stateCount * SITE_BLOCK;
  const modelDiagonalOffset = model * stateCount;
  const modelRateOffset = model * stateCount * maxNeighbors;

  for (let segment = 0; segment < steps; segment += 1) {
    let weight = Math.exp(-stepLambda);
    let cumulativeWeight = weight;
    const initialWeightVector = f64x2.splat(weight);
    for (let state = 0; state < stateCount; state += 1) {
      const rowOffset = state * SITE_BLOCK;
      const sourceOffset = valueOffset + rowOffset;
      let site = 0;
      for (; site + 1 < blockCount; site += 2) {
        const value = loadF64x2(values, sourceOffset + site);
        storeF64x2(workA, rowOffset + site, value);
        storeF64x2(accumulator, rowOffset + site, f64x2.mul(initialWeightVector, value));
      }
      for (; site < blockCount; site += 1) {
        const value = values[sourceOffset + site];
        workA[rowOffset + site] = value;
        accumulator[rowOffset + site] = weight * value;
      }
    }
    let read = workA;
    let write = workB;
    const maximumTerms = poissonTerms > 0 ? poissonTerms : 256;
    for (let term = 1; term <= maximumTerms; term += 1) {
      for (let state = 0; state < stateCount; state += 1) {
        const rowOffset = state * SITE_BLOCK;
        const diagonal = rDiagonal[modelDiagonalOffset + state];
        const count = <i32>neighborCount[state];
        const topologyOffset = state * maxNeighbors;
        const rateOffset = modelRateOffset + topologyOffset;
        const diagonalVector = f64x2.splat(diagonal);
        let site = 0;
        for (; site + 1 < blockCount; site += 2) {
          let next = f64x2.mul(diagonalVector, loadF64x2(read, rowOffset + site));
          for (let neighbor = 0; neighbor < count; neighbor += 1) {
            const rate = f64x2.splat(rOffDiagonal[rateOffset + neighbor]);
            const neighborOffset = <i32>neighborIndex[topologyOffset + neighbor] * SITE_BLOCK;
            next = f64x2.add(next, f64x2.mul(rate, loadF64x2(read, neighborOffset + site)));
          }
          storeF64x2(write, rowOffset + site, next);
        }
        for (; site < blockCount; site += 1) {
          let next = diagonal * read[rowOffset + site];
          for (let neighbor = 0; neighbor < count; neighbor += 1) {
            const neighborOffset = <i32>neighborIndex[topologyOffset + neighbor] * SITE_BLOCK;
            next += rOffDiagonal[rateOffset + neighbor] * read[neighborOffset + site];
          }
          write[rowOffset + site] = next;
        }
      }
      weight *= stepLambda / <f64>term;
      cumulativeWeight += weight;
      const weightVector = f64x2.splat(weight);
      for (let state = 0; state < stateCount; state += 1) {
        const rowOffset = state * SITE_BLOCK;
        let site = 0;
        for (; site + 1 < blockCount; site += 2) {
          const updated = f64x2.add(
            loadF64x2(accumulator, rowOffset + site),
            f64x2.mul(weightVector, loadF64x2(write, rowOffset + site)),
          );
          storeF64x2(accumulator, rowOffset + site, updated);
        }
        for (; site < blockCount; site += 1) accumulator[rowOffset + site] += weight * write[rowOffset + site];
      }
      const swap = read;
      read = write;
      write = swap;
      if (poissonTerms <= 0 && <f64>term > stepLambda && 1.0 - cumulativeWeight <= 1e-14) break;
    }
    for (let state = 0; state < stateCount; state += 1) {
      const rowOffset = state * SITE_BLOCK;
      const destinationOffset = valueOffset + rowOffset;
      let site = 0;
      for (; site + 1 < blockCount; site += 2) {
        storeF64x2(values, destinationOffset + site, loadF64x2(accumulator, rowOffset + site));
      }
      for (; site < blockCount; site += 1) values[destinationOffset + site] = accumulator[rowOffset + site];
    }
  }
}

@inline function multiplyNormalizeBlock(
  values: Float64Array,
  scales: Float64Array,
  a: i32,
  b: i32,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): void {
  const aOffset = a * stateCount * SITE_BLOCK;
  const bOffset = b * stateCount * SITE_BLOCK;
  const zero = f64x2.splat(0.0);
  let site = 0;
  for (; site + 1 < blockCount; site += 2) storeF64x2(siteSums, site, zero);
  for (; site < blockCount; site += 1) siteSums[site] = 0.0;

  for (let state = 0; state < stateCount; state += 1) {
    const aRow = aOffset + state * SITE_BLOCK;
    const bRow = bOffset + state * SITE_BLOCK;
    site = 0;
    for (; site + 1 < blockCount; site += 2) {
      const product = f64x2.mul(loadF64x2(values, aRow + site), loadF64x2(values, bRow + site));
      storeF64x2(values, aRow + site, product);
      storeF64x2(siteSums, site, f64x2.add(loadF64x2(siteSums, site), product));
    }
    for (; site < blockCount; site += 1) {
      const product = values[aRow + site] * values[bRow + site];
      values[aRow + site] = product;
      siteSums[site] += product;
    }
  }

  const aScaleOffset = a * SITE_BLOCK;
  const bScaleOffset = b * SITE_BLOCK;
  for (site = 0; site < blockCount; site += 1) {
    const sum = siteSums[site];
    scales[aScaleOffset + site] = sum > 0.0
      ? scales[aScaleOffset + site] + scales[bScaleOffset + site] + Math.log(sum)
      : -Infinity;
    siteSums[site] = sum > 0.0 ? 1.0 / sum : 0.0;
  }

  for (let state = 0; state < stateCount; state += 1) {
    const aRow = aOffset + state * SITE_BLOCK;
    site = 0;
    for (; site + 1 < blockCount; site += 2) {
      storeF64x2(values, aRow + site, f64x2.mul(loadF64x2(values, aRow + site), loadF64x2(siteSums, site)));
    }
    for (; site < blockCount; site += 1) values[aRow + site] *= siteSums[site];
  }
}

@inline function sumRootBlock(
  values: Float64Array,
  equilibrium: Float64Array,
  rootOffset: i32,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): void {
  const zero = f64x2.splat(0.0);
  let site = 0;
  for (; site + 1 < blockCount; site += 2) storeF64x2(siteSums, site, zero);
  for (; site < blockCount; site += 1) siteSums[site] = 0.0;
  for (let state = 0; state < stateCount; state += 1) {
    const rootRow = rootOffset + state * SITE_BLOCK;
    const frequency = f64x2.splat(equilibrium[state]);
    site = 0;
    for (; site + 1 < blockCount; site += 2) {
      storeF64x2(
        siteSums,
        site,
        f64x2.add(loadF64x2(siteSums, site), f64x2.mul(frequency, loadF64x2(values, rootRow + site))),
      );
    }
    for (; site < blockCount; site += 1) siteSums[site] += equilibrium[state] * values[rootRow + site];
  }
}

@inline function copySlot(
  destination: Float64Array,
  destinationSlot: i32,
  source: Float64Array,
  sourceSlot: i32,
  stateCount: i32,
  blockCount: i32,
): void {
  const destinationOffset = destinationSlot * stateCount * SITE_BLOCK;
  const sourceOffset = sourceSlot * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    copyF64Range(destination, destinationOffset + state * SITE_BLOCK, source, sourceOffset + state * SITE_BLOCK, blockCount);
  }
}

@inline function copyScale(
  destination: Float64Array,
  destinationSlot: i32,
  source: Float64Array,
  sourceSlot: i32,
  blockCount: i32,
): void {
  copyF64Range(destination, destinationSlot * SITE_BLOCK, source, sourceSlot * SITE_BLOCK, blockCount);
}

/** Normalize a state-by-site slot and fold its norm into an existing log scale. */
function normalizeSlot(
  values: Float64Array,
  scales: Float64Array,
  slot: i32,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): void {
  const valueOffset = slot * stateCount * SITE_BLOCK;
  const scaleOffset = slot * SITE_BLOCK;
  for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
  for (let state = 0; state < stateCount; state += 1) {
    const row = valueOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) siteSums[site] += values[row + site];
  }
  for (let site = 0; site < blockCount; site += 1) {
    const total = siteSums[site];
    if (total > 0.0 && isFinite(total)) {
      scales[scaleOffset + site] += Math.log(total);
      siteSums[site] = 1.0 / total;
    } else {
      scales[scaleOffset + site] = -Infinity;
      siteSums[site] = 0.0;
    }
  }
  for (let state = 0; state < stateCount; state += 1) {
    const row = valueOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) values[row + site] *= siteSums[site];
  }
}

/** Multiply slots from separate message banks and normalize the destination. */
function multiplyExternalNormalize(
  destinationValues: Float64Array,
  destinationScales: Float64Array,
  destinationSlot: i32,
  sourceValues: Float64Array,
  sourceScales: Float64Array,
  sourceSlot: i32,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): void {
  const destinationOffset = destinationSlot * stateCount * SITE_BLOCK;
  const sourceOffset = sourceSlot * stateCount * SITE_BLOCK;
  const destinationScaleOffset = destinationSlot * SITE_BLOCK;
  const sourceScaleOffset = sourceSlot * SITE_BLOCK;
  for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
  for (let state = 0; state < stateCount; state += 1) {
    const destinationRow = destinationOffset + state * SITE_BLOCK;
    const sourceRow = sourceOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) {
      const product = destinationValues[destinationRow + site] * sourceValues[sourceRow + site];
      destinationValues[destinationRow + site] = product;
      siteSums[site] += product;
    }
  }
  for (let site = 0; site < blockCount; site += 1) {
    const total = siteSums[site];
    if (total > 0.0 && isFinite(total)) {
      destinationScales[destinationScaleOffset + site] += sourceScales[sourceScaleOffset + site] + Math.log(total);
      siteSums[site] = 1.0 / total;
    } else {
      destinationScales[destinationScaleOffset + site] = -Infinity;
      siteSums[site] = 0.0;
    }
  }
  for (let state = 0; state < stateCount; state += 1) {
    const row = destinationOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) destinationValues[row + site] *= siteSums[site];
  }
}

/** Build and retain all three transformed components for one baseline edge. */
function propagateBaselineMixture(
  edgeValues: Float64Array,
  edgeScales: Float64Array,
  edgeComponents: Float64Array,
  edge: i32,
  sourceValues: Float64Array,
  sourceScales: Float64Array,
  sourceSlot: i32,
  blockCount: i32,
  branchLength: f64,
  branchModels: Uint32Array,
  branchWeights: Float64Array,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
  siteSums: Float64Array,
): void {
  const parameterOffset = edge * 3;
  for (let component = 0; component < 3; component += 1) {
    const componentSlot = parameterOffset + component;
    copySlot(edgeComponents, componentSlot, sourceValues, sourceSlot, stateCount, blockCount);
    propagateBlock(
      edgeComponents, componentSlot, blockCount, branchLength, <i32>branchModels[componentSlot],
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, workA, workB, accumulator,
    );
  }
  const destinationOffset = edge * stateCount * SITE_BLOCK;
  const source0 = parameterOffset * stateCount * SITE_BLOCK;
  const source1 = (parameterOffset + 1) * stateCount * SITE_BLOCK;
  const source2 = (parameterOffset + 2) * stateCount * SITE_BLOCK;
  const weight0 = branchWeights[parameterOffset];
  const weight1 = branchWeights[parameterOffset + 1];
  const weight2 = branchWeights[parameterOffset + 2];
  for (let state = 0; state < stateCount; state += 1) {
    const destinationRow = destinationOffset + state * SITE_BLOCK;
    const row0 = source0 + state * SITE_BLOCK;
    const row1 = source1 + state * SITE_BLOCK;
    const row2 = source2 + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) {
      edgeValues[destinationRow + site] = weight0 * edgeComponents[row0 + site]
        + weight1 * edgeComponents[row1 + site]
        + weight2 * edgeComponents[row2 + site];
    }
  }
  copyScale(edgeScales, edge, sourceScales, sourceSlot, blockCount);
  normalizeSlot(edgeValues, edgeScales, edge, stateCount, blockCount, siteSums);
}

/** Propagate a parent-side joint message in the forward direction by reversibility. */
function propagateForwardMixture(
  outsideValues: Float64Array,
  outsideScales: Float64Array,
  childNode: i32,
  contextValues: Float64Array,
  contextScales: Float64Array,
  edge: i32,
  branchLength: f64,
  branchModels: Uint32Array,
  branchWeights: Float64Array,
  equilibrium: Float64Array,
  scratchComponents: Float64Array,
  blockCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
  siteSums: Float64Array,
): void {
  const contextOffset = edge * stateCount * SITE_BLOCK;
  const parameterOffset = edge * 3;
  for (let component = 0; component < 3; component += 1) {
    const componentOffset = component * stateCount * SITE_BLOCK;
    for (let state = 0; state < stateCount; state += 1) {
      const sourceRow = contextOffset + state * SITE_BLOCK;
      const destinationRow = componentOffset + state * SITE_BLOCK;
      const inverseEquilibrium = 1.0 / equilibrium[state];
      for (let site = 0; site < blockCount; site += 1) {
        scratchComponents[destinationRow + site] = contextValues[sourceRow + site] * inverseEquilibrium;
      }
    }
    propagateBlock(
      scratchComponents, component, blockCount, branchLength, <i32>branchModels[parameterOffset + component],
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu, workA, workB, accumulator,
    );
  }
  const destinationOffset = childNode * stateCount * SITE_BLOCK;
  const weight0 = branchWeights[parameterOffset];
  const weight1 = branchWeights[parameterOffset + 1];
  const weight2 = branchWeights[parameterOffset + 2];
  for (let state = 0; state < stateCount; state += 1) {
    const destinationRow = destinationOffset + state * SITE_BLOCK;
    const row0 = state * SITE_BLOCK;
    const row1 = stateCount * SITE_BLOCK + state * SITE_BLOCK;
    const row2 = 2 * stateCount * SITE_BLOCK + state * SITE_BLOCK;
    const pi = equilibrium[state];
    for (let site = 0; site < blockCount; site += 1) {
      outsideValues[destinationRow + site] = pi * (
        weight0 * scratchComponents[row0 + site]
        + weight1 * scratchComponents[row1 + site]
        + weight2 * scratchComponents[row2 + site]
      );
    }
  }
  copyScale(outsideScales, childNode, contextScales, edge, blockCount);
  normalizeSlot(outsideValues, outsideScales, childNode, stateCount, blockCount, siteSums);
}

/** Divide a full node blanket by one strictly-positive child contribution. */
function divideBlanket(
  contextValues: Float64Array,
  contextScales: Float64Array,
  edge: i32,
  totalValues: Float64Array,
  totalScales: Float64Array,
  edgeValues: Float64Array,
  edgeScales: Float64Array,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): bool {
  const contextOffset = edge * stateCount * SITE_BLOCK;
  const edgeOffset = edge * stateCount * SITE_BLOCK;
  let valid = true;
  for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
  for (let state = 0; state < stateCount; state += 1) {
    const totalRow = state * SITE_BLOCK;
    const edgeRow = edgeOffset + state * SITE_BLOCK;
    const contextRow = contextOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) {
      const denominator = edgeValues[edgeRow + site];
      if (!(denominator > 0.0)) valid = false;
      const value = denominator > 0.0 ? totalValues[totalRow + site] / denominator : 0.0;
      contextValues[contextRow + site] = value;
      siteSums[site] += value;
    }
  }
  const contextScaleOffset = edge * SITE_BLOCK;
  const edgeScaleOffset = edge * SITE_BLOCK;
  for (let site = 0; site < blockCount; site += 1) {
    const total = siteSums[site];
    if (total > 0.0 && isFinite(total)) {
      contextScales[contextScaleOffset + site] = totalScales[site] - edgeScales[edgeScaleOffset + site] + Math.log(total);
      siteSums[site] = 1.0 / total;
    } else {
      contextScales[contextScaleOffset + site] = -Infinity;
      siteSums[site] = 0.0;
      valid = false;
    }
  }
  for (let state = 0; state < stateCount; state += 1) {
    const row = contextOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) contextValues[row + site] *= siteSums[site];
  }
  return valid;
}

function buildBlanketFallback(
  contextValues: Float64Array,
  contextScales: Float64Array,
  edge: i32,
  parentNode: i32,
  childOffsets: Uint32Array,
  children: Uint32Array,
  edgeForNode: Int32Array,
  outsideValues: Float64Array,
  outsideScales: Float64Array,
  edgeValues: Float64Array,
  edgeScales: Float64Array,
  stateCount: i32,
  blockCount: i32,
  siteSums: Float64Array,
): void {
  copySlot(contextValues, edge, outsideValues, parentNode, stateCount, blockCount);
  copyScale(contextScales, edge, outsideScales, parentNode, blockCount);
  const start = <i32>childOffsets[parentNode];
  const end = <i32>childOffsets[parentNode + 1];
  for (let childIndex = start; childIndex < end; childIndex += 1) {
    const siblingEdge = edgeForNode[<i32>children[childIndex]];
    if (siblingEdge == edge) continue;
    multiplyExternalNormalize(
      contextValues, contextScales, edge, edgeValues, edgeScales, siblingEdge,
      stateCount, blockCount, siteSums,
    );
  }
}

/**
 * Fixed three-rate BS-REL kernel. One upward pass and one reversible downward
 * pass expose the exact local blanket around every edge. Candidate objectives
 * then replace only their selected edge and never re-prune the rest of tree.
 */
export function evaluateBsrelAllMessages(
  childOffsets: Uint32Array,
  children: Uint32Array,
  tipForNode: Int32Array,
  edgeForNode: Int32Array,
  nodeForEdge: Uint32Array,
  postorder: Uint32Array,
  preorder: Uint32Array,
  tipStates: Uint8Array,
  branchLengths: Float64Array,
  branchModels: Uint32Array,
  branchWeights: Float64Array,
  candidateBranches: Uint32Array,
  candidateLengths: Float64Array,
  candidateModels: Uint32Array,
  candidateWeights: Float64Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  nodeCount: i32,
  edgeCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  root: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const candidateCount = candidateBranches.length;
  const result = new Float64Array(candidateCount + 1);
  const upValues = new Float64Array(nodeCount * stateCount * SITE_BLOCK);
  const upScales = new Float64Array(nodeCount * SITE_BLOCK);
  const edgeValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const edgeScales = new Float64Array(edgeCount * SITE_BLOCK);
  const edgeComponents = new Float64Array(edgeCount * 3 * stateCount * SITE_BLOCK);
  const outsideValues = new Float64Array(nodeCount * stateCount * SITE_BLOCK);
  const outsideScales = new Float64Array(nodeCount * SITE_BLOCK);
  const contextValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const contextScales = new Float64Array(edgeCount * SITE_BLOCK);
  const totalValues = new Float64Array(stateCount * SITE_BLOCK);
  const totalScales = new Float64Array(SITE_BLOCK);
  const scratchComponents = new Float64Array(4 * stateCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);

  for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
    const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);

    // Tip-to-root pass. Edge mixtures are normalized individually and retain
    // their component transforms for cheap local finite differences.
    for (let order = 0; order < postorder.length; order += 1) {
      const node = <i32>postorder[order];
      const start = <i32>childOffsets[node];
      const end = <i32>childOffsets[node + 1];
      if (start == end) {
        const tip = tipForNode[node];
        const valueOffset = node * stateCount * SITE_BLOCK;
        for (let state = 0; state < stateCount; state += 1) {
          const row = valueOffset + state * SITE_BLOCK;
          for (let site = 0; site < blockCount; site += 1) {
            const observed = tipStates[tip * siteCount + blockStart + site];
            upValues[row + site] = observed == 255 || observed == state ? 1.0 : 0.0;
          }
        }
        const scaleOffset = node * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) upScales[scaleOffset + site] = 0.0;
      } else {
        const firstChild = <i32>children[start];
        const firstEdge = edgeForNode[firstChild];
        copySlot(upValues, node, edgeValues, firstEdge, stateCount, blockCount);
        copyScale(upScales, node, edgeScales, firstEdge, blockCount);
        for (let childIndex = start + 1; childIndex < end; childIndex += 1) {
          const child = <i32>children[childIndex];
          const edge = edgeForNode[child];
          multiplyExternalNormalize(
            upValues, upScales, node, edgeValues, edgeScales, edge,
            stateCount, blockCount, siteSums,
          );
        }
      }
      const edge = edgeForNode[node];
      if (edge >= 0) {
        propagateBaselineMixture(
          edgeValues, edgeScales, edgeComponents, edge,
          upValues, upScales, node, blockCount,
          branchLengths[edge], branchModels, branchWeights,
          stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
          neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
          workA, workB, accumulator, siteSums,
        );
      }
    }

    const rootOffset = root * stateCount * SITE_BLOCK;
    const rootScaleOffset = root * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
    for (let state = 0; state < stateCount; state += 1) {
      const row = rootOffset + state * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) siteSums[site] += equilibrium[state] * upValues[row + site];
    }
    for (let site = 0; site < blockCount; site += 1) {
      const rootSum = siteSums[site];
      if (rootSum > 0.0 && isFinite(result[0])) result[0] += upScales[rootScaleOffset + site] + Math.log(rootSum);
      else result[0] = -Infinity;
    }
    if (candidateCount == 0) continue;

    // Root-to-tip pass. The complete node blanket is divided by each positive
    // child message; a zero-safe sibling product handles exact zero branches.
    const outsideRootOffset = root * stateCount * SITE_BLOCK;
    for (let state = 0; state < stateCount; state += 1) {
      const row = outsideRootOffset + state * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) outsideValues[row + site] = equilibrium[state];
    }
    const outsideRootScale = root * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) outsideScales[outsideRootScale + site] = 0.0;

    for (let order = 0; order < preorder.length; order += 1) {
      const parentNode = <i32>preorder[order];
      const start = <i32>childOffsets[parentNode];
      const end = <i32>childOffsets[parentNode + 1];
      if (start == end) continue;
      copySlot(totalValues, 0, outsideValues, parentNode, stateCount, blockCount);
      copyScale(totalScales, 0, outsideScales, parentNode, blockCount);
      for (let childIndex = start; childIndex < end; childIndex += 1) {
        const child = <i32>children[childIndex];
        const edge = edgeForNode[child];
        multiplyExternalNormalize(
          totalValues, totalScales, 0, edgeValues, edgeScales, edge,
          stateCount, blockCount, siteSums,
        );
      }
      for (let childIndex = start; childIndex < end; childIndex += 1) {
        const child = <i32>children[childIndex];
        const edge = edgeForNode[child];
        if (!divideBlanket(
          contextValues, contextScales, edge,
          totalValues, totalScales, edgeValues, edgeScales,
          stateCount, blockCount, siteSums,
        )) {
          buildBlanketFallback(
            contextValues, contextScales, edge, parentNode,
            childOffsets, children, edgeForNode,
            outsideValues, outsideScales, edgeValues, edgeScales,
            stateCount, blockCount, siteSums,
          );
        }
        propagateForwardMixture(
          outsideValues, outsideScales, child,
          contextValues, contextScales, edge,
          branchLengths[edge], branchModels, branchWeights, equilibrium,
          scratchComponents, blockCount, stateCount, maxNeighbors,
          poissonTerms, maxLambdaPerStep,
          neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
          workA, workB, accumulator, siteSums,
        );
      }
    }

    // Exact local edge replacements. Components unchanged from the baseline
    // are read from the retained transform, so a one-parameter perturbation
    // usually needs one propagation instead of three.
    for (let candidate = 0; candidate < candidateCount; candidate += 1) {
      const edge = <i32>candidateBranches[candidate];
      const childNode = <i32>nodeForEdge[edge];
      const candidateOffset = candidate * 3;
      const baselineOffset = edge * 3;
      const sameLength = candidateLengths[candidate] == branchLengths[edge];
      for (let component = 0; component < 3; component += 1) {
        if (sameLength && candidateModels[candidateOffset + component] == branchModels[baselineOffset + component]) continue;
        copySlot(scratchComponents, component, upValues, childNode, stateCount, blockCount);
        propagateBlock(
          scratchComponents, component, blockCount, candidateLengths[candidate], <i32>candidateModels[candidateOffset + component],
          stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
          neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
          workA, workB, accumulator,
        );
      }
      const mixedSlot = 3;
      const mixedOffset = mixedSlot * stateCount * SITE_BLOCK;
      for (let state = 0; state < stateCount; state += 1) {
        const mixedRow = mixedOffset + state * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) {
          let value = 0.0;
          for (let component = 0; component < 3; component += 1) {
            const reuse = sameLength && candidateModels[candidateOffset + component] == branchModels[baselineOffset + component];
            const sourceOffset = reuse
              ? (baselineOffset + component) * stateCount * SITE_BLOCK
              : component * stateCount * SITE_BLOCK;
            if (reuse) value += candidateWeights[candidateOffset + component]
              * edgeComponents[sourceOffset + state * SITE_BLOCK + site];
            else value += candidateWeights[candidateOffset + component]
              * scratchComponents[sourceOffset + state * SITE_BLOCK + site];
          }
          scratchComponents[mixedRow + site] = value;
        }
      }
      const contextOffset = edge * stateCount * SITE_BLOCK;
      const contextScaleOffset = edge * SITE_BLOCK;
      const childScaleOffset = childNode * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
      for (let state = 0; state < stateCount; state += 1) {
        const contextRow = contextOffset + state * SITE_BLOCK;
        const mixedRow = mixedOffset + state * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) {
          siteSums[site] += contextValues[contextRow + site] * scratchComponents[mixedRow + site];
        }
      }
      for (let site = 0; site < blockCount; site += 1) {
        const dot = siteSums[site];
        if (dot > 0.0 && isFinite(dot) && isFinite(result[candidate + 1])) {
          result[candidate + 1] += contextScales[contextScaleOffset + site]
            + upScales[childScaleOffset + site] + Math.log(dot);
        } else result[candidate + 1] = -Infinity;
      }
    }
  }
  return result;
}

@inline function logAddExp(left: f64, right: f64): f64 {
  if (left == -Infinity) return right;
  if (right == -Infinity) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

/**
 * Apply the shared omega mixture to one child message. The normalized full
 * edge message is used for pruning; unnormalised low- and positive-tail
 * pieces retain the child's scale for exact local capped-edge contractions.
 */
function propagateGlobalGammaEdge(
  edgeValues: Float64Array,
  edgeScales: Float64Array,
  lowValues: Float64Array,
  positiveValues: Float64Array,
  edge: i32,
  sourceValues: Float64Array,
  sourceScales: Float64Array,
  sourceSlot: i32,
  blockCount: i32,
  branchLength: f64,
  omegaModels: Uint32Array,
  omegaWeights: Float64Array,
  positiveMask: Uint8Array,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  component: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
  siteSums: Float64Array,
): void {
  const destinationOffset = edge * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    const row = destinationOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) {
      edgeValues[row + site] = 0.0;
      lowValues[row + site] = 0.0;
      positiveValues[row + site] = 0.0;
    }
  }
  for (let omega = 0; omega < omegaModels.length; omega += 1) {
    copySlot(component, 0, sourceValues, sourceSlot, stateCount, blockCount);
    propagateBlock(
      component, 0, blockCount, branchLength, <i32>omegaModels[omega],
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
      workA, workB, accumulator,
    );
    const weight = omegaWeights[omega];
    const positive = positiveMask[omega] != 0;
    for (let state = 0; state < stateCount; state += 1) {
      const destinationRow = destinationOffset + state * SITE_BLOCK;
      const componentRow = state * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) {
        const value = weight * component[componentRow + site];
        edgeValues[destinationRow + site] += value;
        if (positive) positiveValues[destinationRow + site] += value;
        else lowValues[destinationRow + site] += value;
      }
    }
  }
  copyScale(edgeScales, edge, sourceScales, sourceSlot, blockCount);
  normalizeSlot(edgeValues, edgeScales, edge, stateCount, blockCount, siteSums);
}

/** Reversible parent-to-child propagation under the shared omega mixture. */
function propagateForwardGlobalGamma(
  outsideValues: Float64Array,
  outsideScales: Float64Array,
  childNode: i32,
  contextValues: Float64Array,
  contextScales: Float64Array,
  edge: i32,
  branchLength: f64,
  omegaModels: Uint32Array,
  omegaWeights: Float64Array,
  equilibrium: Float64Array,
  component: Float64Array,
  blockCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
  siteSums: Float64Array,
): void {
  const contextOffset = edge * stateCount * SITE_BLOCK;
  const destinationOffset = childNode * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    const row = destinationOffset + state * SITE_BLOCK;
    for (let site = 0; site < blockCount; site += 1) outsideValues[row + site] = 0.0;
  }
  for (let omega = 0; omega < omegaModels.length; omega += 1) {
    for (let state = 0; state < stateCount; state += 1) {
      const sourceRow = contextOffset + state * SITE_BLOCK;
      const componentRow = state * SITE_BLOCK;
      const inverseEquilibrium = 1.0 / equilibrium[state];
      for (let site = 0; site < blockCount; site += 1) {
        component[componentRow + site] = contextValues[sourceRow + site] * inverseEquilibrium;
      }
    }
    propagateBlock(
      component, 0, blockCount, branchLength, <i32>omegaModels[omega],
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
      workA, workB, accumulator,
    );
    const weight = omegaWeights[omega];
    for (let state = 0; state < stateCount; state += 1) {
      const destinationRow = destinationOffset + state * SITE_BLOCK;
      const componentRow = state * SITE_BLOCK;
      const pi = equilibrium[state];
      for (let site = 0; site < blockCount; site += 1) {
        outsideValues[destinationRow + site] += pi * weight * component[componentRow + site];
      }
    }
  }
  copyScale(outsideScales, childNode, contextScales, edge, blockCount);
  normalizeSlot(outsideValues, outsideScales, childNode, stateCount, blockCount, siteSums);
}

/**
 * Glamma branch/site scan. Alpha is integrated as a site-level outer
 * mixture. Omega is independently integrated on each branch. A single upward
 * and downward pass per alpha rate yields every exact one-edge cap and every
 * positive-tail responsibility without branch-wise re-pruning.
 *
 * Output layout: site alternative log L; edge-major capped-edge log L;
 * edge-major positive-tail log likelihood mass.
 */
export function evaluateGlobalGammaAllMessages(
  childOffsets: Uint32Array,
  children: Uint32Array,
  tipForNode: Int32Array,
  edgeForNode: Int32Array,
  nodeForEdge: Uint32Array,
  postorder: Uint32Array,
  preorder: Uint32Array,
  tipStates: Uint8Array,
  branchLengths: Float64Array,
  omegaModels: Uint32Array,
  omegaWeights: Float64Array,
  positiveMask: Uint8Array,
  neutralModel: i32,
  alphaValues: Float64Array,
  alphaWeights: Float64Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  nodeCount: i32,
  edgeCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  root: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const matrixSize = edgeCount * siteCount;
  const cappedResultOffset = siteCount;
  const positiveResultOffset = siteCount + matrixSize;
  const result = new Float64Array(siteCount + matrixSize * 2);
  for (let index = 0; index < result.length; index += 1) result[index] = -Infinity;

  let positiveWeight = 0.0;
  for (let omega = 0; omega < omegaWeights.length; omega += 1) {
    if (positiveMask[omega] != 0) positiveWeight += omegaWeights[omega];
  }

  const upValues = new Float64Array(nodeCount * stateCount * SITE_BLOCK);
  const upScales = new Float64Array(nodeCount * SITE_BLOCK);
  const edgeValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const edgeScales = new Float64Array(edgeCount * SITE_BLOCK);
  const lowValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const positiveValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const outsideValues = new Float64Array(nodeCount * stateCount * SITE_BLOCK);
  const outsideScales = new Float64Array(nodeCount * SITE_BLOCK);
  const contextValues = new Float64Array(edgeCount * stateCount * SITE_BLOCK);
  const contextScales = new Float64Array(edgeCount * SITE_BLOCK);
  const totalValues = new Float64Array(stateCount * SITE_BLOCK);
  const totalScales = new Float64Array(SITE_BLOCK);
  const component = new Float64Array(stateCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const positiveSums = new Float64Array(SITE_BLOCK);

  for (let alpha = 0; alpha < alphaValues.length; alpha += 1) {
    const logAlphaWeight = Math.log(alphaWeights[alpha]);
    const alphaScale = alphaValues[alpha];
    for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
      const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);

      for (let order = 0; order < postorder.length; order += 1) {
        const node = <i32>postorder[order];
        const start = <i32>childOffsets[node];
        const end = <i32>childOffsets[node + 1];
        if (start == end) {
          const tip = tipForNode[node];
          const valueOffset = node * stateCount * SITE_BLOCK;
          for (let state = 0; state < stateCount; state += 1) {
            const row = valueOffset + state * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) {
              const observed = tipStates[tip * siteCount + blockStart + site];
              upValues[row + site] = observed == 255 || observed == state ? 1.0 : 0.0;
            }
          }
          const scaleOffset = node * SITE_BLOCK;
          for (let site = 0; site < blockCount; site += 1) upScales[scaleOffset + site] = 0.0;
        } else {
          const firstChild = <i32>children[start];
          const firstEdge = edgeForNode[firstChild];
          copySlot(upValues, node, edgeValues, firstEdge, stateCount, blockCount);
          copyScale(upScales, node, edgeScales, firstEdge, blockCount);
          for (let childIndex = start + 1; childIndex < end; childIndex += 1) {
            const child = <i32>children[childIndex];
            const edge = edgeForNode[child];
            multiplyExternalNormalize(
              upValues, upScales, node, edgeValues, edgeScales, edge,
              stateCount, blockCount, siteSums,
            );
          }
        }
        const edge = edgeForNode[node];
        if (edge >= 0) {
          propagateGlobalGammaEdge(
            edgeValues, edgeScales, lowValues, positiveValues, edge,
            upValues, upScales, node, blockCount,
            branchLengths[edge] * alphaScale, omegaModels, omegaWeights, positiveMask,
            stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
            neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
            component, workA, workB, accumulator, siteSums,
          );
        }
      }

      const rootOffset = root * stateCount * SITE_BLOCK;
      const rootScaleOffset = root * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) siteSums[site] = 0.0;
      for (let state = 0; state < stateCount; state += 1) {
        const row = rootOffset + state * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) siteSums[site] += equilibrium[state] * upValues[row + site];
      }
      for (let site = 0; site < blockCount; site += 1) {
        const rootSum = siteSums[site];
        const siteIndex = blockStart + site;
        if (rootSum > 0.0) {
          const logLikelihood = upScales[rootScaleOffset + site] + Math.log(rootSum);
          result[siteIndex] = logAddExp(result[siteIndex], logAlphaWeight + logLikelihood);
        }
      }

      const outsideRootOffset = root * stateCount * SITE_BLOCK;
      for (let state = 0; state < stateCount; state += 1) {
        const row = outsideRootOffset + state * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) outsideValues[row + site] = equilibrium[state];
      }
      const outsideRootScale = root * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) outsideScales[outsideRootScale + site] = 0.0;

      for (let order = 0; order < preorder.length; order += 1) {
        const parentNode = <i32>preorder[order];
        const start = <i32>childOffsets[parentNode];
        const end = <i32>childOffsets[parentNode + 1];
        if (start == end) continue;
        copySlot(totalValues, 0, outsideValues, parentNode, stateCount, blockCount);
        copyScale(totalScales, 0, outsideScales, parentNode, blockCount);
        for (let childIndex = start; childIndex < end; childIndex += 1) {
          const child = <i32>children[childIndex];
          const edge = edgeForNode[child];
          multiplyExternalNormalize(totalValues, totalScales, 0, edgeValues, edgeScales, edge, stateCount, blockCount, siteSums);
        }
        for (let childIndex = start; childIndex < end; childIndex += 1) {
          const child = <i32>children[childIndex];
          const edge = edgeForNode[child];
          if (!divideBlanket(
            contextValues, contextScales, edge,
            totalValues, totalScales, edgeValues, edgeScales,
            stateCount, blockCount, siteSums,
          )) {
            buildBlanketFallback(
              contextValues, contextScales, edge, parentNode,
              childOffsets, children, edgeForNode,
              outsideValues, outsideScales, edgeValues, edgeScales,
              stateCount, blockCount, siteSums,
            );
          }
          propagateForwardGlobalGamma(
            outsideValues, outsideScales, child,
            contextValues, contextScales, edge,
            branchLengths[edge] * alphaScale, omegaModels, omegaWeights, equilibrium,
            component, blockCount, stateCount, maxNeighbors, poissonTerms,
            maxLambdaPerStep, neighborCount, neighborIndex, rDiagonal,
            rOffDiagonal, mu, workA, workB, accumulator, siteSums,
          );
        }
      }

      for (let edge = 0; edge < edgeCount; edge += 1) {
        const childNode = <i32>nodeForEdge[edge];
        copySlot(component, 0, upValues, childNode, stateCount, blockCount);
        propagateBlock(
          component, 0, blockCount, branchLengths[edge] * alphaScale, neutralModel,
          stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
          neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
          workA, workB, accumulator,
        );
        const contextOffset = edge * stateCount * SITE_BLOCK;
        const rawOffset = edge * stateCount * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) {
          siteSums[site] = 0.0;
          positiveSums[site] = 0.0;
        }
        for (let state = 0; state < stateCount; state += 1) {
          const contextRow = contextOffset + state * SITE_BLOCK;
          const rawRow = rawOffset + state * SITE_BLOCK;
          const neutralRow = state * SITE_BLOCK;
          for (let site = 0; site < blockCount; site += 1) {
            const context = contextValues[contextRow + site];
            const capped = lowValues[rawRow + site] + positiveWeight * component[neutralRow + site];
            siteSums[site] += context * capped;
            positiveSums[site] += context * positiveValues[rawRow + site];
          }
        }
        const contextScaleOffset = edge * SITE_BLOCK;
        const childScaleOffset = childNode * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) {
          const siteIndex = blockStart + site;
          const matrixIndex = edge * siteCount + siteIndex;
          const commonScale = contextScales[contextScaleOffset + site] + upScales[childScaleOffset + site];
          const cappedDot = siteSums[site];
          if (cappedDot > 0.0) {
            const value = logAlphaWeight + commonScale + Math.log(cappedDot);
            const outputIndex = cappedResultOffset + matrixIndex;
            result[outputIndex] = logAddExp(result[outputIndex], value);
          }
          const positiveDot = positiveSums[site];
          if (positiveDot > 0.0) {
            const value = logAlphaWeight + commonScale + Math.log(positiveDot);
            const outputIndex = positiveResultOffset + matrixIndex;
            result[outputIndex] = logAddExp(result[outputIndex], value);
          }
        }
      }
    }
  }
  return result;
}

/** Exact f64 CPU/WASM pruning backend, output in category-major order. */
export function evaluateLikelihood(
  ops: Uint32Array,
  edgeLengths: Float64Array,
  tipStates: Uint8Array,
  gridModels: Uint32Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  gridCount: i32,
  classCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  slotCount: i32,
  rootSlot: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const result = new Float64Array(gridCount * siteCount);
  const values = new Float64Array(slotCount * stateCount * SITE_BLOCK);
  const scales = new Float64Array(slotCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const opCount = ops.length >> 2;

  for (let grid = 0; grid < gridCount; grid += 1) {
    for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
      const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);
      for (let operation = 0; operation < opCount; operation += 1) {
        const operationOffset = operation << 2;
        const opcode = ops[operationOffset];
        const a = <i32>ops[operationOffset + 1];
        const b = <i32>ops[operationOffset + 2];
        const payload = <i32>ops[operationOffset + 3];
        if (opcode == LOAD_TIP) {
          const valueOffset = a * stateCount * SITE_BLOCK;
          for (let state = 0; state < stateCount; state += 1) {
            const destinationOffset = valueOffset + state * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) {
              const observed = tipStates[payload * siteCount + blockStart + site];
              let compatible = observed == 255 || state == observed;
              if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
              values[destinationOffset + site] = compatible ? 1.0 : 0.0;
            }
          }
          const scaleOffset = a * SITE_BLOCK;
          for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
        } else if (opcode == TRANSFORM) {
          const model = <i32>gridModels[grid * classCount + b];
          propagateBlock(
            values, a, blockCount, edgeLengths[payload], model, stateCount, maxNeighbors,
            poissonTerms, maxLambdaPerStep, neighborCount, neighborIndex,
            rDiagonal, rOffDiagonal, mu, workA, workB, accumulator,
          );
        } else if (opcode == MULTIPLY_NORMALIZE) {
          multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
        }
      }
      const rootOffset = rootSlot * stateCount * SITE_BLOCK;
      sumRootBlock(values, equilibrium, rootOffset, stateCount, blockCount, siteSums);
      const rootScaleOffset = rootSlot * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) {
        const rootSum = siteSums[site];
        result[grid * siteCount + blockStart + site] = rootSum > 0.0 ? scales[rootScaleOffset + site] + Math.log(rootSum) : -Infinity;
      }
    }
  }
  return result;
}

/**
 * Apply one convex mixture of atomic transition operators to a pruning slot.
 * The source vector is copied once; every component then reuses the existing
 * sparse-uniformization propagator before its weighted contribution is added.
 */
function propagateOperatorBlock(
  values: Float64Array,
  slot: i32,
  blockCount: i32,
  branchLength: f64,
  operator: i32,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  operatorScales: Float64Array,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  source: Float64Array,
  component: Float64Array,
  mixed: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
): void {
  const valueOffset = slot * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    const row = state * SITE_BLOCK;
    const valueRow = valueOffset + row;
    for (let site = 0; site < blockCount; site += 1) {
      source[row + site] = values[valueRow + site];
      mixed[row + site] = 0.0;
    }
  }
  const start = <i32>operatorOffsets[operator];
  const end = <i32>operatorOffsets[operator + 1];
  const scaledLength = branchLength * operatorScales[operator];
  for (let entry = start; entry < end; entry += 1) {
    for (let state = 0; state < stateCount; state += 1) {
      const row = state * SITE_BLOCK;
      copyF64Range(component, row, source, row, blockCount);
    }
    propagateBlock(
      component, 0, blockCount, scaledLength, <i32>componentModels[entry],
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
      workA, workB, accumulator,
    );
    const weight = componentWeights[entry];
    for (let state = 0; state < stateCount; state += 1) {
      const row = state * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) mixed[row + site] += weight * component[row + site];
    }
  }
  for (let state = 0; state < stateCount; state += 1) {
    const row = state * SITE_BLOCK;
    copyF64Range(values, valueOffset + row, mixed, row, blockCount);
  }
}

/**
 * Exact f64 pruning for FAME/FLAVOR branch-wise transition mixtures.  Several
 * consecutive operators can be collapsed without materializing their much
 * larger operator-by-site matrix.  collapseMode 0 performs a weighted
 * log-sum-exp (true likelihood marginal); 1 reproduces the FAME draft's
 * weighted arithmetic mean of log likelihoods.
 */
export function evaluateBranchMixtureLikelihood(
  ops: Uint32Array,
  edgeLengths: Float64Array,
  tipStates: Uint8Array,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  operatorScales: Float64Array,
  collapseWeights: Float64Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  gridCount: i32,
  operatorsPerCategory: i32,
  collapseMode: i32,
  stateCount: i32,
  maxNeighbors: i32,
  slotCount: i32,
  rootSlot: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const result = new Float64Array(gridCount * siteCount);
  const values = new Float64Array(slotCount * stateCount * SITE_BLOCK);
  const scales = new Float64Array(slotCount * SITE_BLOCK);
  const source = new Float64Array(stateCount * SITE_BLOCK);
  const component = new Float64Array(stateCount * SITE_BLOCK);
  const mixed = new Float64Array(stateCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const collapseMaximum = new Float64Array(SITE_BLOCK);
  const collapseSum = new Float64Array(SITE_BLOCK);
  const opCount = ops.length >> 2;

  for (let grid = 0; grid < gridCount; grid += 1) {
    for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
      const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);
      for (let site = 0; site < blockCount; site += 1) {
        collapseMaximum[site] = -Infinity;
        collapseSum[site] = 0.0;
      }
      for (let member = 0; member < operatorsPerCategory; member += 1) {
        const operator = grid * operatorsPerCategory + member;
        for (let operation = 0; operation < opCount; operation += 1) {
          const operationOffset = operation << 2;
          const opcode = ops[operationOffset];
          const a = <i32>ops[operationOffset + 1];
          const b = <i32>ops[operationOffset + 2];
          const payload = <i32>ops[operationOffset + 3];
          if (opcode == LOAD_TIP) {
            const valueOffset = a * stateCount * SITE_BLOCK;
            for (let state = 0; state < stateCount; state += 1) {
              const destinationOffset = valueOffset + state * SITE_BLOCK;
              for (let site = 0; site < blockCount; site += 1) {
                const observed = tipStates[payload * siteCount + blockStart + site];
                let compatible = observed == 255 || state == observed;
                if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
                values[destinationOffset + site] = compatible ? 1.0 : 0.0;
              }
            }
            const scaleOffset = a * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
          } else if (opcode == TRANSFORM) {
            // BAME grids are single-class; b remains part of the compiled ABI
            // and is intentionally ignored here.
            propagateOperatorBlock(
              values, a, blockCount, edgeLengths[payload], operator,
              operatorOffsets, componentModels, componentWeights, operatorScales,
              stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
              neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
              source, component, mixed, workA, workB, accumulator,
            );
          } else if (opcode == MULTIPLY_NORMALIZE) {
            multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
          }
        }
        const rootOffset = rootSlot * stateCount * SITE_BLOCK;
        sumRootBlock(values, equilibrium, rootOffset, stateCount, blockCount, siteSums);
        const rootScaleOffset = rootSlot * SITE_BLOCK;
        const evidenceWeight = collapseWeights[operator];
        for (let site = 0; site < blockCount; site += 1) {
          const rootSum = siteSums[site];
          const logLikelihood = rootSum > 0.0 ? scales[rootScaleOffset + site] + Math.log(rootSum) : -Infinity;
          if (collapseMode == 1) {
            collapseSum[site] += evidenceWeight * logLikelihood;
          } else if (evidenceWeight > 0.0 && isFinite(logLikelihood)) {
            const weightedLogLikelihood = logLikelihood + Math.log(evidenceWeight);
            const previousMaximum = collapseMaximum[site];
            if (!isFinite(previousMaximum)) {
              collapseMaximum[site] = weightedLogLikelihood;
              collapseSum[site] = 1.0;
            } else if (weightedLogLikelihood > previousMaximum) {
              collapseSum[site] = collapseSum[site] * Math.exp(previousMaximum - weightedLogLikelihood) + 1.0;
              collapseMaximum[site] = weightedLogLikelihood;
            } else collapseSum[site] += Math.exp(weightedLogLikelihood - previousMaximum);
          }
        }
      }
      for (let site = 0; site < blockCount; site += 1) {
        result[grid * siteCount + blockStart + site] = collapseMode == 1
          ? collapseSum[site]
          : collapseSum[site] > 0.0 ? collapseMaximum[site] + Math.log(collapseSum[site]) : -Infinity;
      }
    }
  }
  return result;
}

/** Build the dense transition mixture for one operator on every tree edge. */
function buildDenseOperatorMatrices(
  matrices: Float64Array,
  operator: i32,
  edgeLengths: Float64Array,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  operatorScales: Float64Array,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  matrixWork: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
): void {
  matrices.fill(0.0);
  const start = <i32>operatorOffsets[operator];
  const end = <i32>operatorOffsets[operator + 1];
  const matrixSize = stateCount * stateCount;
  for (let edge = 0; edge < edgeLengths.length; edge += 1) {
    const matrixOffset = edge * matrixSize;
    const length = edgeLengths[edge] * operatorScales[operator];
    for (let entry = start; entry < end; entry += 1) {
      const weight = componentWeights[entry];
      const model = <i32>componentModels[entry];
      for (let columnStart = 0; columnStart < stateCount; columnStart += SITE_BLOCK) {
        const blockCount = min<i32>(SITE_BLOCK, stateCount - columnStart);
        for (let state = 0; state < stateCount; state += 1) {
          const row = state * SITE_BLOCK;
          for (let lane = 0; lane < blockCount; lane += 1) matrixWork[row + lane] = state == columnStart + lane ? 1.0 : 0.0;
        }
        propagateBlock(
          matrixWork, 0, blockCount, length, model,
          stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
          neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
          workA, workB, accumulator,
        );
        for (let state = 0; state < stateCount; state += 1) {
          const row = state * SITE_BLOCK;
          const destination = matrixOffset + state * stateCount + columnStart;
          for (let lane = 0; lane < blockCount; lane += 1) matrices[destination + lane] += weight * matrixWork[row + lane];
        }
      }
    }
  }
}

/** Apply one precomputed dense transition matrix to a state-by-site slot. */
function propagateDenseBlock(
  values: Float64Array,
  slot: i32,
  blockCount: i32,
  edge: i32,
  matrices: Float64Array,
  source: Float64Array,
  stateCount: i32,
): void {
  const valueOffset = slot * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    copyF64Range(source, state * SITE_BLOCK, values, valueOffset + state * SITE_BLOCK, blockCount);
  }
  const matrixOffset = edge * stateCount * stateCount;
  for (let target = 0; target < stateCount; target += 1) {
    const destination = valueOffset + target * SITE_BLOCK;
    const matrixRow = matrixOffset + target * stateCount;
    let site = 0;
    for (; site + 1 < blockCount; site += 2) {
      let total = f64x2.splat(0.0);
      for (let from = 0; from < stateCount; from += 1) {
        total = f64x2.add(total, f64x2.mul(f64x2.splat(matrices[matrixRow + from]), loadF64x2(source, from * SITE_BLOCK + site)));
      }
      storeF64x2(values, destination + site, total);
    }
    for (; site < blockCount; site += 1) {
      let total = 0.0;
      for (let from = 0; from < stateCount; from += 1) total += matrices[matrixRow + from] * source[from * SITE_BLOCK + site];
      values[destination + site] = total;
    }
  }
}

/** SIMD row-combination matrix product: destination = left * right. */
function multiplyDenseMatrices(
  matrices: Float64Array,
  leftOffset: i32,
  rightOffset: i32,
  destinationOffset: i32,
  stateCount: i32,
): void {
  for (let target = 0; target < stateCount; target += 1) {
    const leftRow = leftOffset + target * stateCount;
    const destinationRow = destinationOffset + target * stateCount;
    let source = 0;
    for (; source + 1 < stateCount; source += 2) {
      let total = f64x2.splat(0.0);
      for (let middle = 0; middle < stateCount; middle += 1) {
        total = f64x2.add(total, f64x2.mul(
          f64x2.splat(matrices[leftRow + middle]),
          loadF64x2(matrices, rightOffset + middle * stateCount + source),
        ));
      }
      storeF64x2(matrices, destinationRow + source, total);
    }
    for (; source < stateCount; source += 1) {
      let total = 0.0;
      for (let middle = 0; middle < stateCount; middle += 1) {
        total += matrices[leftRow + middle] * matrices[rightOffset + middle * stateCount + source];
      }
      matrices[destinationRow + source] = total;
    }
  }
}

/**
 * Build one FLAVOR mixed-transition lookup table with MolecularEvolution.jl's
 * exact matrix_sequence recurrence: one exp(Q * 0.001), followed by semigroup
 * matrix products on its 50-point non-uniform time grid.
 */
function buildFlavorInterpolationTable(
  matrices: Float64Array,
  times: Float64Array,
  recurrenceIndex: Uint32Array,
  componentMatrices: Float64Array,
  tableCount: i32,
  tablePoints: i32,
  baseOperator: i32,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  equilibrium: Float64Array,
  stateCount: i32,
  maxNeighbors: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  matrixWork: Float64Array,
  workA: Float64Array,
  workB: Float64Array,
  accumulator: Float64Array,
): void {
  matrices.fill(0.0);
  const matrixSize = stateCount * stateCount;
  for (let state = 0; state < stateCount; state += 1) matrices[state * stateCount + state] = 1.0;
  const start = <i32>operatorOffsets[baseOperator];
  const end = <i32>operatorOffsets[baseOperator + 1];
  // The final Julia node is explicitly replaced by equilibrium and therefore
  // does not need component exponentiation when it is part of this table.
  const computedCount = tableCount == tablePoints ? tableCount - 1 : tableCount;
  for (let entry = start; entry < end; entry += 1) {
    const weight = componentWeights[entry];
    const model = <i32>componentModels[entry];
    componentMatrices.fill(0.0);
    for (let state = 0; state < stateCount; state += 1) componentMatrices[state * stateCount + state] = 1.0;
    // Only the first small-time transition is exponentiated.
    for (let columnStart = 0; columnStart < stateCount; columnStart += SITE_BLOCK) {
      const blockCount = min<i32>(SITE_BLOCK, stateCount - columnStart);
      for (let state = 0; state < stateCount; state += 1) {
        const row = state * SITE_BLOCK;
        for (let lane = 0; lane < blockCount; lane += 1) {
          matrixWork[row + lane] = state == columnStart + lane ? 1.0 : 0.0;
        }
      }
      propagateBlock(
        matrixWork, 0, blockCount, times[1], model,
        stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
        neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
        workA, workB, accumulator,
      );
      for (let state = 0; state < stateCount; state += 1) {
        const row = state * SITE_BLOCK;
        const destination = matrixSize + state * stateCount + columnStart;
        for (let lane = 0; lane < blockCount; lane += 1) {
          componentMatrices[destination + lane] = matrixWork[row + lane];
        }
      }
    }
    for (let timeIndex = 2; timeIndex < computedCount; timeIndex += 1) {
      multiplyDenseMatrices(
        componentMatrices,
        (timeIndex - 1) * matrixSize,
        <i32>recurrenceIndex[timeIndex] * matrixSize,
        timeIndex * matrixSize,
        stateCount,
      );
    }
    const componentEntries = computedCount * matrixSize;
    let matrixEntry = matrixSize;
    const weightVector = f64x2.splat(weight);
    for (; matrixEntry + 1 < componentEntries; matrixEntry += 2) {
      storeF64x2(matrices, matrixEntry, f64x2.add(
        loadF64x2(matrices, matrixEntry),
        f64x2.mul(weightVector, loadF64x2(componentMatrices, matrixEntry)),
      ));
    }
    for (; matrixEntry < componentEntries; matrixEntry += 1) {
      matrices[matrixEntry] += weight * componentMatrices[matrixEntry];
    }
  }
  if (tableCount == tablePoints) {
    const matrixOffset = (tableCount - 1) * matrixSize;
    // Standard pruning uses P(parent, child), so every infinite-time row is
    // the child-state equilibrium distribution.
    for (let target = 0; target < stateCount; target += 1) {
      const row = matrixOffset + target * stateCount;
      for (let from = 0; from < stateCount; from += 1) matrices[row + from] = equilibrium[from];
    }
  }
}

/** Apply an element-wise interpolation of two dense transition matrices. */
function propagateInterpolatedDenseBlock(
  values: Float64Array,
  slot: i32,
  blockCount: i32,
  lower: i32,
  fraction: f64,
  matrices: Float64Array,
  source: Float64Array,
  stateCount: i32,
): void {
  const valueOffset = slot * stateCount * SITE_BLOCK;
  for (let state = 0; state < stateCount; state += 1) {
    copyF64Range(source, state * SITE_BLOCK, values, valueOffset + state * SITE_BLOCK, blockCount);
  }
  const matrixSize = stateCount * stateCount;
  const lowerOffset = lower * matrixSize;
  const upperOffset = fraction > 0.0 ? lowerOffset + matrixSize : lowerOffset;
  const inverse = 1.0 - fraction;
  for (let target = 0; target < stateCount; target += 1) {
    const destination = valueOffset + target * SITE_BLOCK;
    const lowerRow = lowerOffset + target * stateCount;
    const upperRow = upperOffset + target * stateCount;
    let site = 0;
    for (; site + 1 < blockCount; site += 2) {
      let total = f64x2.splat(0.0);
      for (let from = 0; from < stateCount; from += 1) {
        const coefficient = inverse * matrices[lowerRow + from] + fraction * matrices[upperRow + from];
        total = f64x2.add(total, f64x2.mul(f64x2.splat(coefficient), loadF64x2(source, from * SITE_BLOCK + site)));
      }
      storeF64x2(values, destination + site, total);
    }
    for (; site < blockCount; site += 1) {
      let total = 0.0;
      for (let from = 0; from < stateCount; from += 1) {
        const coefficient = inverse * matrices[lowerRow + from] + fraction * matrices[upperRow + from];
        total += coefficient * source[from * SITE_BLOCK + site];
      }
      values[destination + site] = total;
    }
  }
}

/**
 * FLAVOR-only likelihood kernel using Julia's 50-node, t=0.001, cap=35
 * element-wise transition interpolation. Categories must be contiguous alpha
 * runs for one shared Gamma distribution, exactly as createFlavorGrid emits.
 */
export function evaluateFlavorInterpolatedLikelihood(
  ops: Uint32Array,
  edgeLengths: Float64Array,
  tipStates: Uint8Array,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  operatorScales: Float64Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  categoryCount: i32,
  alphaCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  slotCount: i32,
  rootSlot: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
  timeStep: f64,
  tablePoints: i32,
  tableCap: i32,
): Float64Array {
  const result = new Float64Array(categoryCount * siteCount);
  if (categoryCount == 0 || siteCount == 0) return result;
  const groupCount = categoryCount / alphaCount;
  const values = new Float64Array(slotCount * stateCount * SITE_BLOCK);
  const scales = new Float64Array(slotCount * SITE_BLOCK);
  const source = new Float64Array(stateCount * SITE_BLOCK);
  const matrixWork = new Float64Array(stateCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const lowerByEdge = new Uint32Array(edgeLengths.length);
  const fractionByEdge = new Float64Array(edgeLengths.length);
  const times = new Float64Array(tablePoints);
  const recurrenceIndex = new Uint32Array(tablePoints);
  times[0] = 0.0;
  times[1] = timeStep;
  let cursor = 1;
  for (let index = 2; index < tablePoints; index += 1) {
    recurrenceIndex[index] = <u32>cursor;
    times[index] = times[index - 1] + times[cursor];
    const juliaIndex = index + 1;
    if (juliaIndex % 2 == 0) cursor += 1;
    else if (juliaIndex > tableCap) cursor = index;
  }
  let maximumQuery = 0.0;
  let maximumScale = 0.0;
  for (let alpha = 0; alpha < alphaCount; alpha += 1) maximumScale = Math.max(maximumScale, operatorScales[alpha]);
  for (let edge = 0; edge < edgeLengths.length; edge += 1) maximumQuery = Math.max(maximumQuery, edgeLengths[edge] * maximumScale);
  let tableCount = 1;
  while (tableCount < tablePoints && times[tableCount - 1] < maximumQuery) tableCount += 1;
  if (tableCount < 2) tableCount = 2;
  const matrices = new Float64Array(tableCount * stateCount * stateCount);
  const componentMatrices = new Float64Array(tableCount * stateCount * stateCount);
  const opCount = ops.length >> 2;

  for (let group = 0; group < groupCount; group += 1) {
    const baseOperator = group * alphaCount;
    buildFlavorInterpolationTable(
      matrices, times, recurrenceIndex, componentMatrices, tableCount, tablePoints, baseOperator,
      operatorOffsets, componentModels, componentWeights, equilibrium,
      stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
      neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
      matrixWork, workA, workB, accumulator,
    );
    for (let alpha = 0; alpha < alphaCount; alpha += 1) {
      const category = baseOperator + alpha;
      const scale = operatorScales[category];
      for (let edge = 0; edge < edgeLengths.length; edge += 1) {
        const query = edgeLengths[edge] * scale;
        let upper = 1;
        while (upper < tableCount && times[upper] < query) upper += 1;
        if (upper >= tableCount) {
          lowerByEdge[edge] = <u32>(tableCount - 1);
          fractionByEdge[edge] = 0.0;
        } else {
          const lower = upper - 1;
          lowerByEdge[edge] = <u32>lower;
          const width = times[upper] - times[lower];
          fractionByEdge[edge] = width > 0.0 ? (query - times[lower]) / width : 0.0;
        }
      }
      for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
        const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);
        for (let operation = 0; operation < opCount; operation += 1) {
          const operationOffset = operation << 2;
          const opcode = ops[operationOffset];
          const a = <i32>ops[operationOffset + 1];
          const b = <i32>ops[operationOffset + 2];
          const payload = <i32>ops[operationOffset + 3];
          if (opcode == LOAD_TIP) {
            const valueOffset = a * stateCount * SITE_BLOCK;
            for (let state = 0; state < stateCount; state += 1) {
              const destinationOffset = valueOffset + state * SITE_BLOCK;
              for (let site = 0; site < blockCount; site += 1) {
                const observed = tipStates[payload * siteCount + blockStart + site];
                let compatible = observed == 255 || state == observed;
                if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
                values[destinationOffset + site] = compatible ? 1.0 : 0.0;
              }
            }
            const scaleOffset = a * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
          } else if (opcode == TRANSFORM) {
            propagateInterpolatedDenseBlock(
              values, a, blockCount, <i32>lowerByEdge[payload], fractionByEdge[payload], matrices, source, stateCount,
            );
          } else if (opcode == MULTIPLY_NORMALIZE) {
            multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
          }
        }
        const rootOffset = rootSlot * stateCount * SITE_BLOCK;
        sumRootBlock(values, equilibrium, rootOffset, stateCount, blockCount, siteSums);
        const rootScaleOffset = rootSlot * SITE_BLOCK;
        for (let site = 0; site < blockCount; site += 1) {
          const rootSum = siteSums[site];
          result[category * siteCount + blockStart + site] = rootSum > 0.0
            ? scales[rootScaleOffset + site] + Math.log(rootSum)
            : -Infinity;
        }
      }
    }
  }
  return result;
}

/**
 * Site-rich branch-mixture evaluator. It constructs one dense mixed P matrix
 * per edge/operator, uses it for every site, then discards it. This converts
 * FLAVOR's K component propagations per branch/site into K propagations of 61
 * identity columns once plus one dense propagation per branch/site.
 */
export function evaluateBranchMixtureLikelihoodDense(
  ops: Uint32Array,
  edgeLengths: Float64Array,
  tipStates: Uint8Array,
  operatorOffsets: Uint32Array,
  componentModels: Uint32Array,
  componentWeights: Float64Array,
  operatorScales: Float64Array,
  collapseWeights: Float64Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  gridCount: i32,
  operatorsPerCategory: i32,
  collapseMode: i32,
  stateCount: i32,
  maxNeighbors: i32,
  slotCount: i32,
  rootSlot: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const result = new Float64Array(gridCount * siteCount);
  const values = new Float64Array(slotCount * stateCount * SITE_BLOCK);
  const scales = new Float64Array(slotCount * SITE_BLOCK);
  const source = new Float64Array(stateCount * SITE_BLOCK);
  const matrixWork = new Float64Array(stateCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const matrices = new Float64Array(edgeLengths.length * stateCount * stateCount);
  const collapseMaximum = new Float64Array(siteCount);
  const collapseSum = new Float64Array(siteCount);
  const opCount = ops.length >> 2;

  for (let grid = 0; grid < gridCount; grid += 1) {
    for (let site = 0; site < siteCount; site += 1) {
      collapseMaximum[site] = -Infinity;
      collapseSum[site] = 0.0;
    }
    for (let member = 0; member < operatorsPerCategory; member += 1) {
      const operator = grid * operatorsPerCategory + member;
      buildDenseOperatorMatrices(
        matrices, operator, edgeLengths,
        operatorOffsets, componentModels, componentWeights, operatorScales,
        stateCount, maxNeighbors, poissonTerms, maxLambdaPerStep,
        neighborCount, neighborIndex, rDiagonal, rOffDiagonal, mu,
        matrixWork, workA, workB, accumulator,
      );
      for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
        const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);
        for (let operation = 0; operation < opCount; operation += 1) {
          const operationOffset = operation << 2;
          const opcode = ops[operationOffset];
          const a = <i32>ops[operationOffset + 1];
          const b = <i32>ops[operationOffset + 2];
          const payload = <i32>ops[operationOffset + 3];
          if (opcode == LOAD_TIP) {
            const valueOffset = a * stateCount * SITE_BLOCK;
            for (let state = 0; state < stateCount; state += 1) {
              const destinationOffset = valueOffset + state * SITE_BLOCK;
              for (let site = 0; site < blockCount; site += 1) {
                const observed = tipStates[payload * siteCount + blockStart + site];
                let compatible = observed == 255 || state == observed;
                if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
                values[destinationOffset + site] = compatible ? 1.0 : 0.0;
              }
            }
            const scaleOffset = a * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
          } else if (opcode == TRANSFORM) {
            propagateDenseBlock(values, a, blockCount, payload, matrices, source, stateCount);
          } else if (opcode == MULTIPLY_NORMALIZE) {
            multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
          }
        }
        const rootOffset = rootSlot * stateCount * SITE_BLOCK;
        sumRootBlock(values, equilibrium, rootOffset, stateCount, blockCount, siteSums);
        const rootScaleOffset = rootSlot * SITE_BLOCK;
        const evidenceWeight = collapseWeights[operator];
        for (let site = 0; site < blockCount; site += 1) {
          const outputSite = blockStart + site;
          const rootSum = siteSums[site];
          const logLikelihood = rootSum > 0.0 ? scales[rootScaleOffset + site] + Math.log(rootSum) : -Infinity;
          if (collapseMode == 1) collapseSum[outputSite] += evidenceWeight * logLikelihood;
          else if (evidenceWeight > 0.0 && isFinite(logLikelihood)) {
            const weighted = logLikelihood + Math.log(evidenceWeight);
            const previous = collapseMaximum[outputSite];
            if (!isFinite(previous)) {
              collapseMaximum[outputSite] = weighted;
              collapseSum[outputSite] = 1.0;
            } else if (weighted > previous) {
              collapseSum[outputSite] = collapseSum[outputSite] * Math.exp(previous - weighted) + 1.0;
              collapseMaximum[outputSite] = weighted;
            } else collapseSum[outputSite] += Math.exp(weighted - previous);
          }
        }
      }
    }
    for (let site = 0; site < siteCount; site += 1) {
      result[grid * siteCount + site] = collapseMode == 1
        ? collapseSum[site]
        : collapseSum[site] > 0.0 ? collapseMaximum[site] + Math.log(collapseSum[site]) : -Infinity;
    }
  }
  return result;
}

/**
 * f64 evaluator with pure edge-subtree caching.  Cached messages are computed
 * once per unique class model and site block, then reused over the Cartesian
 * grid.  Descriptor layout is documented by buildCacheTables in wasm.ts.
 */
export function evaluateLikelihoodCached(
  mainOps: Uint32Array,
  cacheOps: Uint32Array,
  cacheDescriptors: Uint32Array,
  combinationModels: Uint32Array,
  combinationCategories: Uint32Array,
  cacheCategoryMap: Uint32Array,
  edgeLengths: Float64Array,
  tipStates: Uint8Array,
  gridModels: Uint32Array,
  neighborCount: Uint32Array,
  neighborIndex: Uint32Array,
  rDiagonal: Float64Array,
  rOffDiagonal: Float64Array,
  mu: Float64Array,
  equilibrium: Float64Array,
  siteCount: i32,
  gridCount: i32,
  classCount: i32,
  stateCount: i32,
  maxNeighbors: i32,
  slotCount: i32,
  rootSlot: i32,
  cacheCount: i32,
  cacheEntryCount: i32,
  poissonTerms: i32,
  maxLambdaPerStep: f64,
): Float64Array {
  const result = new Float64Array(gridCount * siteCount);
  const values = new Float64Array(slotCount * stateCount * SITE_BLOCK);
  const scales = new Float64Array(slotCount * SITE_BLOCK);
  const cacheValues = new Float64Array(cacheEntryCount * stateCount * SITE_BLOCK);
  const cacheScales = new Float64Array(cacheEntryCount * SITE_BLOCK);
  const workA = new Float64Array(stateCount * SITE_BLOCK);
  const workB = new Float64Array(stateCount * SITE_BLOCK);
  const accumulator = new Float64Array(stateCount * SITE_BLOCK);
  const siteSums = new Float64Array(SITE_BLOCK);
  const mainOpCount = mainOps.length >> 2;

  for (let blockStart = 0; blockStart < siteCount; blockStart += SITE_BLOCK) {
    const blockCount = min<i32>(SITE_BLOCK, siteCount - blockStart);

    // Build each independent cache for just this site block, bounding memory by
    // tree/model complexity rather than total alignment length.
    for (let cache = 0; cache < cacheCount; cache += 1) {
      const descriptor = cache << 3;
      const opWordStart = <i32>cacheDescriptors[descriptor];
      const opCount = <i32>cacheDescriptors[descriptor + 1];
      const cacheRootSlot = <i32>cacheDescriptors[descriptor + 2];
      const combinationModelOffset = <i32>cacheDescriptors[descriptor + 4];
      const localModelCount = <i32>cacheDescriptors[descriptor + 5];
      const entryOffset = <i32>cacheDescriptors[descriptor + 6];
      for (let localModel = 0; localModel < localModelCount; localModel += 1) {
        for (let operation = 0; operation < opCount; operation += 1) {
          const operationOffset = opWordStart + (operation << 2);
          const opcode = cacheOps[operationOffset];
          const a = <i32>cacheOps[operationOffset + 1];
          const b = <i32>cacheOps[operationOffset + 2];
          const payload = <i32>cacheOps[operationOffset + 3];
          if (opcode == LOAD_TIP) {
            const valueOffset = a * stateCount * SITE_BLOCK;
            for (let state = 0; state < stateCount; state += 1) {
              const destinationOffset = valueOffset + state * SITE_BLOCK;
              for (let site = 0; site < blockCount; site += 1) {
                const observed = tipStates[payload * siteCount + blockStart + site];
                let compatible = observed == 255 || state == observed;
                if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
                values[destinationOffset + site] = compatible ? 1.0 : 0.0;
              }
            }
            const scaleOffset = a * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
          } else if (opcode == TRANSFORM) {
            const model = <i32>combinationModels[combinationModelOffset + localModel * classCount + b];
            propagateBlock(
              values, a, blockCount, edgeLengths[payload], model, stateCount, maxNeighbors,
              poissonTerms, maxLambdaPerStep, neighborCount, neighborIndex,
              rDiagonal, rOffDiagonal, mu, workA, workB, accumulator,
            );
          } else if (opcode == LOAD_CACHE) {
            const childDescriptor = payload << 3;
            const representativeCategory = combinationCategories[entryOffset + localModel];
            const childLocalModel = <i32>cacheCategoryMap[cacheDescriptors[childDescriptor + 7] + representativeCategory];
            const childEntry = <i32>cacheDescriptors[childDescriptor + 6] + childLocalModel;
            const sourceValueOffset = childEntry * stateCount * SITE_BLOCK;
            const destinationValueOffset = a * stateCount * SITE_BLOCK;
            for (let state = 0; state < stateCount; state += 1) {
              const sourceRow = sourceValueOffset + state * SITE_BLOCK;
              const destinationRow = destinationValueOffset + state * SITE_BLOCK;
              copyF64Range(values, destinationRow, cacheValues, sourceRow, blockCount);
            }
            const sourceScaleOffset = childEntry * SITE_BLOCK;
            const destinationScaleOffset = a * SITE_BLOCK;
            copyF64Range(scales, destinationScaleOffset, cacheScales, sourceScaleOffset, blockCount);
          } else if (opcode == MULTIPLY_NORMALIZE) {
            multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
          }
        }
        const entry = entryOffset + localModel;
        const sourceValueOffset = cacheRootSlot * stateCount * SITE_BLOCK;
        const destinationValueOffset = entry * stateCount * SITE_BLOCK;
        for (let state = 0; state < stateCount; state += 1) {
          const sourceRow = sourceValueOffset + state * SITE_BLOCK;
          const destinationRow = destinationValueOffset + state * SITE_BLOCK;
          copyF64Range(cacheValues, destinationRow, values, sourceRow, blockCount);
        }
        const sourceScaleOffset = cacheRootSlot * SITE_BLOCK;
        const destinationScaleOffset = entry * SITE_BLOCK;
        copyF64Range(cacheScales, destinationScaleOffset, scales, sourceScaleOffset, blockCount);
      }
    }

    for (let grid = 0; grid < gridCount; grid += 1) {
      for (let operation = 0; operation < mainOpCount; operation += 1) {
        const operationOffset = operation << 2;
        const opcode = mainOps[operationOffset];
        const a = <i32>mainOps[operationOffset + 1];
        const b = <i32>mainOps[operationOffset + 2];
        const payload = <i32>mainOps[operationOffset + 3];
        if (opcode == LOAD_TIP) {
          const valueOffset = a * stateCount * SITE_BLOCK;
          for (let state = 0; state < stateCount; state += 1) {
            const destinationOffset = valueOffset + state * SITE_BLOCK;
            for (let site = 0; site < blockCount; site += 1) {
              const observed = tipStates[payload * siteCount + blockStart + site];
              let compatible = observed == 255 || state == observed;
              if (observed != 255 && (observed & 128) != 0) compatible = ((<i32>(observed & 15)) & (1 << state)) != 0;
              values[destinationOffset + site] = compatible ? 1.0 : 0.0;
            }
          }
          const scaleOffset = a * SITE_BLOCK;
          for (let site = 0; site < blockCount; site += 1) scales[scaleOffset + site] = 0.0;
        } else if (opcode == LOAD_CACHE) {
          const cacheDescriptor = payload << 3;
          const localModel = <i32>cacheCategoryMap[cacheDescriptors[cacheDescriptor + 7] + grid];
          const entry = <i32>cacheDescriptors[cacheDescriptor + 6] + localModel;
          const sourceValueOffset = entry * stateCount * SITE_BLOCK;
          const destinationValueOffset = a * stateCount * SITE_BLOCK;
          for (let state = 0; state < stateCount; state += 1) {
            const sourceRow = sourceValueOffset + state * SITE_BLOCK;
            const destinationRow = destinationValueOffset + state * SITE_BLOCK;
            copyF64Range(values, destinationRow, cacheValues, sourceRow, blockCount);
          }
          const sourceScaleOffset = entry * SITE_BLOCK;
          const destinationScaleOffset = a * SITE_BLOCK;
          copyF64Range(scales, destinationScaleOffset, cacheScales, sourceScaleOffset, blockCount);
        } else if (opcode == TRANSFORM) {
          const model = <i32>gridModels[grid * classCount + b];
          propagateBlock(
            values, a, blockCount, edgeLengths[payload], model, stateCount, maxNeighbors,
            poissonTerms, maxLambdaPerStep, neighborCount, neighborIndex,
            rDiagonal, rOffDiagonal, mu, workA, workB, accumulator,
          );
        } else if (opcode == MULTIPLY_NORMALIZE) {
          multiplyNormalizeBlock(values, scales, a, b, stateCount, blockCount, siteSums);
        }
      }
      const rootOffset = rootSlot * stateCount * SITE_BLOCK;
      sumRootBlock(values, equilibrium, rootOffset, stateCount, blockCount, siteSums);
      const rootScaleOffset = rootSlot * SITE_BLOCK;
      for (let site = 0; site < blockCount; site += 1) {
        const rootSum = siteSums[site];
        result[grid * siteCount + blockStart + site] = rootSum > 0.0 ? scales[rootScaleOffset + site] + Math.log(rootSum) : -Infinity;
      }
    }
  }
  return result;
}

let rng0: u32 = 0x243f6a88;
let rng1: u32 = 0x85a308d3;
let rng2: u32 = 0x13198a2e;
let rng3: u32 = 0x03707344;
let spareNormal = 0.0;
let hasSpareNormal = false;

@inline function rotl(value: u32, amount: i32): u32 {
  return (value << amount) | (value >> (32 - amount));
}

function splitmix(value: u32): u32 {
  let z = value + 0x9e3779b9;
  z = (z ^ (z >> 16)) * 0x85ebca6b;
  z = (z ^ (z >> 13)) * 0xc2b2ae35;
  return z ^ (z >> 16);
}

/**
 * Deterministic finite-Dirichlet mixture EM used by CodonMolecularEvolution's
 * DirichletFUBAR. Conditionals stay category-major so both matrix passes are
 * contiguous and SIMD-friendly. The result is theta followed by the number
 * of completed iterations and the final mixture log likelihood.
 */
export function runWeightEM(
  categoryMajorConditionals: Float64Array,
  initialTheta: Float64Array,
  gridCount: i32,
  siteCount: i32,
  iterations: i32,
  concentration: f64,
  tolerance: f64,
): Float64Array {
  const theta = new Float64Array(gridCount);
  const nextTheta = new Float64Array(gridCount);
  const denominators = new Float64Array(siteCount);
  let thetaTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) thetaTotal += initialTheta[category];
  if (!(thetaTotal > 0.0)) thetaTotal = 1.0;
  for (let category = 0; category < gridCount; category += 1) theta[category] = initialTheta[category] / thetaTotal;

  let completed = 0;
  let logLikelihood = -Infinity;
  const denominatorTotal = <f64>siteCount + concentration * <f64>gridCount;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let site = 0;
    const zero = f64x2.splat(0.0);
    for (; site + 1 < siteCount; site += 2) storeF64x2(denominators, site, zero);
    for (; site < siteCount; site += 1) denominators[site] = 0.0;

    for (let category = 0; category < gridCount; category += 1) {
      const categoryOffset = category * siteCount;
      const weight = f64x2.splat(theta[category]);
      site = 0;
      for (; site + 1 < siteCount; site += 2) {
        storeF64x2(
          denominators,
          site,
          f64x2.add(loadF64x2(denominators, site), f64x2.mul(weight, loadF64x2(categoryMajorConditionals, categoryOffset + site))),
        );
      }
      for (; site < siteCount; site += 1) denominators[site] += theta[category] * categoryMajorConditionals[categoryOffset + site];
    }

    logLikelihood = 0.0;
    for (site = 0; site < siteCount; site += 1) {
      const denominator = denominators[site];
      if (denominator > 0.0) logLikelihood += Math.log(denominator);
    }

    let maximumChange = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const categoryOffset = category * siteCount;
      const weight = theta[category];
      let expectedCount = concentration;
      for (site = 0; site < siteCount; site += 1) {
        const denominator = denominators[site];
        if (denominator > 0.0) expectedCount += weight * categoryMajorConditionals[categoryOffset + site] / denominator;
      }
      const updated = expectedCount / denominatorTotal;
      nextTheta[category] = updated;
      maximumChange = Math.max(maximumChange, Math.abs(updated - weight));
    }
    for (let category = 0; category < gridCount; category += 1) theta[category] = nextTheta[category];
    completed = iteration + 1;
    if (tolerance > 0.0 && maximumChange <= tolerance) break;
  }

  const result = new Float64Array(gridCount + 2);
  for (let category = 0; category < gridCount; category += 1) result[category] = theta[category];
  result[gridCount] = <f64>completed;
  result[gridCount + 1] = logLikelihood;
  return result;
}

function seedRng(seed: u32): void {
  rng0 = splitmix(seed);
  rng1 = splitmix(rng0);
  rng2 = splitmix(rng1);
  rng3 = splitmix(rng2);
  if ((rng0 | rng1 | rng2 | rng3) == 0) rng3 = 1;
  hasSpareNormal = false;
}

@inline function nextU32(): u32 {
  const result = rotl(rng1 * 5, 7) * 9;
  const t = rng1 << 9;
  rng2 ^= rng0;
  rng3 ^= rng1;
  rng1 ^= rng2;
  rng0 ^= rng3;
  rng2 ^= t;
  rng3 = rotl(rng3, 11);
  return result;
}

@inline function uniformOpen(): f64 {
  return (<f64>nextU32() + 0.5) / 4294967296.0;
}

function normalSample(): f64 {
  if (hasSpareNormal) {
    hasSpareNormal = false;
    return spareNormal;
  }
  const radius = Math.sqrt(-2.0 * Math.log(uniformOpen()));
  const angle = 6.2831853071795864769 * uniformOpen();
  spareNormal = radius * Math.sin(angle);
  hasSpareNormal = true;
  return radius * Math.cos(angle);
}

/** Ahrens-Dieter GS specialized for the overwhelmingly common Gamma(0.1, 1). */
function gammaPointOne(): f64 {
  const b = 1.0367879441171442; // 1 + 0.1 / e
  while (true) {
    const p = b * uniformOpen();
    if (p <= 1.0) {
      const p2 = p * p;
      const p4 = p2 * p2;
      const x = p4 * p4 * p2; // p^10, without a libm pow call
      const u = uniformOpen();
      if (u <= 1.0 - x || u <= Math.exp(-x)) return x;
    } else {
      const x = -Math.log((b - p) * 10.0);
      if (uniformOpen() <= Math.pow(x, -0.9)) return x;
    }
  }
}

function gammaSample(shape: f64): f64 {
  if (shape == 0.1) return gammaPointOne();
  if (shape < 1.0) return gammaSample(shape + 1.0) * Math.pow(uniformOpen(), 1.0 / shape);
  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    const x = normalSample();
    const base = 1.0 + c * x;
    if (base <= 0.0) continue;
    const v = base * base * base;
    const u = uniformOpen();
    if (u < 1.0 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

let lastAllocations = new Uint32Array(0);

@inline function cumulativeLowerBound(cumulative: Float64Array, length: i32, threshold: f64): i32 {
  let low = 0;
  let high = length - 1;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (cumulative[middle] < threshold) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Reference-semantic uncollapsed Gibbs sampler. The returned vector is
 * [mean theta (K), then seven site summaries per site].
 */
export function runGibbs(
  siteMajorConditionals: Float64Array,
  categories: Float64Array,
  gridCount: i32,
  siteCount: i32,
  parameterCount: i32,
  iterations: i32,
  burnin: i32,
  concentration: f64,
  seed: u32,
  likelihoodCutoff: f64,
  trackAllocations: bool,
): Float64Array {
  seedRng(seed);
  const retained = iterations - burnin;
  const theta = new Float64Array(gridCount);
  const thetaSum = new Float64Array(gridCount);
  const phi = new Float64Array(gridCount);
  const weights = new Float64Array(gridCount);
  const summaries = new Float64Array(siteCount * 7);
  lastAllocations = trackAllocations ? new Uint32Array(gridCount * siteCount) : new Uint32Array(0);
  const uniformTheta = 1.0 / <f64>gridCount;
  for (let category = 0; category < gridCount; category += 1) theta[category] = uniformTheta;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const concentrationVector = f64x2.splat(concentration);
    let resetCategory = 0;
    for (; resetCategory + 1 < gridCount; resetCategory += 2) {
      storeF64x2(phi, resetCategory, concentrationVector);
    }
    for (; resetCategory < gridCount; resetCategory += 1) phi[resetCategory] = concentration;
    for (let site = 0; site < siteCount; site += 1) {
      const conditionalOffset = site * gridCount;
      let total = 0.0;
      let category = 0;
      for (; category + 1 < gridCount; category += 2) {
        const products = f64x2.mul(
          loadF64x2(theta, category),
          loadF64x2(siteMajorConditionals, conditionalOffset + category),
        );
        total += f64x2.extract_lane(products, 0);
        weights[category] = total;
        total += f64x2.extract_lane(products, 1);
        weights[category + 1] = total;
      }
      for (; category < gridCount; category += 1) {
        total += theta[category] * siteMajorConditionals[conditionalOffset + category];
        weights[category] = total;
      }
      const threshold = uniformOpen() * total;
      const sampled = cumulativeLowerBound(weights, gridCount, threshold);
      phi[sampled] += 1.0;
      if (iteration > burnin) {
        const categoryOffset = sampled * parameterCount;
        const alpha = categories[categoryOffset];
        const omega1 = categories[categoryOffset + 1];
        const omega2 = categories[categoryOffset + 2];
        const summaryOffset = site * 7;
        if (omega1 > omega2) summaries[summaryOffset] += 1.0;
        if (omega2 > omega1) summaries[summaryOffset + 1] += 1.0;
        if (omega1 > 1.0) summaries[summaryOffset + 2] += 1.0;
        if (omega2 > 1.0) summaries[summaryOffset + 3] += 1.0;
        summaries[summaryOffset + 4] += alpha;
        summaries[summaryOffset + 5] += omega1;
        summaries[summaryOffset + 6] += omega2;
        if (trackAllocations) lastAllocations[sampled * siteCount + site] += 1;
      }
    }

    let thetaTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const draw = gammaSample(phi[category]);
      theta[category] = draw;
      thetaTotal += draw;
    }
    const inverseThetaTotal = 1.0 / thetaTotal;
    const inverseThetaTotalVector = f64x2.splat(inverseThetaTotal);
    let category = 0;
    for (; category + 1 < gridCount; category += 2) {
      const normalized = f64x2.mul(loadF64x2(theta, category), inverseThetaTotalVector);
      storeF64x2(theta, category, normalized);
      if (iteration > burnin) {
        storeF64x2(thetaSum, category, f64x2.add(loadF64x2(thetaSum, category), normalized));
      }
    }
    for (; category < gridCount; category += 1) {
      theta[category] *= inverseThetaTotal;
      if (iteration > burnin) thetaSum[category] += theta[category];
    }
  }

  const result = new Float64Array(gridCount + siteCount * 7);
  const inverseRetained = 1.0 / <f64>retained;
  let thetaSumTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) thetaSumTotal += thetaSum[category];
  for (let category = 0; category < gridCount; category += 1) result[category] = thetaSum[category] / thetaSumTotal;
  for (let index = 0; index < summaries.length; index += 1) result[gridCount + index] = summaries[index] * inverseRetained;
  return result;
}

/**
 * Exact uncollapsed Gibbs sampler using rejection draws for each categorical
 * allocation.  Drawing k ~ theta and accepting with L[k,s] / max_k L[k,s]
 * has exactly the target mass theta[k] * L[k,s], while avoiding a K-wide scan
 * for the overwhelmingly common case. A bounded-attempt dense fallback keeps
 * runtime predictable even for adversarial likelihood vectors.
 */
export function runGibbsRejection(
  categoryMajorConditionals: Float64Array,
  categories: Float64Array,
  gridCount: i32,
  siteCount: i32,
  parameterCount: i32,
  iterations: i32,
  burnin: i32,
  concentration: f64,
  seed: u32,
  likelihoodCutoff: f64,
  trackAllocations: bool,
): Float64Array {
  seedRng(seed);
  const retained = iterations - burnin;
  const theta = new Float64Array(gridCount);
  const thetaCumulative = new Float64Array(gridCount);
  const thetaSum = new Float64Array(gridCount);
  const phi = new Float64Array(gridCount);
  const denseCumulative = new Float64Array(gridCount);
  const siteMaximum = new Float64Array(siteCount);
  const summaries = new Float64Array(siteCount * 7);
  lastAllocations = trackAllocations ? new Uint32Array(gridCount * siteCount) : new Uint32Array(0);

  const uniformTheta = 1.0 / <f64>gridCount;
  let initialTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) {
    theta[category] = uniformTheta;
    initialTotal += uniformTheta;
    thetaCumulative[category] = initialTotal;
  }
  for (let site = 0; site < siteCount; site += 1) {
    let maximum = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const likelihood = categoryMajorConditionals[category * siteCount + site];
      if (likelihood >= likelihoodCutoff) maximum = Math.max(maximum, likelihood);
    }
    siteMaximum[site] = maximum;
  }

  let thetaCumulativeTotal = initialTotal;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const concentrationVector = f64x2.splat(concentration);
    let resetCategory = 0;
    for (; resetCategory + 1 < gridCount; resetCategory += 2) {
      storeF64x2(phi, resetCategory, concentrationVector);
    }
    for (; resetCategory < gridCount; resetCategory += 1) phi[resetCategory] = concentration;

    for (let site = 0; site < siteCount; site += 1) {
      const maximum = siteMaximum[site];
      let sampled = -1;
      for (let attempt = 0; attempt < 128; attempt += 1) {
        const proposal = cumulativeLowerBound(thetaCumulative, gridCount, uniformOpen() * thetaCumulativeTotal);
        const likelihood = categoryMajorConditionals[proposal * siteCount + site];
        if (likelihood >= likelihoodCutoff && uniformOpen() * maximum < likelihood) {
          sampled = proposal;
          break;
        }
      }
      if (sampled < 0) {
        let total = 0.0;
        for (let category = 0; category < gridCount; category += 1) {
          const likelihood = categoryMajorConditionals[category * siteCount + site];
          if (likelihood >= likelihoodCutoff) total += theta[category] * likelihood;
          denseCumulative[category] = total;
        }
        sampled = cumulativeLowerBound(denseCumulative, gridCount, uniformOpen() * total);
      }

      phi[sampled] += 1.0;
      if (iteration > burnin) {
        const categoryOffset = sampled * parameterCount;
        const alpha = categories[categoryOffset];
        const omega1 = categories[categoryOffset + 1];
        const omega2 = categories[categoryOffset + 2];
        const summaryOffset = site * 7;
        if (omega1 > omega2) summaries[summaryOffset] += 1.0;
        if (omega2 > omega1) summaries[summaryOffset + 1] += 1.0;
        if (omega1 > 1.0) summaries[summaryOffset + 2] += 1.0;
        if (omega2 > 1.0) summaries[summaryOffset + 3] += 1.0;
        summaries[summaryOffset + 4] += alpha;
        summaries[summaryOffset + 5] += omega1;
        summaries[summaryOffset + 6] += omega2;
        if (trackAllocations) lastAllocations[sampled * siteCount + site] += 1;
      }
    }

    let thetaTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const draw = gammaSample(phi[category]);
      theta[category] = draw;
      thetaTotal += draw;
    }
    const inverseThetaTotal = 1.0 / thetaTotal;
    thetaCumulativeTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      thetaCumulativeTotal += theta[category];
      thetaCumulative[category] = thetaCumulativeTotal;
      if (iteration > burnin) thetaSum[category] += theta[category] * inverseThetaTotal;
    }
  }

  const result = new Float64Array(gridCount + siteCount * 7);
  const inverseRetained = 1.0 / <f64>retained;
  let thetaSumTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) thetaSumTotal += thetaSum[category];
  for (let category = 0; category < gridCount; category += 1) result[category] = thetaSum[category] / thetaSumTotal;
  for (let index = 0; index < summaries.length; index += 1) result[gridCount + index] = summaries[index] * inverseRetained;
  return result;
}

/** Exact uncollapsed Gibbs sampler specialized for a single alpha-beta FUBAR grid. */
export function runFubarGibbsRejection(
  categoryMajorConditionals: Float64Array,
  categories: Float64Array,
  gridCount: i32,
  siteCount: i32,
  iterations: i32,
  burnin: i32,
  concentration: f64,
  seed: u32,
  trackAllocations: bool,
): Float64Array {
  seedRng(seed);
  const retained = iterations - burnin;
  const theta = new Float64Array(gridCount);
  const thetaCumulative = new Float64Array(gridCount);
  const thetaSum = new Float64Array(gridCount);
  const phi = new Float64Array(gridCount);
  const denseCumulative = new Float64Array(gridCount);
  const siteMaximum = new Float64Array(siteCount);
  const summaries = new Float64Array(siteCount * 4);
  lastAllocations = trackAllocations ? new Uint32Array(gridCount * siteCount) : new Uint32Array(0);

  const uniformTheta = 1.0 / <f64>gridCount;
  let thetaCumulativeTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) {
    theta[category] = uniformTheta;
    thetaCumulativeTotal += uniformTheta;
    thetaCumulative[category] = thetaCumulativeTotal;
  }
  for (let site = 0; site < siteCount; site += 1) {
    let maximum = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      maximum = Math.max(maximum, categoryMajorConditionals[category * siteCount + site]);
    }
    siteMaximum[site] = maximum;
  }

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (let category = 0; category < gridCount; category += 1) phi[category] = concentration;
    for (let site = 0; site < siteCount; site += 1) {
      const maximum = siteMaximum[site];
      let sampled = -1;
      for (let attempt = 0; attempt < 128; attempt += 1) {
        const proposal = cumulativeLowerBound(thetaCumulative, gridCount, uniformOpen() * thetaCumulativeTotal);
        const likelihood = categoryMajorConditionals[proposal * siteCount + site];
        if (uniformOpen() * maximum < likelihood) {
          sampled = proposal;
          break;
        }
      }
      if (sampled < 0) {
        let total = 0.0;
        for (let category = 0; category < gridCount; category += 1) {
          total += theta[category] * categoryMajorConditionals[category * siteCount + site];
          denseCumulative[category] = total;
        }
        sampled = cumulativeLowerBound(denseCumulative, gridCount, uniformOpen() * total);
      }
      phi[sampled] += 1.0;
      if (iteration > burnin) {
        const categoryOffset = sampled * 2;
        const alpha = categories[categoryOffset];
        const beta = alpha * categories[categoryOffset + 1];
        const summaryOffset = site * 4;
        if (beta > alpha) summaries[summaryOffset] += 1.0;
        else if (alpha > beta) summaries[summaryOffset + 1] += 1.0;
        summaries[summaryOffset + 2] += alpha;
        summaries[summaryOffset + 3] += beta;
        if (trackAllocations) lastAllocations[sampled * siteCount + site] += 1;
      }
    }

    let thetaTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const draw = gammaSample(phi[category]);
      theta[category] = draw;
      thetaTotal += draw;
    }
    const inverseThetaTotal = 1.0 / thetaTotal;
    thetaCumulativeTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      theta[category] *= inverseThetaTotal;
      thetaCumulativeTotal += theta[category];
      thetaCumulative[category] = thetaCumulativeTotal;
      if (iteration > burnin) thetaSum[category] += theta[category];
    }
  }

  const result = new Float64Array(gridCount + siteCount * 4);
  let thetaSumTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) thetaSumTotal += thetaSum[category];
  for (let category = 0; category < gridCount; category += 1) result[category] = thetaSum[category] / thetaSumTotal;
  const inverseRetained = 1.0 / <f64>retained;
  for (let index = 0; index < summaries.length; index += 1) result[gridCount + index] = summaries[index] * inverseRetained;
  return result;
}

/**
 * The same Gibbs transition as runGibbs, but with conditionals stored as a
 * site-major CSR table.  This is exact for the caller-provided cutoff and
 * avoids repeatedly streaming categories whose normalized likelihood is below
 * that cutoff.
 */
export function runGibbsSparse(
  conditionalValues: Float64Array,
  siteOffsets: Uint32Array,
  categoryIndices: Uint32Array,
  categories: Float64Array,
  gridCount: i32,
  siteCount: i32,
  parameterCount: i32,
  iterations: i32,
  burnin: i32,
  concentration: f64,
  seed: u32,
  trackAllocations: bool,
): Float64Array {
  seedRng(seed);
  const retained = iterations - burnin;
  const theta = new Float64Array(gridCount);
  const thetaSum = new Float64Array(gridCount);
  const phi = new Float64Array(gridCount);
  const cumulativeWeights = new Float64Array(gridCount);
  const summaries = new Float64Array(siteCount * 7);
  lastAllocations = trackAllocations ? new Uint32Array(gridCount * siteCount) : new Uint32Array(0);
  const uniformTheta = 1.0 / <f64>gridCount;
  for (let category = 0; category < gridCount; category += 1) theta[category] = uniformTheta;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (let category = 0; category < gridCount; category += 1) phi[category] = concentration;
    for (let site = 0; site < siteCount; site += 1) {
      const first = <i32>siteOffsets[site];
      const last = <i32>siteOffsets[site + 1];
      let total = 0.0;
      for (let candidate = first; candidate < last; candidate += 1) {
        total += theta[categoryIndices[candidate]] * conditionalValues[candidate];
        cumulativeWeights[candidate - first] = total;
      }
      const threshold = uniformOpen() * total;
      const localSample = cumulativeLowerBound(cumulativeWeights, last - first, threshold);
      const sampled = last > first ? <i32>categoryIndices[first + localSample] : gridCount - 1;
      phi[sampled] += 1.0;
      if (iteration > burnin) {
        const categoryOffset = sampled * parameterCount;
        const alpha = categories[categoryOffset];
        const omega1 = categories[categoryOffset + 1];
        const omega2 = categories[categoryOffset + 2];
        const summaryOffset = site * 7;
        if (omega1 > omega2) summaries[summaryOffset] += 1.0;
        if (omega2 > omega1) summaries[summaryOffset + 1] += 1.0;
        if (omega1 > 1.0) summaries[summaryOffset + 2] += 1.0;
        if (omega2 > 1.0) summaries[summaryOffset + 3] += 1.0;
        summaries[summaryOffset + 4] += alpha;
        summaries[summaryOffset + 5] += omega1;
        summaries[summaryOffset + 6] += omega2;
        if (trackAllocations) lastAllocations[sampled * siteCount + site] += 1;
      }
    }

    let thetaTotal = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      const draw = gammaSample(phi[category]);
      theta[category] = draw;
      thetaTotal += draw;
    }
    const inverseThetaTotal = 1.0 / thetaTotal;
    for (let category = 0; category < gridCount; category += 1) {
      theta[category] *= inverseThetaTotal;
      if (iteration > burnin) thetaSum[category] += theta[category];
    }
  }

  const result = new Float64Array(gridCount + siteCount * 7);
  const inverseRetained = 1.0 / <f64>retained;
  let thetaSumTotal = 0.0;
  for (let category = 0; category < gridCount; category += 1) thetaSumTotal += thetaSum[category];
  for (let category = 0; category < gridCount; category += 1) result[category] = thetaSum[category] / thetaSumTotal;
  for (let index = 0; index < summaries.length; index += 1) result[gridCount + index] = summaries[index] * inverseRetained;
  return result;
}

/**
 * Collapsed Gibbs sampler for the same finite Dirichlet mixture posterior.
 * Integrating theta out removes K Gamma draws and two K-wide theta passes per
 * iteration.  The returned theta is Rao-Blackwellized from allocation counts.
 * Input conditionals are site-major so the K-wide hot loop is contiguous.
 */
export function runCollapsedGibbs(
  siteMajorConditionals: Float64Array,
  categories: Float64Array,
  gridCount: i32,
  siteCount: i32,
  parameterCount: i32,
  iterations: i32,
  burnin: i32,
  concentration: f64,
  seed: u32,
  trackAllocations: bool,
): Float64Array {
  seedRng(seed);
  const retained = iterations - burnin;
  const counts = new Uint32Array(gridCount);
  const assignments = new Uint32Array(siteCount);
  const cumulative = new Float64Array(gridCount);
  const thetaCountSum = new Float64Array(gridCount);
  const summaries = new Float64Array(siteCount * 7);
  lastAllocations = trackAllocations ? new Uint32Array(gridCount * siteCount) : new Uint32Array(0);

  // Draw a likelihood-weighted initial allocation. The common concentration
  // factor cancels while all category counts are zero.
  for (let site = 0; site < siteCount; site += 1) {
    const conditionalOffset = site * gridCount;
    let total = 0.0;
    for (let category = 0; category < gridCount; category += 1) {
      total += siteMajorConditionals[conditionalOffset + category];
      cumulative[category] = total;
    }
    const sampled = cumulativeLowerBound(cumulative, gridCount, uniformOpen() * total);
    assignments[site] = sampled;
    counts[sampled] += 1;
  }

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (let site = 0; site < siteCount; site += 1) {
      const previous = <i32>assignments[site];
      counts[previous] -= 1;
      const conditionalOffset = site * gridCount;
      let total = 0.0;
      for (let category = 0; category < gridCount; category += 1) {
        total += (<f64>counts[category] + concentration) * siteMajorConditionals[conditionalOffset + category];
        cumulative[category] = total;
      }
      const sampled = cumulativeLowerBound(cumulative, gridCount, uniformOpen() * total);
      assignments[site] = sampled;
      counts[sampled] += 1;

      if (iteration > burnin) {
        const categoryOffset = sampled * parameterCount;
        const alpha = categories[categoryOffset];
        const omega1 = categories[categoryOffset + 1];
        const omega2 = categories[categoryOffset + 2];
        const summaryOffset = site * 7;
        if (omega1 > omega2) summaries[summaryOffset] += 1.0;
        if (omega2 > omega1) summaries[summaryOffset + 1] += 1.0;
        if (omega1 > 1.0) summaries[summaryOffset + 2] += 1.0;
        if (omega2 > 1.0) summaries[summaryOffset + 3] += 1.0;
        summaries[summaryOffset + 4] += alpha;
        summaries[summaryOffset + 5] += omega1;
        summaries[summaryOffset + 6] += omega2;
        thetaCountSum[sampled] += 1.0;
        if (trackAllocations) lastAllocations[sampled * siteCount + site] += 1;
      }
    }
  }

  const result = new Float64Array(gridCount + siteCount * 7);
  const inverseRetained = 1.0 / <f64>retained;
  const thetaDenominator = <f64>siteCount + concentration * <f64>gridCount;
  for (let category = 0; category < gridCount; category += 1) {
    result[category] = (thetaCountSum[category] * inverseRetained + concentration) / thetaDenominator;
  }
  for (let index = 0; index < summaries.length; index += 1) {
    result[gridCount + index] = summaries[index] * inverseRetained;
  }
  return result;
}

export function getLastAllocations(): Uint32Array {
  return lastAllocations;
}
