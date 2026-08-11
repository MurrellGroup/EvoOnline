import type { BameGridPreset, FameGrid, FlavorGrid } from "../types.js";
import { gammaSlices } from "../math/gamma.js";

const transform = (value: number): number => Math.max(0, 10 ** value - 0.05);
const inverseTransform = (value: number): number => Math.log10(value + 0.05);

/** Julia's `gridsetup`, including its transformed colon-range endpoint rule. */
export function transformedGrid(lower: number, upper: number, belowOne: number): Float64Array {
  if (!(lower > 0 && upper >= 1) || !Number.isInteger(belowOne) || belowOne < 1) throw new RangeError("Transformed-grid bounds are invalid.");
  const start = inverseTransform(lower);
  const stop = inverseTransform(upper);
  const step = (inverseTransform(1) - start) / belowOne;
  const values: number[] = [];
  for (let coordinate = start; coordinate <= stop + 1e-13; coordinate += step) values.push(transform(coordinate));
  return Float64Array.from(values);
}

export function createFameGrid(preset: BameGridPreset = "julia-draft"): FameGrid {
  const fast = preset === "fast";
  const alphaValues = transformedGrid(0.01, 10, fast ? 4 : 8);
  const omega1Values = transformedGrid(0.01, 1, fast ? 7 : 14);
  const omega2Values = transformedGrid(0.01, 10, fast ? 4 : 8);
  const categoryCount = alphaValues.length * omega1Values.length * omega2Values.length;
  const categories = new Float64Array(categoryCount * 3);
  const alphaIndex = new Uint16Array(categoryCount);
  const omega1Index = new Uint16Array(categoryCount);
  const omega2Index = new Uint16Array(categoryCount);
  let category = 0;
  for (let a = 0; a < alphaValues.length; a += 1) {
    for (let first = 0; first < omega1Values.length; first += 1) {
      for (let second = 0; second < omega2Values.length; second += 1) {
        const offset = category * 3;
        categories[offset] = alphaValues[a]!;
        categories[offset + 1] = omega1Values[first]!;
        categories[offset + 2] = omega2Values[second]!;
        alphaIndex[category] = a;
        omega1Index[category] = first;
        omega2Index[category] = second;
        category += 1;
      }
    }
  }
  return {
    alpha: alphaValues,
    omega: omega2Values,
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount,
    parameterCount: 3,
    hasBackground: false,
    alphaValues,
    omega1Values,
    omega2Values,
    alphaIndex,
    omega1Index,
    omega2Index,
  };
}

export function createFlavorGrid(gammaSliceCount = 20, preset: BameGridPreset = "julia-draft"): FlavorGrid {
  const fast = preset === "fast";
  const muValues = transformedGrid(0.01, 16, fast ? 4 : 8);
  const shapeValues = transformedGrid(0.05, 20, fast ? 3 : 6);
  const alphaValues = transformedGrid(0.01, 10, fast ? 4 : 8);
  const baseCount = muValues.length * shapeValues.length * alphaValues.length;
  const categoryCount = baseCount * 2;
  const categories = new Float64Array(categoryCount * 4);
  const muIndex = new Uint16Array(categoryCount);
  const shapeIndex = new Uint16Array(categoryCount);
  const alphaIndex = new Uint16Array(categoryCount);
  const capped = new Uint8Array(categoryCount);
  const positiveMask = new Uint8Array(categoryCount);
  const positiveBranchFraction = new Float32Array(categoryCount);
  let category = 0;
  for (let cap = 0; cap < 2; cap += 1) {
    for (let mu = 0; mu < muValues.length; mu += 1) {
      for (let shape = 0; shape < shapeValues.length; shape += 1) {
        const slices = gammaSlices(muValues[mu]!, shapeValues[shape]!, gammaSliceCount);
        let positive = 0;
        if (cap === 0) for (const omega of slices) if (omega > 1) positive += 1;
        for (let alpha = 0; alpha < alphaValues.length; alpha += 1) {
          const offset = category * 4;
          categories[offset] = alphaValues[alpha]!;
          categories[offset + 1] = muValues[mu]!;
          categories[offset + 2] = shapeValues[shape]!;
          categories[offset + 3] = cap;
          muIndex[category] = mu;
          shapeIndex[category] = shape;
          alphaIndex[category] = alpha;
          capped[category] = cap;
          positiveMask[category] = positive > 0 ? 1 : 0;
          positiveBranchFraction[category] = positive / gammaSliceCount;
          category += 1;
        }
      }
    }
  }
  return {
    alpha: alphaValues,
    omega: muValues,
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount,
    parameterCount: 4,
    hasBackground: false,
    muValues,
    shapeValues,
    alphaValues,
    muIndex,
    shapeIndex,
    alphaIndex,
    capped,
    positiveMask,
    positiveBranchFraction,
  };
}
