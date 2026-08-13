import {
  consensusBreakpointSignals,
  effectiveMinimumTreeSpan,
  planPairCoveredTriplets,
  refineTripletSignals,
  scanTripletShard,
} from "@phylo-workbench/model-fsart/browser-source";
import type {
  MosaicSprAlignment,
  MosaicSprBreakpointProposal,
  MosaicSprProgressDetail,
  MosaicSprProposalDiagnostics,
} from "./types.js";

export interface MosaicSprProposalOptions {
  readonly enabled?: boolean;
  readonly window?: number;
  readonly maximumTriplets?: number;
  readonly maximumSignals?: number;
  readonly maximumReportedSignals?: number;
  readonly maximumBreakpoints?: number;
  readonly minimumSegmentLength?: number;
  readonly mergeDistance?: number;
  readonly rateSlices?: number;
  readonly credibleMass?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: MosaicSprProgressDetail) => void;
}

export interface MosaicSprProposalResult {
  readonly proposals: readonly MosaicSprBreakpointProposal[];
  readonly diagnostics: MosaicSprProposalDiagnostics;
}

export function proposeMosaicSprBreakpoints(
  alignment: MosaicSprAlignment,
  options: MosaicSprProposalOptions = {},
): MosaicSprProposalResult {
  const minimumTreeSpan = effectiveMinimumTreeSpan(
    alignment.taxa,
    alignment.sites,
    alignment.variableSites.length,
    options.minimumSegmentLength ?? 150,
  );
  if (options.enabled === false) {
    return {
      proposals: [],
      diagnostics: {
        source: "overlap-only",
        scannedTriplets: 0,
        informativeTriplets: 0,
        testedBoundaries: 0,
        pairCoverageGuaranteed: false,
        minimumTreeSpan,
      },
    };
  }

  const sampling = planPairCoveredTriplets(alignment.taxa, options.maximumTriplets ?? 250_000);
  const shard = scanTripletShard(alignment, {
    window: options.window ?? 24,
    maximumSignals: options.maximumSignals ?? 1024,
    maximumSignalsPerTriplet: 4,
    ...(sampling.ranks === undefined ? {} : { tripletRanks: sampling.ranks }),
    pairCoverageGuaranteed: sampling.pairCoverageGuaranteed,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (fraction, detail) => options.onProgress?.(fraction * 0.68, detail),
  });
  options.signal?.throwIfAborted();
  const maximumReported = Math.max(1, Math.round(options.maximumReportedSignals ?? 256));
  const raw = shard.signals.slice().sort((first, second) => first.logP - second.logP).slice(0, maximumReported);
  const refined = refineTripletSignals(alignment, raw, shard.testedBoundaries, {
    rateSlices: options.rateSlices ?? 9,
    credibleMass: options.credibleMass ?? 0.95,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (fraction, detail) => options.onProgress?.(0.68 + fraction * 0.27, detail),
  });
  options.signal?.throwIfAborted();
  const merged = consensusBreakpointSignals(refined, {
    mergeDistance: options.mergeDistance ?? 12,
    minimumSpacing: minimumTreeSpan,
    sites: alignment.sites,
    maximumCandidates: options.maximumBreakpoints ?? 14,
  });
  const proposals = merged.map((value): MosaicSprBreakpointProposal => ({
    id: value.id,
    rank: value.rank,
    breakpoint: value.breakpoint,
    intervalLow: value.intervalLow,
    intervalHigh: value.intervalHigh,
    supportLow: value.supportLow,
    supportHigh: value.supportHigh,
    consensusScore: value.consensusScore,
    evidence: value.evidence,
    supportTriplets: value.supportTriplets,
    supportTaxa: value.supportTaxa,
  }));
  options.onProgress?.(1, {
    message: `${proposals.length} triplet-consensus region proposal${proposals.length === 1 ? "" : "s"}; overlapping windows remain as a safety net`,
    current: proposals.length,
    total: proposals.length,
  });
  return {
    proposals,
    diagnostics: {
      source: "fsart-triplet-plus-overlap",
      scannedTriplets: shard.scannedTriplets,
      informativeTriplets: shard.informativeTriplets,
      testedBoundaries: shard.testedBoundaries,
      pairCoverageGuaranteed: shard.pairCoverageGuaranteed,
      minimumTreeSpan,
    },
  };
}
