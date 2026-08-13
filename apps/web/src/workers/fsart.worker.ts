/// <reference lib="webworker" />
import {
  assembleScanResult,
  effectiveMinimumTreeSpan,
  exploreTreeHmm,
  fitTreeHmm,
  parseFsartFasta,
  scanTripletShard,
  type FsartAnalysisOptions,
  type FsartAnalysisResult,
  type FsartAlignment,
  type ScanShardResult,
  type TreeEmissionProfile,
  type TreeHmmResult,
  type TreeHmmExplorationOptions,
  type TreeHmmExplorationResult,
  type InformationCriterion,
} from "@phylo-workbench/model-fsart/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";

interface ScanRequest {
  readonly type: "scan";
  readonly id: string;
  readonly alignment: string;
  readonly parameters: ParameterValues;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly tripletRanks?: Float64Array;
  readonly pairCoverageGuaranteed?: boolean;
}

interface RefineRequest {
  readonly type: "refine";
  readonly id: string;
  readonly alignment: string;
  readonly parameters: ParameterValues;
  readonly shards: readonly ScanShardResult[];
  readonly scanMs: number;
}

interface TreeHmmRequest {
  readonly type: "tree-hmm";
  readonly id: string;
  readonly profiles: readonly TreeEmissionProfile[];
  readonly taxa: number;
  readonly criterion: InformationCriterion;
  readonly credibleMass: number;
  readonly rateSlices: number;
  readonly maximumStates: number;
  readonly beamWidth: number;
  readonly minimumRunLength: number;
  readonly stage?: string;
}

interface TreeHmmExploreInitRequest {
  readonly type: "tree-hmm-explore-init";
  readonly id: string;
  readonly profiles: readonly TreeEmissionProfile[];
}

interface TreeHmmExploreRequest {
  readonly type: "tree-hmm-explore";
  readonly id: string;
  readonly options: TreeHmmExplorationOptions;
}

type Request = ScanRequest | RefineRequest | TreeHmmRequest | TreeHmmExploreInitRequest | TreeHmmExploreRequest;
type Response =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail: { readonly message: string; readonly current?: number; readonly total?: number; readonly metricLabel?: string; readonly metricValue?: number; readonly indeterminate?: boolean } }
  | { readonly type: "shard"; readonly id: string; readonly shard: ScanShardResult }
  | { readonly type: "result"; readonly id: string; readonly result: FsartAnalysisResult }
  | { readonly type: "tree-hmm-result"; readonly id: string; readonly result: TreeHmmResult }
  | { readonly type: "tree-hmm-explore-ready"; readonly id: string; readonly profileCount: number }
  | { readonly type: "tree-hmm-explore-result"; readonly id: string; readonly result: TreeHmmExplorationResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

const scope = self as DedicatedWorkerGlobalScope;
let cachedText = "";
let cachedAlignment: FsartAlignment | undefined;
let cachedExploreProfiles: readonly TreeEmissionProfile[] = [];

function alignmentFor(text: string): FsartAlignment {
  if (cachedAlignment === undefined || cachedText !== text) {
    cachedText = text;
    cachedAlignment = parseFsartFasta(text);
  }
  return cachedAlignment;
}

function options(parameters: ParameterValues, taxa: number, sites: number, variableSites: number): FsartAnalysisOptions {
  const minimumSegmentLength = effectiveMinimumTreeSpan(taxa, sites, variableSites, Number(parameters.minimumSegmentLength ?? 150));
  return {
    window: Number(parameters.window ?? 24),
    mergeDistance: Number(parameters.mergeDistance ?? 12),
    maximumSignals: Number(parameters.maximumSignals ?? 1024),
    maximumReportedSignals: Number(parameters.maximumReportedSignals ?? 256),
    rateSlices: Number(parameters.rateSlices ?? 9),
    credibleMass: Number(parameters.credibleMass ?? 0.95),
    runFastTree: Boolean(parameters.runFastTree ?? true),
    criterion: parameters.criterion === "aic" || parameters.criterion === "bic" ? parameters.criterion : "aicc",
    minimumSegmentLength,
    maximumTriplets: Number(parameters.maximumTriplets ?? 250000),
    maximumConsensusBreakpoints: Number(parameters.maximumConsensusBreakpoints ?? 14),
    maximumBreakpoints: Number(parameters.maximumBreakpoints ?? 8),
    maximumPartitionCandidates: Number(parameters.maximumPartitionCandidates ?? 24),
    fastTreeFastest: Boolean(parameters.fastTreeFastest ?? true),
    runTreeHmm: Boolean(parameters.runTreeHmm ?? true),
    maximumTreeHypotheses: Number(parameters.maximumTreeHypotheses ?? 8),
    maximumTreeBankCandidates: Number(parameters.maximumTreeBankCandidates ?? 12),
    treeHmmSourceWeight: Number(parameters.treeHmmSourceWeight ?? 4),
  };
}

scope.onmessage = (event: MessageEvent<Request>): void => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === "tree-hmm-explore-init") {
        cachedExploreProfiles = request.profiles;
        const response: Response = { type: "tree-hmm-explore-ready", id: request.id, profileCount: cachedExploreProfiles.length };
        scope.postMessage(response);
        return;
      }
      if (request.type === "tree-hmm-explore") {
        const result = exploreTreeHmm(cachedExploreProfiles, request.options);
        const response: Response = { type: "tree-hmm-explore-result", id: request.id, result };
        scope.postMessage(response);
        return;
      }
      if (request.type === "tree-hmm") {
        const result = fitTreeHmm(request.profiles, {
          taxa: request.taxa,
          criterion: request.criterion,
          credibleMass: request.credibleMass,
          maximumRateSlices: request.rateSlices,
          maximumStates: request.maximumStates,
          beamWidth: request.beamWidth,
          minimumRunLength: request.minimumRunLength,
          searchMode: "rapid",
          onProgress: (fraction, detail) => {
            const message: Response = { type: "progress", id: request.id, stage: request.stage ?? "tree-hmm", fraction, detail };
            scope.postMessage(message);
          },
        });
        const response: Response = { type: "tree-hmm-result", id: request.id, result };
        scope.postMessage(response);
        return;
      }
      const parsed = alignmentFor(request.alignment);
      const configured = options(request.parameters, parsed.taxa, parsed.sites, parsed.variableSites.length);
      if (request.type === "scan") {
        const shard = scanTripletShard(parsed, {
          ...configured,
          rangeStart: request.rangeStart,
          rangeEnd: request.rangeEnd,
          ...(request.tripletRanks === undefined ? {} : { tripletRanks: request.tripletRanks }),
          ...(request.pairCoverageGuaranteed === undefined ? {} : { pairCoverageGuaranteed: request.pairCoverageGuaranteed }),
          onProgress: (fraction, detail) => {
            const message: Response = { type: "progress", id: request.id, stage: "triplet-scan", fraction, detail };
            scope.postMessage(message);
          },
        });
        const response: Response = { type: "shard", id: request.id, shard };
        scope.postMessage(response);
      } else {
        const result = assembleScanResult(parsed, request.shards, {
          ...configured,
          onStage: (stage, fraction, detail) => {
            const message: Response = { type: "progress", id: request.id, stage, fraction, detail: detail ?? { message: stage } };
            scope.postMessage(message);
          },
        }, request.scanMs);
        const response: Response = { type: "result", id: request.id, result };
        scope.postMessage(response);
      }
    } catch (error) {
      const response: Response = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
      scope.postMessage(response);
    }
  })();
};

export type { Request as FsartWorkerRequest, Response as FsartWorkerResponse };
