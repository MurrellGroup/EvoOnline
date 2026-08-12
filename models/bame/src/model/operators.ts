import {
  buildModelBank,
  type BranchMixtureOperators,
  type DifFUBARGrid,
  type GeneticCodeInput,
  type ParsedTree,
} from "@phylo-workbench/model-diffubar";
import { gammaSlices } from "../math/gamma.js";
import type {
  BuiltBranchMixtureGrid,
  FameGrid,
  FameWeightIntegration,
  FlavorGrid,
} from "../types.js";

interface QuadratureRule {
  readonly nodes: Float64Array;
  readonly weights: Float64Array;
}

/** Stable Gauss-Legendre nodes and normalized weights on [0,1]. */
export function gaussLegendreUnit(points: number): QuadratureRule {
  if (!Number.isInteger(points) || points < 2 || points > 32) throw new RangeError("Quadrature points must be an integer from 2 to 32.");
  const nodes = new Float64Array(points);
  const weights = new Float64Array(points);
  const half = Math.ceil(points / 2);
  for (let index = 0; index < half; index += 1) {
    let root = Math.cos(Math.PI * (index + 0.75) / (points + 0.5));
    let derivative = 0;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      let previous = 1;
      let current = root;
      for (let degree = 2; degree <= points; degree += 1) {
        const next = ((2 * degree - 1) * root * current - (degree - 1) * previous) / degree;
        previous = current;
        current = next;
      }
      derivative = points * (root * current - previous) / (root * root - 1);
      const update = current / derivative;
      root -= update;
      if (Math.abs(update) < 2e-15) break;
    }
    const weight = 1 / ((1 - root * root) * derivative * derivative);
    const left = index;
    const right = points - 1 - index;
    nodes[left] = (1 - root) / 2;
    nodes[right] = (1 + root) / 2;
    weights[left] = weight;
    weights[right] = weight;
  }
  let total = 0;
  for (const weight of weights) total += weight;
  for (let index = 0; index < points; index += 1) weights[index] = weights[index]! / total;
  return { nodes, weights };
}

function draftRule(points: number): QuadratureRule {
  if (!Number.isInteger(points) || points < 2 || points > 64) throw new RangeError("Draft weight points must be an integer from 2 to 64.");
  const nodes = new Float64Array(points);
  const weights = new Float64Array(points);
  for (let index = 0; index < points; index += 1) {
    nodes[index] = index / (points - 1);
    weights[index] = 1 / points;
  }
  return { nodes, weights };
}

class AtomicOmegaCatalog {
  readonly values: number[] = [];
  private readonly ids = new Map<string, number>();

  add(omega: number): number {
    const key = omega.toPrecision(17);
    const present = this.ids.get(key);
    if (present !== undefined) return present;
    const id = this.values.length;
    this.ids.set(key, id);
    this.values.push(omega);
    return id;
  }
}

function buildAtomicModels(
  catalog: AtomicOmegaCatalog,
  tree: ParsedTree,
  gtrRates: ArrayLike<number>,
  f3x4: ArrayLike<number>,
  geneticCode: GeneticCodeInput,
) {
  const categories = new Float64Array(catalog.values.length * 2);
  for (let index = 0; index < catalog.values.length; index += 1) {
    categories[index * 2] = 1;
    categories[index * 2 + 1] = catalog.values[index]!;
  }
  const atomicGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1),
    omega: Float64Array.from(catalog.values),
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount: catalog.values.length,
    parameterCount: 2,
    hasBackground: false,
  };
  return buildModelBank(atomicGrid, tree, gtrRates, f3x4, geneticCode);
}

function mapAtomicIds(ids: readonly number[], modelMap: Uint32Array): Uint32Array {
  return Uint32Array.from(ids, (id) => modelMap[id]!);
}

