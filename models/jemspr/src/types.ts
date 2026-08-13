export interface JemsprProgressDetail {
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
  readonly metricLabel?: string;
  readonly metricValue?: number;
  readonly indeterminate?: boolean;
}

export interface JemsprAlignment {
  readonly names: readonly string[];
  readonly taxa: number;
  readonly sites: number;
  /** Site-major IUPAC state masks; zero means missing. */
  readonly masks: Uint8Array;
  readonly informativePositions: Uint32Array;
  readonly cellStarts: Uint32Array;
  readonly cellEnds: Uint32Array;
}

export interface JemsprSprMove {
  readonly prunedTaxa: readonly string[];
  readonly sourceSiblingTaxa: readonly string[];
  readonly destinationTaxa: readonly string[];
  readonly destinationIsRoot: boolean;
}

export interface JemsprTreeState {
  readonly id: string;
  readonly signature: string;
  readonly tree: string;
  readonly totalParsimony: number;
  readonly occupiedSpan: number;
  readonly masterDistance: number;
  readonly color: string;
}

export interface JemsprPathRun {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly stateId: string;
  readonly stateIndex: number;
  readonly dataParsimony: number;
}

export interface JemsprPathBreakpoint {
  readonly afterSite: number;
  readonly intervalLow: number;
  readonly intervalHigh: number;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly graphDistance: number;
  readonly edits: readonly JemsprSprMove[];
  readonly minMarginalGap: number;
}

export interface JemsprPathIteration {
  readonly start: number;
  readonly iteration: number;
  readonly graphStates: number;
  readonly graphEdges: number;
  readonly occupiedStates: number;
  readonly mastersEvaluated: number;
  readonly neighboursEnumerated: number;
  readonly neighboursPriced: number;
  readonly statesAdded: number;
  readonly objective: number;
  readonly masterStateId: string;
  readonly bestOmittedIntervalGain: number;
  readonly elapsedMs: number;
}

export interface JemsprPathResult {
  readonly objective: number;
  readonly dataParsimony: number;
  readonly masterStateId: string;
  readonly states: readonly JemsprTreeState[];
  readonly runs: readonly JemsprPathRun[];
  readonly breakpoints: readonly JemsprPathBreakpoint[];
  readonly iterations: readonly JemsprPathIteration[];
  readonly lowerBoundKind: "adaptive-restricted-rspr-graph";
  readonly certificate: string;
}

export interface JemsprEventTemplate {
  readonly id: string;
  readonly bit: number;
  readonly move: JemsprSprMove;
  readonly sourceContexts: readonly string[];
  readonly topologicallySilentMasks: readonly number[];
  readonly reticulationNode: string;
  readonly backgroundParentNode: string;
  readonly alternateParentNode: string;
  readonly recipientChildNode: string;
  readonly donorChildNode: string;
}

export interface JemsprEventOccurrence {
  readonly id: string;
  readonly templateId: string;
  readonly start: number;
  readonly end: number;
  readonly leftCensored: boolean;
  readonly rightCensored: boolean;
  readonly maximumConcurrentEvents: number;
  readonly openingGap: number;
  readonly closingGap: number;
  readonly openingIntervalLow: number;
  readonly openingIntervalHigh: number;
  readonly closingIntervalLow: number;
  readonly closingIntervalHigh: number;
}

export interface JemsprMaskRun {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly mask: number;
  readonly activeTemplateIds: readonly string[];
  readonly treeId: string;
  readonly treeIndex: number;
  readonly dataParsimony: number;
}

export interface JemsprNetworkTree {
  readonly id: string;
  readonly signature: string;
  readonly tree: string;
  readonly masks: readonly number[];
  readonly occupiedSpan: number;
  readonly color: string;
}

export interface JemsprNetworkSearchStep {
  readonly reticulations: number;
  readonly candidatesScored: number;
  /** Compiled candidates removed by the donor-time/strict-ancestry lazy cut. */
  readonly temporallyRejected: number;
  readonly beamRetained: number;
  readonly bestObjective: number;
  readonly bestDataParsimony: number;
  readonly bestOverlap: number;
  readonly elapsedMs: number;
}

