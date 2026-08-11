export const ALT_PARAMETERS_PER_BRANCH = 6;
export const NULL_PARAMETERS_PER_BRANCH = 5;

export interface DecodedBranchModel {
  readonly omegaMinus: number;
  readonly omegaNeutral: number;
  readonly omegaPositive: number;
  readonly weightMinus: number;
  readonly weightNeutral: number;
  readonly weightPositive: number;
  readonly length: number;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function logit(probability: number): number {
  const p = Math.max(1e-12, Math.min(1 - 1e-12, probability));
  return Math.log(p / (1 - p));
}

function weights(logitMinus: number, logitNeutral: number): readonly [number, number, number] {
  const maximum = Math.max(logitMinus, logitNeutral, 0);
  const minus = Math.exp(logitMinus - maximum);
  const neutral = Math.exp(logitNeutral - maximum);
  const positive = Math.exp(-maximum);
  const total = minus + neutral + positive;
  return [minus / total, neutral / total, positive / total];
}

function commonDecode(
  minusRaw: number,
  neutralRaw: number,
  weightMinusRaw: number,
  weightNeutralRaw: number,
  lengthRaw: number,
  baseLength: number,
): Omit<DecodedBranchModel, "omegaPositive"> {
  const omegaNeutral = 1e-5 + (1 - 2e-5) * sigmoid(neutralRaw);
  const omegaMinus = Math.max(1e-8, omegaNeutral * sigmoid(minusRaw));
  const [weightMinus, weightNeutral, weightPositive] = weights(weightMinusRaw, weightNeutralRaw);
  const safeLengthRaw = Math.max(-5, Math.min(5, lengthRaw));
  return {
    omegaMinus,
    omegaNeutral,
    weightMinus,
    weightNeutral,
    weightPositive,
    length: Math.max(1e-8, baseLength * Math.exp(safeLengthRaw)),
  };
}

export function decodeAlternativeBranch(
  raw: ArrayLike<number>,
  offset: number,
  baseLength: number,
  maximumOmega: number,
): DecodedBranchModel {
  const common = commonDecode(raw[offset]!, raw[offset + 1]!, raw[offset + 3]!, raw[offset + 4]!, raw[offset + 5]!, baseLength);
  return {
    ...common,
    omegaPositive: 1 + (maximumOmega - 1) * sigmoid(raw[offset + 2]!),
  };
}

export function decodeNullBranch(
  raw: ArrayLike<number>,
  offset: number,
  baseLength: number,
): DecodedBranchModel {
  return {
    ...commonDecode(raw[offset]!, raw[offset + 1]!, raw[offset + 2]!, raw[offset + 3]!, raw[offset + 4]!, baseLength),
    omegaPositive: 1,
  };
}

export function initialAlternativeRaw(edgeCount: number, maximumOmega: number): Float64Array {
  const raw = new Float64Array(edgeCount * ALT_PARAMETERS_PER_BRANCH);
  const neutral = 0.8;
  const positive = Math.min(maximumOmega - 1e-6, 2);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const offset = edge * ALT_PARAMETERS_PER_BRANCH;
    raw[offset] = logit(0.1 / neutral);
    raw[offset + 1] = logit((neutral - 1e-5) / (1 - 2e-5));
    raw[offset + 2] = logit((positive - 1) / (maximumOmega - 1));
    raw[offset + 3] = Math.log(0.65 / 0.1);
    raw[offset + 4] = Math.log(0.25 / 0.1);
    raw[offset + 5] = 0;
  }
  return raw;
}

export function projectedNullRaw(alternativeRaw: ArrayLike<number>, edges: readonly number[]): Float64Array {
  const raw = new Float64Array(edges.length * NULL_PARAMETERS_PER_BRANCH);
  for (let index = 0; index < edges.length; index += 1) {
    const source = edges[index]! * ALT_PARAMETERS_PER_BRANCH;
    const target = index * NULL_PARAMETERS_PER_BRANCH;
    raw[target] = alternativeRaw[source]!;
    raw[target + 1] = alternativeRaw[source + 1]!;
    raw[target + 2] = alternativeRaw[source + 3]!;
    raw[target + 3] = alternativeRaw[source + 4]!;
    raw[target + 4] = alternativeRaw[source + 5]!;
  }
  return raw;
}
