export interface PatternTable {
  readonly taxa: number;
  readonly count: number;
  /** Pattern-major nucleotide masks. Zero input masks are normalized to N=15. */
  readonly masks: Uint8Array;
  readonly weights: Float64Array;
  readonly sitePattern: Int32Array;
}

export function compressPatterns(siteMajorMasks: Uint8Array, taxa: number, sites?: readonly number[]): PatternTable {
  if (!Number.isInteger(taxa) || taxa < 2 || siteMajorMasks.length % taxa !== 0) throw new RangeError("Pattern compression requires a rectangular site-major nucleotide mask array.");
  const siteCount = siteMajorMasks.length / taxa;
  const selected = sites ?? Array.from({ length: siteCount }, (_value, index) => index);
  const patterns: number[][] = [];
  const weights: number[] = [];
  const sitePattern = new Int32Array(selected.length);
  const byKey = new Map<string, number>();
  for (let offset = 0; offset < selected.length; offset += 1) {
    const site = selected[offset]!;
    if (site < 0 || site >= siteCount || !Number.isInteger(site)) throw new RangeError("A selected pattern site is outside the alignment.");
    const states: number[] = [];
    for (let taxon = 0; taxon < taxa; taxon += 1) states.push(siteMajorMasks[site * taxa + taxon]! || 15);
    const key = String.fromCharCode(...states);
    let pattern = byKey.get(key);
    if (pattern === undefined) {
      pattern = patterns.length;
      byKey.set(key, pattern);
      patterns.push(states);
      weights.push(0);
    }
    weights[pattern] = weights[pattern]! + 1;
    sitePattern[offset] = pattern;
  }
  const masks = new Uint8Array(patterns.length * taxa);
  for (let pattern = 0; pattern < patterns.length; pattern += 1) masks.set(patterns[pattern]!, pattern * taxa);
  return { taxa, count: patterns.length, masks, weights: Float64Array.from(weights), sitePattern };
}
