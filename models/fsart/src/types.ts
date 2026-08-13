export type TripletState = 0 | 1 | 2;
export type InformationCriterion = "aic" | "aicc" | "bic";

export interface FsartAlignment {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
  readonly taxa: number;
  readonly sites: number;
  /** Site-major A/C/G/T codes (0..3); 255 marks gaps and ambiguous bases. */
  readonly matrix: Uint8Array;
  /** Zero-based sites that can possibly inform at least one triplet. */
  readonly variableSites: Uint32Array;
  /** Taxon-major, then base-major, 32-site A/C/G/T bit planes. */
  readonly baseMasks?: Uint32Array;
  /** Taxon-major masks of sites containing an unambiguous canonical base. */
  readonly canonicalMasks?: Uint32Array;
  /** Optional pair-major canonical-equality masks for small/medium inputs. */
  readonly pairEqualMasks?: Uint32Array;
  readonly bitsetWords?: number;
}

export interface FsartScanOptions {
  /** Informative events on each side of a tested boundary. */
  readonly window?: number;
  readonly maximumSignals?: number;
  readonly maximumSignalsPerTriplet?: number;
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
  /** Optional lexicographic triplet ranks for deterministic sampled scans. */
  readonly tripletRanks?: Float64Array;
  /** True when the supplied triplets were constructed to cover every taxon pair. */
  readonly pairCoverageGuaranteed?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: FsartProgressDetail) => void;
}

export interface FsartProgressDetail {
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
  readonly metricLabel?: string;
  readonly metricValue?: number;
  readonly indeterminate?: boolean;
}

export interface RawTripletSignal {
  readonly taxa: readonly [number, number, number];
  /** Break after this one-based alignment site. */
  readonly breakpoint: number;
  /** Boundary in the triplet's informative-event stream. */
  readonly eventBoundary: number;
  readonly informativeEvents: number;
  readonly leftState: TripletState;
  readonly rightState: TripletState;
  readonly leftCounts: readonly [number, number, number];
  readonly rightCounts: readonly [number, number, number];
  readonly g2: number;
  /** Natural logarithm of the raw df=2 chi-square tail probability. */
  readonly logP: number;
}

export interface ScanShardResult {
  readonly signals: readonly RawTripletSignal[];
  readonly testedBoundaries: number;
  readonly scannedTriplets: number;
  readonly informativeTriplets: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly pairCoverageGuaranteed: boolean;
}

export interface SwitchingRateSlice {
  readonly expectedSwitches: number;
  readonly posterior: number;
}

export interface TripletTrace {
  /** Zero-based alignment indices of informative sites. */
  readonly positions: Uint32Array;
  readonly observations: Uint8Array;
  /** Marginal MAP topology state at every informative event. */
  readonly mapStates: Uint8Array;
  /** Posterior that the hidden topology changes after event i. */
  readonly switchPosterior: Float32Array;
}

export interface RefinedTripletSignal extends RawTripletSignal {
  readonly taxaNames: readonly [string, string, string];
  readonly rawP: number;
  /** Bonferroni value retained only as an audit diagnostic; it never admits or rejects scan candidates. */
  readonly adjustedP: number;
  /** Uncapped -log10 raw scan p-value used to rank candidates. */
  readonly evidence: number;
  readonly intervalLow: number;
  readonly intervalHigh: number;
  readonly switchPosterior: number;
  readonly emissionAccuracy: number;
  readonly switchingRates: readonly SwitchingRateSlice[];
  readonly trace: TripletTrace;
}

export interface MergedBreakpoint {
  readonly id: string;
  readonly rank: number;
  readonly breakpoint: number;
  /** Candidate-local conditional switch-location interval of the strongest triplet. */
  readonly intervalLow: number;
  readonly intervalHigh: number;
  /** Full envelope used while merging overlapping triplet intervals. */
  readonly supportLow: number;
  readonly supportHigh: number;
  readonly evidence: number;
  /** Count-and-strength consensus objective used before hard-spacing selection. */
  readonly consensusScore: number;
  /** Kernel-weighted, winsorized sum of raw triplet evidence. */
  readonly strengthScore: number;
  readonly adjustedP: number;
  readonly supportTriplets: number;
  readonly supportTaxa: number;
  readonly representative: RefinedTripletSignal;
  readonly memberIndexes: readonly number[];
}

export interface FsartRefinementOptions {
  /** Informative events on each side of the scan candidate; anchors its local HMM mode. */
  readonly window?: number;
  readonly credibleMass?: number;
  readonly rateSlices?: number;
  readonly mergeDistance?: number;
  readonly maximumReportedSignals?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: FsartProgressDetail) => void;
}

