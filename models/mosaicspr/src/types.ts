export interface MosaicSprAlignment {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
  readonly taxa: number;
  readonly sites: number;
  readonly matrix: Uint8Array;
  readonly variableSites: Uint32Array;
  readonly baseMasks?: Uint32Array;
  readonly canonicalMasks?: Uint32Array;
  readonly pairEqualMasks?: Uint32Array;
  readonly bitsetWords?: number;
}

export interface MosaicSprProgressDetail {
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
  readonly metricLabel?: string;
  readonly metricValue?: number;
  readonly indeterminate?: boolean;
}

export interface MosaicSprBreakpointProposal {
  readonly id: string;
  readonly rank: number;
  /** Break after this one-based aligned nucleotide site. */
  readonly breakpoint: number;
  readonly intervalLow: number;
  readonly intervalHigh: number;
  readonly supportLow: number;
  readonly supportHigh: number;
  readonly consensusScore: number;
  readonly evidence: number;
  readonly supportTriplets: number;
  readonly supportTaxa: number;
}

export type MosaicSprDraftKind = "global" | "segment" | "pair" | "triplet" | "window";

export interface MosaicSprTreeWindow {
  readonly id: string;
  readonly kind: MosaicSprDraftKind;
  readonly start: number;
  readonly end: number;
}

export interface MosaicSprDraftTree extends MosaicSprTreeWindow {
  readonly tree: string;
  readonly logLikelihood: number;
  readonly elapsedMs: number;
  readonly topologySignature?: string;
}

export interface MosaicSprProposalDiagnostics {
  readonly source: "fsart-triplet-plus-overlap" | "overlap-only";
  readonly scannedTriplets: number;
  readonly informativeTriplets: number;
  readonly testedBoundaries: number;
  readonly pairCoverageGuaranteed: boolean;
  readonly minimumTreeSpan: number;
}

export interface SprEdit {
  readonly step: number;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly prunedTaxa: readonly string[];
  readonly sourceSplit: readonly string[];
  readonly sourceAttachmentSplit: readonly string[];
  readonly destinationSplit: readonly string[];
}

export interface SprTopologyState {
  readonly id: string;
  readonly tree: string;
  readonly topologySignature: string;
  readonly seedDistance: number;
  readonly parsimony: number;
  readonly occupiedSites: number;
  readonly color: string;
}

export interface SprReconstructionRun {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly stateId: string;
  readonly stateIndex: number;
  readonly parsimony: number;
}

export interface SprBreakpointEvent {
  readonly breakpoint: number;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly sprDistance: number;
  readonly edits: readonly SprEdit[];
  readonly alternativeShortestScripts: number;
  readonly alternativesCapped: boolean;
}

export interface SprStateDerivation {
  readonly stateId: string;
  readonly occupiedSites: number;
  readonly sprDistanceFromMaster: number;
  readonly edits: readonly SprEdit[];
  readonly alternativeShortestScripts: number;
  readonly alternativesCapped: boolean;
}

export interface SprSearchIteration {
  readonly start: number;
  readonly iteration: number;
  readonly topologyStates: number;
  readonly occupiedStates: number;
  readonly candidatesEnumerated: number;
  readonly candidatesScored: number;
  readonly candidatesAdded: number;
  readonly objective: number;
  readonly improvement: number;
  readonly masterStateId: string;
  readonly elapsedMs: number;
}

export interface SprSearchCertificate {
  readonly globalOptimal: false;
  readonly completeOneSprNeighborhood: boolean;
  readonly scope: "exhaustive-one-spr-local" | "budgeted-column-generation";
  readonly searchedStarts: number;
  readonly topologyStates: number;
  readonly graphEdges: number;
  readonly unconnectedSeedTopologies: number;
  readonly message: string;
}

export interface SprReconstructionResult {
  readonly status: "complete" | "skipped" | "failed";
  readonly scoreKind: "fitch-parsimony-mdl";
  readonly objective: number | null;
  readonly parsimony: number | null;
  readonly nullParsimony: number | null;
  readonly breakpointPenalty: number;
  readonly sprPenalty: number;
  readonly masterPenalty: number;
  readonly minimumRunLength: number;
  readonly initialSeedStateId: string | null;
  readonly masterStateId: string | null;
  readonly masterChangedFromSeed: boolean;
  readonly states: readonly SprTopologyState[];
  readonly runs: readonly SprReconstructionRun[];
  readonly derivations: readonly SprStateDerivation[];
  readonly events: readonly SprBreakpointEvent[];
  readonly iterations: readonly SprSearchIteration[];
  readonly certificate: SprSearchCertificate;
  readonly elapsedMs: number;
  readonly message: string;
}

export interface SprReconstructionOptions {
  readonly minimumRunLength?: number;
  readonly breakpointPenalty?: number;
  readonly sprPenalty?: number;
  readonly masterPenalty?: number;
  readonly maximumStates?: number;
  readonly maximumIterations?: number;
  readonly beamWidth?: number;
  readonly parsimonyScreenLimit?: number;
  readonly maximumStarts?: number;
  readonly patience?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: MosaicSprProgressDetail) => void;
}

export interface MosaicSprAnalysisResult {
  readonly method: "mosaic-spr";
  readonly taxa: number;
  readonly sites: number;
  readonly variableSites: number;
  readonly proposals: readonly MosaicSprBreakpointProposal[];
  readonly proposalDiagnostics: MosaicSprProposalDiagnostics;
  readonly draftTrees: readonly MosaicSprDraftTree[];
  readonly reconstruction: SprReconstructionResult;
  readonly fastTreeVersion?: string;
  readonly timings: Readonly<Record<string, number>>;
  readonly eventCsv: string;
}
