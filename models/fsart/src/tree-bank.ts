import { canonicalTopologySignature, isFullyResolvedTopology } from "./tree-discordance.js";
import type { MergedBreakpoint, SegmentLikelihood } from "./types.js";

export interface TreeHypothesisEntry {
  readonly segment: SegmentLikelihood;
  readonly signature: string;
  /** Zero-based position of this independently fitted full tree in the source family. */
  readonly sourceIndex: number;
}

export interface TreeBankWindow {
  readonly start: number;
  readonly end: number;
}

export interface TreeFamilyWindow extends TreeBankWindow {
  readonly id: string;
  readonly kind: "segment" | "pair" | "triplet" | "global";
  readonly firstSegment: number;
  readonly lastSegment: number;
  readonly span: number;
}

/**
 * Conservative lower bound for a topology-training window. Nucleotide length
 * alone is misleading on shallow alignments, so require enough columns to
 * expect at least max(30, 2 x taxa) variable sites at the observed alignment-
 * wide rate. The user value is a lower bound, never an override of this guard.
 */
export function effectiveMinimumTreeSpan(
  taxa: number,
  sites: number,
  variableSites: number,
  requested = 150,
): number {
  const maximum = Math.max(1, Math.floor(sites / 2));
  const variableFraction = Math.max(1 / Math.max(1, sites), variableSites / Math.max(1, sites));
  const informationTarget = Math.max(30, 2 * Math.max(3, Math.round(taxa)));
  const informationSpan = Math.ceil(informationTarget / variableFraction);
  return Math.min(maximum, Math.max(60, Math.round(requested), informationSpan));
}

/**
 * Turn consensus boundaries into the complete, bounded topology proposal
 * family requested by FSART: every atomic segment, every adjacent pair, every
 * adjacent triplet, and the whole alignment. No longer windows are generated.
 */
export function treeFamilyWindows(
  breakpoints: readonly number[],
  sites: number,
  minimumSegmentLength = 30,
): TreeFamilyWindow[] {
  const minimum = Math.max(1, Math.round(minimumSegmentLength));
  const cuts = Array.from(new Set(breakpoints.map(Math.round)))
    .filter((value) => value >= minimum && sites - value >= minimum)
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || value - values[index - 1]! >= minimum);
  const boundaries = [0, ...cuts, sites];
  const segmentCount = boundaries.length - 1;
  const output: TreeFamilyWindow[] = [{
    id: "GLOBAL",
    kind: "global",
    start: 1,
    end: sites,
    firstSegment: 1,
    lastSegment: segmentCount,
    span: segmentCount,
  }];
  for (let span = 1; span <= Math.min(3, segmentCount); span += 1) {
    for (let first = 0; first + span <= segmentCount; first += 1) {
      const start = boundaries[first]! + 1;
      const end = boundaries[first + span]!;
      if (start === 1 && end === sites) continue;
      if (end - start + 1 < minimum) continue;
      const kind = span === 1 ? "segment" as const : span === 2 ? "pair" as const : "triplet" as const;
      output.push({
        id: `${kind === "segment" ? "S" : kind === "pair" ? "P" : "T"}${first + 1}-${first + span}`,
        kind,
        start,
        end,
        firstSegment: first + 1,
        lastSegment: first + span,
        span,
      });
    }
  }
  return output;
}

/** Seven half-overlapping quarter-alignment windows in the common case. This
 * constant-size supplement is what allows an internal mosaic genealogy to
 * enter the dictionary without enumerating O(candidates²) breakpoint pairs. */
export function treeBankWindows(sites: number, minimumSegmentLength = 30): TreeBankWindow[] {
  const minimum = Math.max(1, Math.round(minimumSegmentLength));
  if (sites < minimum) return [];
  const length = Math.min(sites, Math.max(minimum, Math.round(sites / 4)));
  const stride = Math.max(1, Math.floor(length / 2));
  const windows: TreeBankWindow[] = [];
  for (let start = 1; start <= sites; start += stride) {
    const end = Math.min(sites, start + length - 1);
    if (end - start + 1 >= minimum) windows.push({ start, end });
    if (end === sites) break;
  }
  const finalStart = Math.max(1, sites - length + 1);
  if (!windows.some((window) => window.start === finalStart && window.end === sites)) windows.push({ start: finalStart, end: sites });
  return windows;
}

/**
 * Pick cuts for independent prefix/suffix tree fits. Evidence rank remains the
 * primary ordering, but the first pass enforces spatial coverage so that a
 * cluster of strong decoy peaks cannot consume the entire topology budget.
 */
export function selectTreeBankBreakpoints(
  candidates: readonly MergedBreakpoint[],
  sites: number,
  maximumCandidates = 12,
  minimumSegmentLength = 30,
): MergedBreakpoint[] {
  const budget = Math.max(1, Math.min(100, Math.round(maximumCandidates)));
  const minimum = Math.max(1, Math.round(minimumSegmentLength));
  const ranked = candidates
    .filter((candidate) => candidate.breakpoint >= minimum && sites - candidate.breakpoint >= minimum)
    .slice()
    .sort((first, second) => second.evidence - first.evidence || first.rank - second.rank || first.breakpoint - second.breakpoint);
  if (ranked.length <= budget) return ranked;
  const separation = Math.max(minimum, Math.floor(sites / budget));
  const selected: MergedBreakpoint[] = [];
  const selectedIds = new Set<string>();
  for (const candidate of ranked) {
    if (selected.some((value) => Math.abs(value.breakpoint - candidate.breakpoint) < separation)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length >= budget) return selected;
  }
  // Fill unused slots by evidence rank. The coverage pass deliberately does
  // not turn spacing into an exclusion criterion.
  for (const candidate of ranked) {
    if (selectedIds.has(candidate.id)) continue;
    selected.push(candidate);
    if (selected.length >= budget) break;
  }
  return selected;
}

/**
 * Retain independently fitted full trees without topology deduplication. Two
 * trees with the same unrooted splits can have different branch lengths and
 * Gamma shapes, and therefore define different likelihood profiles. The
 * whole-alignment fit is ordered first so index zero remains the explicit
 * one-tree null; every other resolved fit keeps source-family order.
 */
export function selectTreeHypotheses(
  segments: readonly SegmentLikelihood[],
  sites: number,
  maximumTrees = 1000,
): TreeHypothesisEntry[] {
  const limit = Math.max(1, Math.min(1000, Math.round(maximumTrees)));
  const resolved = segments.flatMap((segment, sourceIndex): TreeHypothesisEntry[] => (
    isFullyResolvedTopology(segment.tree)
      ? [{ segment, signature: canonicalTopologySignature(segment.tree), sourceIndex }]
      : []
  ));
  const global = resolved.filter((entry) => entry.segment.start === 1 && entry.segment.end === sites);
  const regional = resolved.filter((entry) => entry.segment.start !== 1 || entry.segment.end !== sites);
  return [...global, ...regional].slice(0, limit);
}