export interface SegmentLikelihood {
  /** Inclusive one-based alignment coordinates. */
  readonly start: number;
  readonly end: number;
  readonly logLikelihood: number;
  readonly tree: string;
  readonly variableSites: number;
  readonly elapsedMs: number;
  /** Optional FastTree model estimates. The whole-alignment fit seeds shared tree-HMM scoring. */
  readonly gtrFrequencies?: readonly [number, number, number, number];
  readonly gtrRates?: readonly [number, number, number, number, number, number];
  readonly gammaAlpha?: number;
}

export interface PartitionSegment extends SegmentLikelihood {
  readonly id: string;
}

export interface PartitionStep {
  readonly candidateRank: number;
  readonly breakpoint: number;
  readonly accepted: boolean;
  readonly reason: string;
  readonly criterionBefore: number;
  readonly criterionAfter: number;
  readonly deltaCriterion: number;
  readonly logLikelihoodBefore: number;
  readonly logLikelihoodAfter: number;
  readonly parameterCountBefore: number;
  readonly parameterCountAfter: number;
  readonly consecutiveFailures: number;
}

export interface StepwisePartitionResult {
  readonly status: "complete" | "skipped" | "failed";
  readonly criterion: InformationCriterion;
  readonly criterionValue: number | null;
  readonly segments: readonly PartitionSegment[];
  /** Successful global/segment/pair/triplet tree-family fits before topology deduplication. */
  readonly candidateTrees: readonly PartitionSegment[];
  readonly steps: readonly PartitionStep[];
  readonly acceptedBreakpoints: readonly number[];
  readonly rejectedBreakpoints: readonly number[];
  readonly fastTreeVersion?: string;
  readonly message?: string;
}

export interface TreeEmissionProfile {
  readonly id: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sourceRanges?: readonly (readonly [number, number])[];
  readonly tree: string;
  readonly topologySignature: string;
  readonly logLikelihood: number;
  /** One GTR+Gamma log likelihood per aligned nucleotide site. */
  readonly siteLogLikelihoods: readonly number[] | Float64Array;
  readonly gammaAlpha?: number;
  readonly elapsedMs: number;
}

export interface TreeHmmState {
  readonly id: string;
  readonly tree: string;
  readonly topologySignature: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sourceRanges?: readonly (readonly [number, number])[];
  readonly weight: number;
  readonly occupancy: number;
  readonly expectedSites: number;
  readonly color: string;
}

export interface TreeHmmRateSlice {
  readonly expectedResets: number;
  readonly transitionProbability: number;
  readonly logLikelihood: number;
  readonly posterior: number;
}

export interface TreeHmmSwitchInterval {
  readonly rank: number;
  /** Switch after this one-based aligned nucleotide site. */
  readonly breakpoint: number;
  readonly intervalLow: number;
  readonly intervalHigh: number;
  readonly peakProbability: number;
  /** Expected switch count inside this local posterior basin. */
  readonly expectedSwitchMass: number;
}

export interface TreeHmmSearchStep {
  readonly treeCountBefore: number;
  readonly removedTreeId: string;
  readonly removedExpectedSites: number;
  readonly criterionBefore: number;
  readonly criterionAfter: number;
  readonly accepted: boolean;
}

export interface TreeHmmSubsetSearchStep {
  readonly round: number;
  readonly move: "seed" | "add" | "drop" | "swap";
  readonly treeIds: readonly string[];
  readonly criterionValue: number;
  readonly deltaCriterion: number;
}

export interface TreeHmmSubsetSearchSummary {
  readonly algorithm: "beam-forward-floating";
  readonly evaluatedSubsets: number;
  readonly beamWidth: number;
  readonly maximumStates: number;
  readonly selectedTreeIds: readonly string[];
  readonly selectedProfileIndexes: readonly number[];
  readonly criterionValue: number;
  readonly nullCriterionValue: number;
  readonly converged: boolean;
  readonly steps: readonly TreeHmmSubsetSearchStep[];
  readonly elapsedMs: number;
}

export interface TreeHmmViterbiRun {
  readonly start: number;
  readonly end: number;
  readonly state: number;
  readonly treeId: string;
}

export interface TreeHmmViterbiResult {
  readonly statePath: Uint16Array;
  readonly runs: readonly TreeHmmViterbiRun[];
  readonly breakpoints: readonly number[];
  readonly logProbability: number;
  readonly expectedResets: number;
  readonly minimumRunLength: number;
}

