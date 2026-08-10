import { DifFUBARError, type DifFUBARGrid } from "../types.js";

function transformedGrid(lower: number, upper: number, belowOne: number): Float64Array {
  if (!(lower > 0 && upper > 1 && belowOne > 0 && Number.isInteger(belowOne))) {
    throw new DifFUBARError("INVALID_GRID", "Grid bounds and density are invalid.");
  }
  const transform = (x: number): number => 10 ** x - 0.05;
  const inverse = (x: number): number => Math.log10(x + 0.05);
  const start = inverse(lower);
  const end = inverse(upper);
  const step = (inverse(1) - start) / belowOne;
  const count = Math.floor((end - start) / step + 1e-12) + 1;
  const values = new Float64Array(count);
  for (let i = 0; i < count; i += 1) values[i] = transform(start + step * i);
  return values;
}

/** Reproduces CodonMolecularEvolution.gridprep's transformed fixed grid and ordering. */
export function createDifFUBARGrid(
  hasBackground: boolean,
  foregroundGrid = 6,
  backgroundGrid = 4,
): DifFUBARGrid {
  const alpha = transformedGrid(0.01, 13, foregroundGrid);
  const omega = transformedGrid(0.01, 13, foregroundGrid);
  const backgroundOmega = transformedGrid(0.05, 6, backgroundGrid);
  const parameterCount = hasBackground ? 4 : 3;
  const categoryCount = alpha.length * omega.length * omega.length * (hasBackground ? backgroundOmega.length : 1);
  const categories = new Float64Array(categoryCount * parameterCount);
  let category = 0;
  for (const alphaValue of alpha) {
    for (const omega1 of omega) {
      for (const omega2 of omega) {
        if (hasBackground) {
          for (const omegaBackground of backgroundOmega) {
            const offset = category * parameterCount;
            categories[offset] = alphaValue;
            categories[offset + 1] = omega1;
            categories[offset + 2] = omega2;
            categories[offset + 3] = omegaBackground;
            category += 1;
          }
        } else {
          const offset = category * parameterCount;
          categories[offset] = alphaValue;
          categories[offset + 1] = omega1;
          categories[offset + 2] = omega2;
          category += 1;
        }
      }
    }
  }
  return { alpha, omega, backgroundOmega, categories, categoryCount, parameterCount, hasBackground };
}
