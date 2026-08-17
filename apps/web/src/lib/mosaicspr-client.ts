import {
  isFullyResolvedTopology,
  canonicalTopologySignature,
  type SegmentLikelihood,
} from "@phylo-workbench/model-fsart/browser-source";
import {
  mosaicSprEventsToCsv,
  mosaicSprTreeWindows,
  type MosaicSprAnalysisResult,
  type MosaicSprBreakpointProposal,
  type MosaicSprDraftTree,
  type MosaicSprProposalDiagnostics,
  type SprReconstructionResult,
} from "@phylo-workbench/model-mosaicspr/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import type { MosaicSprWorkerRequest, MosaicSprWorkerResponse } from "../workers/mosaicspr.worker.js";
import type { RunProgress } from "./diffubar-client.js";

interface FastTreeScore extends SegmentLikelihood {
  readonly version: string;
}

interface ProposalEnvelope {
  readonly proposals: readonly MosaicSprBreakpointProposal[];
  readonly diagnostics: MosaicSprProposalDiagnostics;
  readonly taxa: number;
  readonly sites: number;
  readonly variableSites: number;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("Analysis cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function optionalPenalty(value: unknown): number | undefined {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class MosaicSprClient {
  private worker: Worker | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly getAlignmentBridge: () => WidgetBridge | undefined) {}

  private createWorker(): Worker {
    return new Worker(new URL("../workers/mosaicspr.worker.ts", import.meta.url), { type: "module" });
  }

