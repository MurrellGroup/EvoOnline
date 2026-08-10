import type { FubarGrid } from "../types.js";

const GRID_DIVISOR = 6.578947368421053;
const GRID_SHIFT = 1.502;
const GRID_OFFSET = 0.0423174293933042;

/** Exact default transform and alpha-major/beta-minor ordering from FUBAR_grid. */
export function createFubarGrid(gridPoints = 20): FubarGrid {
  if (!Number.isInteger(gridPoints) || gridPoints < 2 || gridPoints > 64) {
    throw new RangeError("FUBAR grid points must be an integer between 2 and 64.");
  }
  const values = new Float64Array(gridPoints);
  for (let index = 0; index < gridPoints; index += 1) {
    values[index] = 10 ** ((index + 1) / GRID_DIVISOR - GRID_SHIFT) - GRID_OFFSET;
  }
  const categoryCount = gridPoints * gridPoints;
  const categories = new Float64Array(categoryCount * 2);
  const alphaIndex = new Uint16Array(categoryCount);
  const betaIndex = new Uint16Array(categoryCount);
  let category = 0;
  for (let alpha = 0; alpha < gridPoints; alpha += 1) {
    for (let beta = 0; beta < gridPoints; beta += 1) {
      const alphaValue = values[alpha]!;
      const betaValue = values[beta]!;
      categories[category * 2] = alphaValue;
      // The shared MG94 engine parameterizes nonsynonymous rate as alpha*omega.
      categories[category * 2 + 1] = betaValue / alphaValue;
      alphaIndex[category] = alpha;
      betaIndex[category] = beta;
      category += 1;
    }
  }
  return {
    values,
    beta: values.slice(),
    alphaIndex,
    betaIndex,
    alpha: values.slice(),
    omega: values.slice(),
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount,
    parameterCount: 2,
    hasBackground: false,
  };
}