export interface JemsprTemporalCheck {
  readonly status: "rank-feasible" | "infeasible" | "unresolved";
  readonly message: string;
  readonly conflictingTemplates: readonly string[];
}

export interface JemsprNetworkResult {
  readonly status: "complete" | "path-fallback";
  readonly objective: number;
  readonly dataParsimony: number;
  readonly masterTree: string;
  readonly masterStateId: string;
  readonly boundaryConvention: "closed" | "open" | "penalized-open";
  readonly overlapCap: number;
  readonly uncertaintyTolerance: number;
  readonly maximumOverlapUsed: number;
  readonly templates: readonly JemsprEventTemplate[];
  readonly occurrences: readonly JemsprEventOccurrence[];
  readonly trees: readonly JemsprNetworkTree[];
  readonly runs: readonly JemsprMaskRun[];
  readonly breakpointGaps: readonly { readonly afterSite: number; readonly intervalLow: number; readonly intervalHigh: number; readonly gap: number }[];
  readonly search: readonly JemsprNetworkSearchStep[];
  readonly paretoFrontier: readonly {
    readonly reticulations: number;
    readonly occurrences: number;
    readonly dataParsimony: number;
    readonly objective: number;
    readonly maximumOverlap: number;
  }[];
  readonly temporal: JemsprTemporalCheck;
  readonly certificate: string;
}

export interface JemsprDiagnostics {
  readonly engine: "independent-typescript-worker";
  readonly initialTreeMethod: "internal-neighbor-joining-multiscale";
  readonly scoreMethod: "fitch" | "sankoff";
  readonly transitionCost: number;
  readonly transversionCost: number;
  readonly informativeSites: number;
  readonly dyadicSeeds: number;
  readonly rootPlacements: number;
  readonly candidateEventTemplates: number;
  readonly graphStates: number;
  readonly graphEdges: number;
  /** Descriptive difference only: the two layers use different regularizers. */
  readonly pathNetworkObjectiveDifference: number;
  readonly resourceLimited: boolean;
  readonly warnings: readonly string[];
}

export interface JemsprAnalysisResult {
  readonly method: "jemspr";
  readonly schemaVersion: 1;
  readonly taxa: number;
  readonly sites: number;
  readonly informativeSites: number;
  readonly path: JemsprPathResult;
  readonly network: JemsprNetworkResult;
  readonly diagnostics: JemsprDiagnostics;
  readonly timings: Readonly<Record<string, number>>;
  readonly eventsCsv: string;
  readonly localTreesTsv: string;
  readonly breakpointsTsv: string;
  readonly networkJson: string;
}

export interface JemsprOptions {
  readonly scoreMethod?: "fitch" | "sankoff";
  readonly transitionCost?: number;
  readonly transversionCost?: number;
  readonly minimumWindow?: number;
  readonly maximumDyadicTrees?: number;
  readonly rootPlacements?: number;
  readonly maximumGraphStates?: number;
  readonly maximumGraphIterations?: number;
  readonly neighbourScreen?: number;
  readonly frontierStates?: number;
  readonly nearImprovers?: number;
  readonly pathBreakpointPenalty?: number;
  readonly pathEndpointPenalty?: number;
  readonly pathSpanPenalty?: number;
  readonly maximumReticulations?: number;
  readonly overlapCap?: number;
  readonly networkBeamWidth?: number;
  readonly eventPoolSize?: number;
  readonly eventOpenPenalty?: number;
  readonly eventClosePenalty?: number;
  readonly networkBreakpointPenalty?: number;
  readonly eventSpanPenalty?: number;
  readonly reticulationPenalty?: number;
  readonly boundaryConvention?: "closed" | "open" | "penalized-open";
  readonly boundaryCensorPenalty?: number;
  /** Optimization-gap tolerance used for consecutive endpoint ranges. */
  readonly uncertaintyTolerance?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (stage: string, fraction: number, detail?: JemsprProgressDetail) => void;
}
