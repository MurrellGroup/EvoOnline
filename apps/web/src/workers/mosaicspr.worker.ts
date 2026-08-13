/// <reference lib="webworker" />
import {
  parseMosaicSprFasta,
  proposeMosaicSprBreakpoints,
  reconstructSprHistory,
  type MosaicSprBreakpointProposal,
  type MosaicSprProposalDiagnostics,
  type SprReconstructionResult,
} from "@phylo-workbench/model-mosaicspr/browser-source";

export interface MosaicSprProposalWorkerRequest {
  readonly type: "proposals";
  readonly id: string;
  readonly alignment: string;
  readonly options: {
    readonly enabled: boolean;
    readonly window: number;
    readonly maximumTriplets: number;
    readonly maximumSignals: number;
    readonly maximumReportedSignals: number;
    readonly maximumBreakpoints: number;
    readonly minimumSegmentLength: number;
  };
}

export interface MosaicSprReconstructionWorkerRequest {
  readonly type: "reconstruct";
  readonly id: string;
  readonly alignment: string;
  readonly trees: readonly string[];
  readonly options: {
    readonly minimumRunLength: number;
    readonly maximumStates: number;
    readonly maximumIterations: number;
    readonly beamWidth: number;
    readonly parsimonyScreenLimit: number;
    readonly maximumStarts: number;
    readonly patience: number;
    readonly breakpointPenalty?: number;
    readonly sprPenalty?: number;
    readonly masterPenalty?: number;
  };
}

export type MosaicSprWorkerRequest = MosaicSprProposalWorkerRequest | MosaicSprReconstructionWorkerRequest;
export type MosaicSprWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail: { readonly message: string; readonly current?: number; readonly total?: number; readonly metricLabel?: string; readonly metricValue?: number; readonly indeterminate?: boolean } }
  | { readonly type: "proposals-result"; readonly id: string; readonly proposals: readonly MosaicSprBreakpointProposal[]; readonly diagnostics: MosaicSprProposalDiagnostics; readonly taxa: number; readonly sites: number; readonly variableSites: number }
  | { readonly type: "reconstruction-result"; readonly id: string; readonly result: SprReconstructionResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

const scope = self as DedicatedWorkerGlobalScope;
let cachedText = "";
let cachedAlignment: ReturnType<typeof parseMosaicSprFasta> | undefined;

function alignmentFor(text: string): ReturnType<typeof parseMosaicSprFasta> {
  if (cachedAlignment === undefined || cachedText !== text) {
    cachedText = text;
    cachedAlignment = parseMosaicSprFasta(text);
  }
  return cachedAlignment;
}

scope.onmessage = (event: MessageEvent<MosaicSprWorkerRequest>): void => {
  const request = event.data;
  try {
    const alignment = alignmentFor(request.alignment);
    if (request.type === "proposals") {
      const result = proposeMosaicSprBreakpoints(alignment, {
        ...request.options,
        onProgress: (fraction, detail) => {
          const message: MosaicSprWorkerResponse = { type: "progress", id: request.id, stage: "mosaicspr-proposals", fraction, detail };
          scope.postMessage(message);
        },
      });
      const response: MosaicSprWorkerResponse = {
        type: "proposals-result",
        id: request.id,
        proposals: result.proposals,
        diagnostics: result.diagnostics,
        taxa: alignment.taxa,
        sites: alignment.sites,
        variableSites: alignment.variableSites.length,
      };
      scope.postMessage(response);
      return;
    }
    const result = reconstructSprHistory(alignment, request.trees, {
      ...request.options,
      onProgress: (fraction, detail) => {
        const message: MosaicSprWorkerResponse = { type: "progress", id: request.id, stage: "mosaicspr-search", fraction, detail };
        scope.postMessage(message);
      },
    });
    const response: MosaicSprWorkerResponse = { type: "reconstruction-result", id: request.id, result };
    scope.postMessage(response);
  } catch (error) {
    const response: MosaicSprWorkerResponse = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
    scope.postMessage(response);
  }
};
