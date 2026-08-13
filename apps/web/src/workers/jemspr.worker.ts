/// <reference lib="webworker" />
import { analyzeJemspr, type JemsprAnalysisResult, type JemsprOptions, type JemsprProgressDetail } from "@phylo-workbench/model-jemspr/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";

export interface JemsprWorkerRequest {
  readonly type: "run";
  readonly id: string;
  readonly alignment: string;
  readonly parameters: ParameterValues;
}

export type JemsprWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: JemsprProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: JemsprAnalysisResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

const scope = self as DedicatedWorkerGlobalScope;
const numberValue = (parameters: ParameterValues, key: string, fallback: number): number => {
  const value = Number(parameters[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};

scope.onmessage = (event: MessageEvent<JemsprWorkerRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const p = request.parameters;
      const options: JemsprOptions = {
        scoreMethod: p.scoreMethod === "sankoff" ? "sankoff" : "fitch",
        transitionCost: numberValue(p, "transitionCost", 0.5),
        transversionCost: numberValue(p, "transversionCost", 1),
        minimumWindow: numberValue(p, "minimumWindow", 120),
        maximumDyadicTrees: numberValue(p, "maximumDyadicTrees", 16),
        rootPlacements: numberValue(p, "rootPlacements", 3),
        maximumGraphStates: numberValue(p, "maximumGraphStates", 36),
        maximumGraphIterations: numberValue(p, "maximumGraphIterations", 10),
        neighbourScreen: numberValue(p, "neighbourScreen", 72),
        frontierStates: numberValue(p, "frontierStates", 4),
        nearImprovers: numberValue(p, "nearImprovers", 2),
        pathBreakpointPenalty: numberValue(p, "pathBreakpointPenalty", 0),
        pathEndpointPenalty: numberValue(p, "pathEndpointPenalty", 0),
        pathSpanPenalty: numberValue(p, "pathSpanPenalty", 0),
        maximumReticulations: numberValue(p, "maximumReticulations", 5),
        overlapCap: numberValue(p, "overlapCap", 2),
        networkBeamWidth: numberValue(p, "networkBeamWidth", 6),
        eventPoolSize: numberValue(p, "eventPoolSize", 14),
        eventOpenPenalty: numberValue(p, "eventOpenPenalty", 4),
        eventClosePenalty: numberValue(p, "eventClosePenalty", 0),
        networkBreakpointPenalty: numberValue(p, "networkBreakpointPenalty", 4),
        eventSpanPenalty: numberValue(p, "eventSpanPenalty", 0.004),
        reticulationPenalty: numberValue(p, "reticulationPenalty", 3),
        boundaryConvention: p.boundaryConvention === "closed" || p.boundaryConvention === "penalized-open" ? p.boundaryConvention : "open",
        boundaryCensorPenalty: numberValue(p, "boundaryCensorPenalty", 2),
        uncertaintyTolerance: numberValue(p, "uncertaintyTolerance", 2),
        onProgress: (stage, fraction, detail) => {
          const response: JemsprWorkerResponse = { type: "progress", id: request.id, stage, fraction, ...(detail === undefined ? {} : { detail }) };
          scope.postMessage(response);
        },
      };
      const result = await analyzeJemspr(request.alignment, options);
      const response: JemsprWorkerResponse = { type: "result", id: request.id, result };
      scope.postMessage(response);
    } catch (error) {
      const response: JemsprWorkerResponse = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
      scope.postMessage(response);
    }
  })();
};
