import type { DifFUBARGrid } from "@phylo-workbench/model-diffubar";
import type { FubarGrid } from "@phylo-workbench/model-fubar";
import type { CladeShiftIntensityPreset } from "../types.js";

const MAX_SHIFTED_LOG_OMEGA = Math.log(50);

/**
 * RELAX-style selection-intensity transform.  K<1 contracts log(omega)
 * toward neutrality; K>1 expands it away from neutrality.  Expansion is
 * saturated at omega=50 to avoid spending nearly all runtime resolving a
 * biologically unidentifiable positive tail. Already-more-extreme baseline
 * categories are left unchanged rather than moved in the wrong direction.
 */
export function selectionIntensityOmega(omega: number, intensity: number): number {
  if (!(omega > 0) || !Number.isFinite(omega)) throw new RangeError("Omega must be finite and positive.");
  if (!(intensity > 0) || !Number.isFinite(intensity)) throw new RangeError("Selection intensity K must be finite and positive.");
  if (omega === 1 || intensity === 1) return omega;
  const signed = Math.log(omega);
  const magnitude = Math.abs(signed);
  const shiftedMagnitude = intensity < 1
    ? intensity * magnitude
    : magnitude >= MAX_SHIFTED_LOG_OMEGA ? magnitude : Math.min(MAX_SHIFTED_LOG_OMEGA, intensity * magnitude);
  return Math.exp(Math.sign(signed) * shiftedMagnitude);
}

export function intensityValues(preset: CladeShiftIntensityPreset): Float64Array {
  return preset === "thorough"
    ? Float64Array.of(0.25, 0.5, 0.75, 4 / 3, 2, 4)
    : Float64Array.of(0.4, 0.7, 1 / 0.7, 2.5);
}

export interface CladeShiftModelGrid {
  readonly grid: DifFUBARGrid;
  /** [baseline category, state], where state 0 is null and 1..K are shifts. */
  readonly categoryIndex: Uint32Array;
}

export function createCladeShiftModelGrid(base: FubarGrid, intensities: Float64Array): CladeShiftModelGrid {
  const states = intensities.length + 1;
  const categoryCount = base.categoryCount * states;
  const categories = new Float64Array(categoryCount * 2);
  const categoryIndex = new Uint32Array(categoryCount);
  let output = 0;
  for (let category = 0; category < base.categoryCount; category += 1) {
    const alpha = base.categories[category * base.parameterCount]!;
    const omega = base.categories[category * base.parameterCount + 1]!;
    categories[output * 2] = alpha;
    categories[output * 2 + 1] = omega;
    categoryIndex[category * states] = output++;
    for (let intensity = 0; intensity < intensities.length; intensity += 1) {
      categories[output * 2] = alpha;
      categories[output * 2 + 1] = selectionIntensityOmega(omega, intensities[intensity]!);
      categoryIndex[category * states + intensity + 1] = output++;
    }
  }
  return {
    categoryIndex,
    grid: {
      alpha: base.alpha,
      omega: base.omega,
      backgroundOmega: new Float64Array(0),
      categories,
      categoryCount,
      parameterCount: 2,
      hasBackground: false,
    },
  };
}