export function buildFameBranchMixtures(
  grid: FameGrid,
  tree: ParsedTree,
  gtrRates: ArrayLike<number>,
  f3x4: ArrayLike<number>,
  integration: FameWeightIntegration,
  points: number,
  geneticCode: GeneticCodeInput = 1,
): BuiltBranchMixtureGrid<FameGrid> {
  const rule = integration === "julia-draft-log-average" ? draftRule(points) : gaussLegendreUnit(points);
  const operatorCount = grid.categoryCount * points;
  const offsets = new Uint32Array(operatorCount + 1);
  const componentIds: number[] = [];
  const componentWeights: number[] = [];
  const operatorScales = new Float64Array(operatorCount);
  const collapseWeights = new Float64Array(operatorCount);
  const catalog = new AtomicOmegaCatalog();
  let operator = 0;
  for (let category = 0; category < grid.categoryCount; category += 1) {
    const base = category * 3;
    const alpha = grid.categories[base]!;
    const omega1 = grid.categories[base + 1]!;
    const omega2 = grid.categories[base + 2]!;
    const firstId = catalog.add(omega1);
    const secondId = catalog.add(omega2);
    for (let member = 0; member < points; member += 1) {
      offsets[operator] = componentIds.length;
      const firstWeight = rule.nodes[member]!;
      const secondWeight = 1 - firstWeight;
      if (firstId === secondId) {
        componentIds.push(firstId);
        componentWeights.push(1);
      } else {
        if (firstWeight > 0) {
          componentIds.push(firstId);
          componentWeights.push(firstWeight);
        }
        if (secondWeight > 0) {
          componentIds.push(secondId);
          componentWeights.push(secondWeight);
        }
      }
      operatorScales[operator] = alpha;
      collapseWeights[operator] = rule.weights[member]!;
      operator += 1;
    }
  }
  offsets[operatorCount] = componentIds.length;
  const models = buildAtomicModels(catalog, tree, gtrRates, f3x4, geneticCode);
  const operators: BranchMixtureOperators = {
    operatorCount,
    operatorOffsets: offsets,
    componentModels: mapAtomicIds(componentIds, models.gridModels),
    componentWeights: Float64Array.from(componentWeights),
    operatorScales,
    operatorsPerCategory: points,
    collapseWeights,
    collapseMode: integration === "julia-draft-log-average" ? "mean-log-likelihood" : "log-mean-likelihood",
  };
  return { grid, models, operators };
}

export function buildFlavorBranchMixtures(
  grid: FlavorGrid,
  tree: ParsedTree,
  gtrRates: ArrayLike<number>,
  f3x4: ArrayLike<number>,
  sliceCount: number,
  geneticCode: GeneticCodeInput = 1,
): BuiltBranchMixtureGrid<FlavorGrid> {
  const operatorCount = grid.categoryCount;
  const offsets = new Uint32Array(operatorCount + 1);
  const componentIds: number[] = [];
  const componentWeights: number[] = [];
  const operatorScales = new Float64Array(operatorCount);
  const collapseWeights = new Float64Array(operatorCount);
  collapseWeights.fill(1);
  const catalog = new AtomicOmegaCatalog();
  const distributionCache = new Map<string, readonly [number, number][]>();
  for (let category = 0; category < grid.categoryCount; category += 1) {
    offsets[category] = componentIds.length;
    const muIndex = grid.muIndex[category]!;
    const shapeIndex = grid.shapeIndex[category]!;
    const cap = grid.capped[category]!;
    const cacheKey = `${cap}|${muIndex}|${shapeIndex}`;
    let components = distributionCache.get(cacheKey);
    if (components === undefined) {
      const slices = gammaSlices(grid.muValues[muIndex]!, grid.shapeValues[shapeIndex]!, sliceCount);
      const combined = new Map<number, number>();
      for (const raw of slices) {
        const omega = cap === 1 ? Math.min(1, raw) : raw;
        const id = catalog.add(omega);
        combined.set(id, (combined.get(id) ?? 0) + 1 / sliceCount);
      }
      components = [...combined.entries()];
      distributionCache.set(cacheKey, components);
    }
    for (const [id, weight] of components) {
      componentIds.push(id);
      componentWeights.push(weight);
    }
    operatorScales[category] = grid.categories[category * 4]!;
  }
  offsets[operatorCount] = componentIds.length;
  const models = buildAtomicModels(catalog, tree, gtrRates, f3x4, geneticCode);
  const operators: BranchMixtureOperators = {
    operatorCount,
    operatorOffsets: offsets,
    componentModels: mapAtomicIds(componentIds, models.gridModels),
    componentWeights: Float64Array.from(componentWeights),
    operatorScales,
    operatorsPerCategory: 1,
    collapseWeights,
    collapseMode: "log-mean-likelihood",
  };
  return { grid, models, operators };
}