export interface TreeHmmRefinementIteration {
  readonly iteration: number;
  readonly stateCount: number;
  readonly breakpoints: readonly number[];
  readonly maximumBoundaryShift: number | null;
  readonly topologyChanged: boolean;
  readonly criterionValue: number | null;
  readonly logLikelihood: number | null;
  readonly fastTreeMs: number;
  readonly elapsedMs: number;
}

export interface TreeHmmRefinementResult {
  readonly status: "complete" | "skipped" | "failed";
  readonly converged: boolean;
  readonly maximumIterations: number;
  readonly iterations: readonly TreeHmmRefinementIteration[];
  readonly message: string;
}

export interface TreeHmmResult {
  readonly status: "complete" | "skipped" | "failed";
  readonly criterion: InformationCriterion;
  readonly criterionValue: number | null;
  readonly nullCriterionValue: number | null;
  /** Positive values favor the selected tree HMM over the one-tree model. */
  readonly deltaCriterion: number | null;
  readonly logLikelihood: number | null;
  readonly integratedLogEvidence: number | null;
  readonly nullLogLikelihood: number | null;
  readonly parameterCount: number | null;
  readonly nullParameterCount: number | null;
  readonly sites: number;
  readonly states: readonly TreeHmmState[];
  /** State-major posterior matrix: state * sites + site. */
  readonly statePosterior: Float32Array;
  readonly mapState: Uint16Array;
  /** Marginal posterior that adjacent sites use different topology states. */
  readonly switchPosterior: Float32Array;
  readonly switchIntervals: readonly TreeHmmSwitchInterval[];
  readonly switchingRates: readonly TreeHmmRateSlice[];
  readonly expectedSwitches: number;
  readonly searchSteps: readonly TreeHmmSearchStep[];
  readonly subsetSearch?: TreeHmmSubsetSearchSummary;
  readonly viterbi?: TreeHmmViterbiResult;
  readonly refinement?: TreeHmmRefinementResult;
  readonly fastTreeMs: number;
  readonly hmmMs: number;
  readonly message?: string;
}

export type TreeHmmExplorationMode = "fixed-low-switch" | "sparse-dirichlet";

/**
 * Interactive topology-HMM reconstruction over the already-scored draft tree
 * family. These fits never call FastTree and never perform a combinatorial
 * subset search: every update is O(alignment sites x active trees).
 */
export interface TreeHmmExplorationResult {
  readonly status: "complete" | "failed";
  readonly mode: TreeHmmExplorationMode;
  readonly sites: number;
  readonly draftStateCount: number;
  readonly states: readonly TreeHmmState[];
  /** State-major posterior matrix: state * sites + site. */
  readonly statePosterior: Float32Array;
  readonly mapState: Uint16Array;
  readonly switchPosterior: Float32Array;
  readonly expectedSwitches: number;
  readonly expectedResets: number;
  readonly transitionProbability: number;
  readonly logLikelihood: number;
  readonly viterbi: TreeHmmViterbiResult;
  readonly iterations: number;
  readonly converged: boolean;
  readonly droppedTreeIds: readonly string[];
  readonly dirichletConcentration?: number;
  readonly elapsedMs: number;
  readonly message: string;
}

export interface TreeHmmExplorationOptions {
  readonly mode: TreeHmmExplorationMode;
  /** Prior expected reset opportunities over the complete alignment. */
  readonly expectedResets: number;
  /** Symmetric per-tree Dirichlet concentration used by variational EM. */
  readonly dirichletConcentration?: number;
  readonly maximumIterations?: number;
  readonly minimumRunLength?: number;
  readonly pruningWeight?: number;
}

export interface DiscordantClade {
  readonly betweenSegments: readonly [string, string];
  readonly direction: "lost" | "gained";
  readonly taxa: readonly string[];
  readonly size: number;
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
  /** Minimum number of discovered graph edges from this search's initial seed. */
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
  /** Switch after this one-based aligned nucleotide site. */
  readonly breakpoint: number;
  readonly fromStateId: string;
  readonly toStateId: string;
  /** Shortest distance in the explicitly explored SPR graph. */
  readonly sprDistance: number;
  /** One complete, valid edit script. Length may be greater than one. */
  readonly edits: readonly SprEdit[];
  /** Number of shortest discovered scripts, capped at the reported limit. */
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

/**
 * Parsimony-first reconstruction in an explicit, connected unrooted-SPR
 * graph. Local trees are unrestricted compositions of edits; neither the
 * master topology nor the number of edits at a boundary is fixed in advance.
 */
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
  /** Explicit master-to-state scripts for every occupied local topology. */
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
  readonly onProgress?: (fraction: number, detail: FsartProgressDetail) => void;
}

