import { FixedGtrModel } from "./model.js";
import { compressPatterns, type PatternTable } from "./patterns.js";
import { branchLength, type CompiledLinkedTree } from "./tree.js";

export interface NucleotideAlignment {
  readonly taxa: number;
  readonly sites: number;
  /** Site-major IUPAC bit masks in A,C,G,T order; zero is treated as missing. */
  readonly masks: Uint8Array;
}

export interface RateMixture {
  readonly rates: Float64Array;
  readonly weights: Float64Array;
}

export interface LinkedLikelihoodEvaluation {
  readonly logLikelihood: number;
  /** Derivative of log likelihood with respect to each atomic length. */
  readonly gradient: Float64Array;
  readonly treeLogLikelihoods: Float64Array;
}

/**
 * Model-agnostic contract consumed by the shared branch optimizer. A future
 * codon engine can provide this interface while reusing the same linked-tree
 * parameterization, optimizer, and genomic HMM machinery.
 */
export interface DifferentiableLinkedLikelihood {
  readonly atomicEdgeCount: number;
  evaluate(lengths: Float64Array, assignment: Int32Array, needGradient?: boolean): LinkedLikelihoodEvaluation;
}

interface PreparedTransitions {
  readonly matrices: Float64Array;
  readonly derivatives: Float64Array;
}

interface PatternEvaluation {
  readonly total: number;
  readonly gradient: Float64Array;
  readonly patternLogLikelihoods: Float64Array;
}

function logSumExp(values: Float64Array): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) maximum = Math.max(maximum, value);
  if (!Number.isFinite(maximum)) return maximum;
  let total = 0;
  for (const value of values) total += Math.exp(value - maximum);
  return maximum + Math.log(total);
}

function matvec(matrix: Float64Array, matrixOffset: number, vector: Float64Array, vectorOffset: number, output: Float64Array, outputOffset: number): void {
  for (let row = 0; row < 4; row += 1) {
    let total = 0;
    for (let column = 0; column < 4; column += 1) total += matrix[matrixOffset + row * 4 + column]! * vector[vectorOffset + column]!;
    output[outputOffset + row] = total;
  }
}

function prepareTransitions(tree: CompiledLinkedTree, model: FixedGtrModel, mixture: RateMixture, lengths: Float64Array): PreparedTransitions {
  const nodes = tree.childA.length;
  const matrices = new Float64Array(mixture.rates.length * nodes * 16);
  const derivatives = new Float64Array(matrices.length);
  for (let category = 0; category < mixture.rates.length; category += 1) {
    for (let node = 0; node < nodes; node += 1) {
      if (node === tree.root) continue;
      const transition = model.transition(branchLength(tree, node, lengths), mixture.rates[category]!);
      const offset = (category * nodes + node) * 16;
      matrices.set(transition.matrix, offset);
      derivatives.set(transition.derivative, offset);
    }
  }
  return { matrices, derivatives };
}

