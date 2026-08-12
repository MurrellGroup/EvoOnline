import { canonicalTopologySignature, isFullyResolvedTopology } from "./tree-discordance.js";
import type { MergedBreakpoint, SegmentLikelihood } from "./types.js";

export interface TopologyDictionaryEntry {
  readonly segment: SegmentLikelihood;
  readonly signature: string;
  readonly occurrences: number;
  readonly supportBases: number;
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

function overlapLength(first: SegmentLikelihood, second: SegmentLikelihood): number {
  return Math.max(0, Math.min(first.end, second.end) - Math.max(first.start, second.start) + 1);
}

/**
 * Prefix/suffix fits are excellent topology finders but poor branch-length
 * training sources when they cross a real breakpoint. Prefer the fixed-size
 * overlapping local windows whenever they recovered the same topology. A
 * local medoid makes the choice stable when several windows agree.
 */
function regionalRepresentative(sources: readonly SegmentLikelihood[], sites: number): SegmentLikelihood {
  const target = Math.max(1, sites / 4);
  const local = sources.filter((source) => {
    const length = source.end - source.start + 1;
    return length >= target * 0.5 && length <= target * 1.5;
  });
  const eligible = local.length > 0 ? local : sources;
  return eligible.slice().sort((first, second) => {
    const firstLength = first.end - first.start + 1;
    const secondLength = second.end - second.start + 1;
    const firstCorroboration = local.reduce((sum, source) => sum + overlapLength(first, source) / Math.max(1, Math.min(firstLength, source.end - source.start + 1)), 0);
    const secondCorroboration = local.reduce((sum, source) => sum + overlapLength(second, source) / Math.max(1, Math.min(secondLength, source.end - source.start + 1)), 0);
    return secondCorroboration - firstCorroboration
      || Math.abs(firstLength - target) - Math.abs(secondLength - target)
      || secondLength - firstLength
      || first.start - second.start;
  })[0]!;
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
 * Collapse segment fits by unrooted topology and rank recurring hypotheses by
 * the total number of source-alignment bases supporting them. The global tree
 * is retained first as the explicit one-tree null.
 */
export function buildTopologyDictionary(
  segments: readonly SegmentLikelihood[],
  sites: number,
  maximumTrees = 8,
): TopologyDictionaryEntry[] {
  const limit = Math.max(1, Math.min(64, Math.round(maximumTrees)));
  const groups = new Map<string, {
    sources: SegmentLikelihood[];
    occurrences: number;
    supportBases: number;
  }>();
  const seenSources = new Set<string>();
  for (const segment of segments) {
    // Low-information windows can make FastTree emit a genuine polytomy. Its
    // later -intree/-mllen path requires bifurcation and may assert in native
    // or WASM builds, so unresolved exploratory states are not admissible.
    if (!isFullyResolvedTopology(segment.tree)) continue;
    const signature = canonicalTopologySignature(segment.tree);
    const sourceKey = `${segment.start}:${segment.end}:${signature}`;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    const length = Math.max(0, segment.end - segment.start + 1);
    const current = groups.get(signature);
    if (current === undefined) {
      groups.set(signature, { sources: [segment], occurrences: 1, supportBases: length });
      continue;
    }
    current.sources.push(segment);
    current.occurrences += 1;
    current.supportBases += length;
  }
  const entries = Array.from(groups, ([signature, group]): TopologyDictionaryEntry => ({
    // Preserve the whole-alignment fit as the explicit null. Other topology
    // states use a locally coherent source for branch-length optimization.
    segment: group.sources.find((source) => source.start === 1 && source.end === sites)
      ?? regionalRepresentative(group.sources, sites),
    signature,
    occurrences: group.occurrences,
    supportBases: group.supportBases,
  }));
  const global = entries.find((entry) => entry.segment.start === 1 && entry.segment.end === sites);
  const remaining = entries
    .filter((entry) => entry !== global)
    .sort((first, second) => second.supportBases - first.supportBases
      || second.occurrences - first.occurrences
      || (second.segment.end - second.segment.start) - (first.segment.end - first.segment.start)
      || first.signature.localeCompare(second.signature));
  return [...(global === undefined ? [] : [global]), ...remaining].slice(0, limit);
}