  async run(alignment: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<MosaicSprAnalysisResult> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const worker = this.createWorker();
    this.worker = worker;
    const started = performance.now();
    try {
      const proposalStarted = performance.now();
      const proposal = await this.propose(worker, alignment, parameters, onProgress, abort.signal);
      const proposalMs = performance.now() - proposalStarted;
      const bridge = this.getAlignmentBridge();
      if (bridge === undefined) throw new Error("MosaicSPR requires the shared alignment-viewer FastTree bridge, but it is not available.");
      onProgress({ stage: "fasttree-runtime", fraction: 0, message: "Loading or compiling the shared FastTree 2.1.11 bioWASM runtime", indeterminate: true });
      await raceAbort(bridge.waitUntilReady(120_000), abort.signal);

      const windows = mosaicSprTreeWindows(proposal.proposals, proposal.sites, proposal.diagnostics.minimumTreeSpan, true);
      if (windows.length === 0) throw new Error("No topology-training windows are long enough for this alignment.");
      const fitStarted = performance.now();
      let version: string | undefined;
      let sharedGtr: Pick<SegmentLikelihood, "gtrFrequencies" | "gtrRates"> | undefined;
      const draftTrees: MosaicSprDraftTree[] = [];
      const unsubscribe = bridge.onEvent((message) => {
        if (message.type !== "status") return;
        const payload = message.payload as { message?: string } | undefined;
        onProgress({ stage: "mosaicspr-tree-family", fraction: draftTrees.length / windows.length, message: payload?.message ?? "FastTree proposal fit active", indeterminate: true });
      });
      try {
        for (let index = 0; index < windows.length; index += 1) {
          abort.signal.throwIfAborted();
          const window = windows[index]!;
          onProgress({
            stage: "mosaicspr-tree-family",
            fraction: index / windows.length,
            message: `FastTree seed ${index + 1}/${windows.length} · ${window.kind} ${window.start}–${window.end}`,
            current: index,
            total: windows.length,
          });
          const score = await raceAbort(bridge.request<FastTreeScore>("score-fasttree-segment", {
            alignment,
            start: window.start,
            end: window.end,
            fastest: Boolean(parameters.fastTreeFastest ?? true),
            ...(sharedGtr?.gtrFrequencies === undefined ? {} : { gtrFrequencies: sharedGtr.gtrFrequencies }),
            ...(sharedGtr?.gtrRates === undefined ? {} : { gtrRates: sharedGtr.gtrRates }),
          }, 15 * 60_000), abort.signal);
          version = score.version;
          if (window.start === 1 && window.end === proposal.sites && score.gtrFrequencies !== undefined && score.gtrRates !== undefined) {
            sharedGtr = { gtrFrequencies: score.gtrFrequencies, gtrRates: score.gtrRates };
          }
          if (!isFullyResolvedTopology(score.tree)) continue;
          draftTrees.push({
            id: window.id,
            kind: window.kind,
            start: window.start,
            end: window.end,
            tree: score.tree,
            logLikelihood: score.logLikelihood,
            elapsedMs: score.elapsedMs,
            topologySignature: canonicalTopologySignature(score.tree),
          });
        }
      } finally {
        unsubscribe();
      }
      if (draftTrees.length === 0) throw new Error("FastTree produced no fully resolved labelled topology to seed MosaicSPR.");
      onProgress({ stage: "mosaicspr-tree-family", fraction: 1, message: `${draftTrees.length} resolved seed trees fitted; proposals remain non-binding`, current: draftTrees.length, total: draftTrees.length });
      const fastTreeMs = performance.now() - fitStarted;

      const searchStarted = performance.now();
      const reconstruction = await this.reconstruct(worker, alignment, draftTrees.map((draft) => draft.tree), parameters, proposal.diagnostics.minimumTreeSpan, onProgress, abort.signal);
      const searchMs = performance.now() - searchStarted;
      const base: Omit<MosaicSprAnalysisResult, "eventCsv"> = {
        method: "mosaic-spr",
        taxa: proposal.taxa,
        sites: proposal.sites,
        variableSites: proposal.variableSites,
        proposals: proposal.proposals,
        proposalDiagnostics: proposal.diagnostics,
        draftTrees,
        reconstruction,
        ...(version === undefined ? {} : { fastTreeVersion: version }),
        timings: { proposalMs, fastTreeMs, searchMs, totalMs: performance.now() - started },
      };
      const result: MosaicSprAnalysisResult = { ...base, eventCsv: mosaicSprEventsToCsv(base) };
      onProgress({ stage: "complete", fraction: 1, message: `MosaicSPR inferred ${reconstruction.runs.length} genomic runs and ${reconstruction.events.length} explicit breakpoint events` });
      return result;
    } finally {
      if (this.worker === worker) this.worker = undefined;
      worker.terminate();
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private propose(worker: Worker, alignment: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void, signal: AbortSignal): Promise<ProposalEnvelope> {
    const id = crypto.randomUUID();
    return raceAbort(new Promise<ProposalEnvelope>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<MosaicSprWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...message.detail });
        else if (message.type === "proposals-result") resolve(message);
        else if (message.type === "error") reject(new Error(message.error));
      };
      worker.onerror = (event) => reject(new Error(event.message || "MosaicSPR proposal worker failed."));
      const request: MosaicSprWorkerRequest = {
        type: "proposals",
        id,
        alignment,
        options: {
          enabled: Boolean(parameters.useBreakpointProposals ?? true),
          window: Number(parameters.window ?? 24),
          maximumTriplets: Number(parameters.maximumTriplets ?? 250_000),
          maximumSignals: Number(parameters.maximumSignals ?? 1024),
          maximumReportedSignals: Number(parameters.maximumReportedSignals ?? 256),
          maximumBreakpoints: Number(parameters.maximumConsensusBreakpoints ?? 14),
          minimumSegmentLength: Number(parameters.minimumSegmentLength ?? 150),
        },
      };
      worker.postMessage(request);
    }), signal);
  }

  private reconstruct(worker: Worker, alignment: string, trees: readonly string[], parameters: ParameterValues, minimumRunLength: number, onProgress: (progress: RunProgress) => void, signal: AbortSignal): Promise<SprReconstructionResult> {
    const id = crypto.randomUUID();
    return raceAbort(new Promise<SprReconstructionResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<MosaicSprWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...message.detail });
        else if (message.type === "reconstruction-result") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.error));
      };
      worker.onerror = (event) => reject(new Error(event.message || "MosaicSPR reconstruction worker failed."));
      const breakpointPenalty = optionalPenalty(parameters.sprBreakpointPenalty);
      const sprPenalty = optionalPenalty(parameters.sprMovePenalty);
      const masterPenalty = optionalPenalty(parameters.sprMasterPenalty);
      const request: MosaicSprWorkerRequest = {
        type: "reconstruct",
        id,
        alignment,
        trees,
        options: {
          minimumRunLength,
          maximumStates: Number(parameters.maximumSprStates ?? 48),
          maximumIterations: Number(parameters.maximumSprIterations ?? 12),
          beamWidth: Number(parameters.sprBeamWidth ?? 4),
          parsimonyScreenLimit: Number(parameters.sprParsimonyScreenLimit ?? 96),
          maximumStarts: Number(parameters.maximumSprStarts ?? 3),
          patience: Number(parameters.sprSearchPatience ?? 5),
          ...(breakpointPenalty === undefined ? {} : { breakpointPenalty }),
          ...(sprPenalty === undefined ? {} : { sprPenalty }),
          ...(masterPenalty === undefined ? {} : { masterPenalty }),
        },
      };
      worker.postMessage(request);
    }), signal);
  }

  cancel(): void {
    this.abort?.abort(new DOMException("Analysis cancelled.", "AbortError"));
    this.worker?.terminate();
    this.worker = undefined;
    this.abort = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}