function evaluatePatterns(
  tree: CompiledLinkedTree,
  patterns: PatternTable,
  model: FixedGtrModel,
  mixture: RateMixture,
  lengths: Float64Array,
  needGradient: boolean,
): PatternEvaluation {
  const nodes = tree.childA.length;
  const categories = mixture.rates.length;
  const atomicCount = lengths.length;
  const transitions = prepareTransitions(tree, model, mixture, lengths);
  const inside = new Float64Array(nodes * 4);
  const projected = new Float64Array(nodes * 4);
  const outside = new Float64Array(nodes * 4);
  const logScale = new Float64Array(nodes);
  const categoryLogs = new Float64Array(categories);
  const categoryGradient = new Float64Array(categories * atomicCount);
  const leftMessage = new Float64Array(4);
  const derivativeProjection = new Float64Array(4);
  const patternLogs = new Float64Array(patterns.count);
  const gradient = new Float64Array(atomicCount);
  let totalLogLikelihood = 0;

  for (let pattern = 0; pattern < patterns.count; pattern += 1) {
    categoryGradient.fill(0);
    for (let category = 0; category < categories; category += 1) {
      inside.fill(0);
      projected.fill(0);
      logScale.fill(0);
      for (const node of tree.postorder) {
        const vectorOffset = node * 4;
        const taxon = tree.leaf[node]!;
        if (taxon >= 0) {
          const mask = patterns.masks[pattern * patterns.taxa + taxon]! || 15;
          for (let state = 0; state < 4; state += 1) inside[vectorOffset + state] = (mask & (1 << state)) !== 0 ? 1 : 0;
        } else {
          const left = tree.childA[node]!;
          const right = tree.childB[node]!;
          const leftOffset = left * 4;
          const rightOffset = right * 4;
          let scale = 0;
          for (let state = 0; state < 4; state += 1) {
            const value = projected[leftOffset + state]! * projected[rightOffset + state]!;
            inside[vectorOffset + state] = value;
            scale += value;
          }
          if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`Likelihood underflow/invalidity in tree '${tree.id}'.`);
          for (let state = 0; state < 4; state += 1) inside[vectorOffset + state] = inside[vectorOffset + state]! / scale;
          logScale[node] = logScale[left]! + logScale[right]! + Math.log(scale);
        }
        if (node !== tree.root) {
          const matrixOffset = (category * nodes + node) * 16;
          matvec(transitions.matrices, matrixOffset, inside, vectorOffset, projected, vectorOffset);
        }
      }
      const rootOffset = tree.root * 4;
      let rootLikelihood = 0;
      for (let state = 0; state < 4; state += 1) rootLikelihood += model.frequencies[state]! * inside[rootOffset + state]!;
      if (!(rootLikelihood > 0)) throw new RangeError(`Tree '${tree.id}' assigns zero probability to an observed pattern.`);
      categoryLogs[category] = Math.log(mixture.weights[category]!) + Math.log(rootLikelihood) + logScale[tree.root]!;

      if (needGradient) {
        outside.fill(0);
        for (let state = 0; state < 4; state += 1) outside[rootOffset + state] = model.frequencies[state]!;
        for (const parent of tree.preorder) {
          const left = tree.childA[parent]!;
          if (left < 0) continue;
          const right = tree.childB[parent]!;
          for (const [child, sibling] of [[left, right], [right, left]] as const) {
            const childOffset = child * 4;
            const siblingOffset = sibling * 4;
            const parentOffset = parent * 4;
            const matrixOffset = (category * nodes + child) * 16;
            let denominator = 0;
            let numerator = 0;
            leftMessage.fill(0);
            derivativeProjection.fill(0);
            matvec(transitions.derivatives, matrixOffset, inside, childOffset, derivativeProjection, 0);
            for (let state = 0; state < 4; state += 1) {
              const value = outside[parentOffset + state]! * projected[siblingOffset + state]!;
              leftMessage[state] = value;
              denominator += value * projected[childOffset + state]!;
              numerator += value * derivativeProjection[state]!;
            }
            if (denominator > 0) {
              const ratio = numerator / denominator;
              for (const atomic of tree.atomicEdgesByNode[child]!) categoryGradient[category * atomicCount + atomic] = categoryGradient[category * atomicCount + atomic]! + ratio;
            }
            let outsideScale = 0;
            for (let childState = 0; childState < 4; childState += 1) {
              let value = 0;
              for (let parentState = 0; parentState < 4; parentState += 1) value += leftMessage[parentState]! * transitions.matrices[matrixOffset + parentState * 4 + childState]!;
              outside[childOffset + childState] = value;
              outsideScale += value;
            }
            if (outsideScale > 0) for (let state = 0; state < 4; state += 1) outside[childOffset + state] = outside[childOffset + state]! / outsideScale;
          }
        }
      }
    }
    const mixtureLog = logSumExp(categoryLogs);
    patternLogs[pattern] = mixtureLog;
    const weight = patterns.weights[pattern]!;
    totalLogLikelihood += weight * mixtureLog;
    if (needGradient) {
      for (let category = 0; category < categories; category += 1) {
        const responsibility = Math.exp(categoryLogs[category]! - mixtureLog) * weight;
        for (let atomic = 0; atomic < atomicCount; atomic += 1) gradient[atomic] = gradient[atomic]! + responsibility * categoryGradient[category * atomicCount + atomic]!;
      }
    }
  }
  return { total: totalLogLikelihood, gradient, patternLogLikelihoods: patternLogs };
}

export class LinkedTreeLikelihood {
  readonly alignment: NucleotideAlignment;
  readonly trees: readonly CompiledLinkedTree[];
  readonly model: FixedGtrModel;
  readonly mixture: RateMixture;
  readonly atomicEdgeCount: number;
  private readonly globalPatterns: PatternTable;
  private readonly assignmentPatterns = new WeakMap<Int32Array, readonly (PatternTable | undefined)[]>();