export interface FsartDiagnostics {
  readonly taxa: number;
  readonly sites: number;
  readonly variableSites: number;
  readonly totalTriplets: number;
  readonly scannedTriplets: number;
  readonly tripletSampling: "exhaustive" | "pair-covered";
  readonly pairCoverageGuaranteed: boolean;
  readonly totalTaxonPairs: number;
  readonly informativeTriplets: number;
  readonly testedBoundaries: number;
  readonly scanWindow: number;
  readonly minimumTreeSpan: number;
  readonly expectedVariableSitesPerMinimumSpan: number;
  readonly parallelWorkers: number;
  readonly multipleTesting: "none-ranked-candidate-generation";
  readonly breakpointUncertainty: "three-state-burt-style-hmm-rate-marginalization";
  readonly intervalConditioning: "candidate-window-local-posterior-basin";
  readonly exactBurtParity: false;
  readonly baumWelch: false;
  readonly scanner: "bitset-informative-event-g-test";
  readonly pairEqualityCache: boolean;
  readonly bitsetWords: number;
}

export interface FsartAnalysisResult {
  readonly method: "fsart";
  readonly breakpoints: readonly MergedBreakpoint[];
  readonly tripletSignals: readonly RefinedTripletSignal[];
  readonly partition: StepwisePartitionResult;
  readonly treeHmm: TreeHmmResult;
  /**
   * Full pre-search fixed-topology emission bank. It is intentionally retained
   * so switching priors and sparse tree weights can be explored instantly
   * without rerunning FastTree.
   */
  readonly treeHmmProfiles: readonly TreeEmissionProfile[];
  /** Explicit multi-edit SPR reconstruction; independent of the tree-HMM subset model. */
  readonly sprReconstruction: SprReconstructionResult;
  readonly discordantClades: readonly DiscordantClade[];
  readonly diagnostics: FsartDiagnostics;
  readonly timings: Readonly<Record<string, number>>;
  readonly breakpointCsv: string;
  readonly partitionCsv: string;
  readonly treeHmmCsv: string;
}

export interface FsartAnalysisOptions extends FsartScanOptions, FsartRefinementOptions {
  /** Supplemental budget; the deterministic all-pairs cover is never truncated to satisfy it. */
  readonly maximumTriplets?: number;
  readonly runFastTree?: boolean;
  readonly criterion?: InformationCriterion;
  readonly minimumSegmentLength?: number;
  readonly maximumBreakpoints?: number;
  readonly maximumPartitionCandidates?: number;
  readonly fastTreeFastest?: boolean;
  readonly runTreeHmm?: boolean;
  readonly maximumTreeHypotheses?: number;
  readonly maximumTreeBankCandidates?: number;
  readonly maximumConsensusBreakpoints?: number;
  readonly treeHmmSourceWeight?: number;
  readonly runSprReconstruction?: boolean;
  readonly maximumSprStates?: number;
  readonly maximumSprIterations?: number;
  readonly sprBeamWidth?: number;
  readonly sprParsimonyScreenLimit?: number;
  readonly maximumSprStarts?: number;
  readonly sprSearchPatience?: number;
  /** Zero/undefined selects the data-size default. */
  readonly sprBreakpointPenalty?: number;
  /** Zero/undefined selects the taxon-count default. */
  readonly sprMovePenalty?: number;
  /** Zero/undefined selects the compact-master default. */
  readonly sprMasterPenalty?: number;
  readonly onStage?: (stage: string, fraction: number, detail: FsartProgressDetail) => void;
}

export interface TreeHmmOptions {
  readonly criterion?: InformationCriterion;
  readonly taxa: number;
  readonly credibleMass?: number;
  readonly maximumRateSlices?: number;
  readonly maximumWeightIterations?: number;
  readonly minimumTreeOccupancy?: number;
  readonly searchMode?: "rapid" | "backward" | "fixed";
  readonly maximumStates?: number;
  readonly beamWidth?: number;
  readonly selectedIndexes?: readonly number[];
  readonly minimumRunLength?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: FsartProgressDetail) => void;
}

export interface StepwisePartitionOptions {
  readonly criterion?: InformationCriterion;
  readonly minimumSegmentLength?: number;
  readonly maximumBreakpoints?: number;
  readonly maximumCandidates?: number;
  readonly taxa: number;
  readonly sites: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail: FsartProgressDetail) => void;
}

export type SegmentEvaluator = (start: number, end: number) => Promise<SegmentLikelihood>;