  constructor(alignment: NucleotideAlignment, trees: readonly CompiledLinkedTree[], model: FixedGtrModel, mixture: RateMixture) {
    if (trees.length < 1 || alignment.masks.length !== alignment.taxa * alignment.sites) throw new RangeError("Linked likelihood requires at least one tree and a rectangular alignment.");
    if (mixture.rates.length < 1 || mixture.rates.length !== mixture.weights.length) throw new RangeError("Rate mixture arrays have inconsistent lengths.");
    let weightTotal = 0;
    for (let index = 0; index < mixture.rates.length; index += 1) {
      if (!(mixture.rates[index]! >= 0) || !(mixture.weights[index]! > 0)) throw new RangeError("Rate categories must be nonnegative with positive weights.");
      weightTotal += mixture.weights[index]!;
    }
    const normalizedMixture = { rates: mixture.rates.slice(), weights: Float64Array.from(mixture.weights, (weight) => weight / weightTotal) };
    let atomicEdgeCount = 0;
    for (const tree of trees) {
      if (tree.taxonCount !== alignment.taxa) throw new RangeError(`Tree '${tree.id}' and alignment taxon counts differ.`);
      atomicEdgeCount = Math.max(atomicEdgeCount, tree.atomicEdgeCount);
    }
    this.alignment = alignment;
    this.trees = trees;
    this.model = model;
    this.mixture = normalizedMixture;
    this.atomicEdgeCount = atomicEdgeCount;
    this.globalPatterns = compressPatterns(alignment.masks, alignment.taxa);
  }

  /** `assignment` is treated as immutable and its compressed patterns are cached by identity. */
  evaluate(lengths: Float64Array, assignment: Int32Array, needGradient = true): LinkedLikelihoodEvaluation {
    if (lengths.length !== this.atomicEdgeCount || lengths.some((value) => !(value > 0) || !Number.isFinite(value))) throw new RangeError("Every atomic branch length must be finite and positive.");
    if (assignment.length !== this.alignment.sites) throw new RangeError("Tree assignment length differs from the alignment.");
    let tables = this.assignmentPatterns.get(assignment);
    if (tables === undefined) {
      const siteGroups: number[][] = Array.from({ length: this.trees.length }, () => []);
      for (let site = 0; site < assignment.length; site += 1) {
        const tree = assignment[site]!;
        if (tree < 0 || tree >= this.trees.length) throw new RangeError(`Site ${site + 1} uses an unknown linked tree.`);
        siteGroups[tree]!.push(site);
      }
      tables = siteGroups.map((sites) => sites.length === 0 ? undefined : compressPatterns(this.alignment.masks, this.alignment.taxa, sites));
      this.assignmentPatterns.set(assignment, tables);
    }
    const gradient = new Float64Array(lengths.length);
    const treeLogLikelihoods = new Float64Array(this.trees.length);
    let total = 0;
    for (let treeIndex = 0; treeIndex < this.trees.length; treeIndex += 1) {
      const patterns = tables[treeIndex];
      if (patterns === undefined) continue;
      const evaluated = evaluatePatterns(this.trees[treeIndex]!, patterns, this.model, this.mixture, lengths, needGradient);
      treeLogLikelihoods[treeIndex] = evaluated.total;
      total += evaluated.total;
      if (needGradient) for (let atomic = 0; atomic < gradient.length; atomic += 1) gradient[atomic] = gradient[atomic]! + evaluated.gradient[atomic]!;
    }
    return { logLikelihood: total, gradient, treeLogLikelihoods };
  }

  /** Site-major matrix: output[site * treeCount + tree]. */
  siteLogLikelihoods(lengths: Float64Array): Float64Array {
    if (lengths.length !== this.atomicEdgeCount) throw new RangeError("Atomic branch-length count differs from the linked structure.");
    const result = new Float64Array(this.alignment.sites * this.trees.length);
    for (let treeIndex = 0; treeIndex < this.trees.length; treeIndex += 1) {
      const evaluated = evaluatePatterns(this.trees[treeIndex]!, this.globalPatterns, this.model, this.mixture, lengths, false);
      for (let site = 0; site < this.alignment.sites; site += 1) result[site * this.trees.length + treeIndex] = evaluated.patternLogLikelihoods[this.globalPatterns.sitePattern[site]!]!;
    }
    return result;
  }
}
