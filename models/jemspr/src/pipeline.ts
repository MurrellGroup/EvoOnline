import { parseJemsprFasta } from "./alignment.js";
import { jemsprBreakpointsTsv, jemsprEventsCsv, jemsprLocalTreesTsv } from "./csv.js";
import { searchSwitchingNetwork } from "./network-search.js";
import { searchRootedTreePath } from "./path-search.js";
import type { JemsprAnalysisResult, JemsprOptions } from "./types.js";

export async function analyzeJemspr(alignmentText: string, options: JemsprOptions = {}): Promise<JemsprAnalysisResult> {
  const started = performance.now();
  options.onProgress?.("jemspr-initialization", 0.05, { message: "Parsing nucleotide states and identifying safe genomic scoring cells." });
  const alignment = parseJemsprFasta(alignmentText);
  if (alignment.informativePositions.length === 0) options.onProgress?.("jemspr-initialization", 1, { message: "No variable nucleotide sites; returning the inferred master without recombination events." });
  else options.onProgress?.("jemspr-initialization", 1, { message: `${alignment.informativePositions.length.toLocaleString()} variable sites retained in genomic order.`, current: alignment.informativePositions.length, total: alignment.sites });

  const pathStarted = performance.now();
  options.onProgress?.("jemspr-seed-trees", 0.02, { message: "Inferring whole-alignment and data-independent dyadic-window NJ seeds internally." });
  const path = searchRootedTreePath(alignment, options);
  const pathMs = performance.now() - pathStarted;

  const networkStarted = performance.now();
  options.onProgress?.("jemspr-network-search", 0.01, { message: "Compiling residual rooted-SPR moves into verified switching DAGs." });
  const network = searchSwitchingNetwork(alignment, path, options);
  const networkMs = performance.now() - networkStarted;

  const warnings: string[] = [];
  if (path.resourceLimited) warnings.push("The rooted-tree graph or root-placement universe was budget limited; increase advanced search budgets to test stability.");
  if (network.public.maximumOverlapUsed === network.public.overlapCap && network.public.templates.length > network.public.overlapCap) warnings.push("The selected history touches the overlap cap; rerun with a larger cap to test whether the optimum changes.");
  if (network.public.temporal.status !== "rank-feasible") warnings.push(network.public.temporal.message);
  if (alignment.informativePositions.length < Math.max(20, alignment.taxa * 2)) warnings.push("The alignment contains few variable sites relative to the number of taxa; local topologies and event boundaries may be weakly identified.");

  const resultBase = {
    method: "jemspr" as const,
    schemaVersion: 1 as const,
    taxa: alignment.taxa,
    sites: alignment.sites,
    informativeSites: alignment.informativePositions.length,
    path: path.public,
    network: network.public,
    diagnostics: {
      engine: "independent-typescript-worker" as const,
      initialTreeMethod: "internal-neighbor-joining-multiscale" as const,
      scoreMethod: options.scoreMethod ?? "fitch",
      transitionCost: Math.max(0, options.transitionCost ?? 1),
      transversionCost: Math.max(0, options.transversionCost ?? 1),
      informativeSites: alignment.informativePositions.length,
      dyadicSeeds: path.seedCount,
      rootPlacements: path.rootPlacementCount,
      candidateEventTemplates: network.candidateTemplates,
      graphStates: path.graph.states.length,
      graphEdges: path.graph.adjacency.reduce((sum, edges) => sum + edges.length, 0) / 2,
      pathNetworkObjectiveDifference: network.public.objective - path.public.objective,
      resourceLimited: path.resourceLimited,
      warnings,
    },
    timings: {
      pathSearchMs: pathMs,
      networkSearchMs: networkMs,
      totalMs: performance.now() - started,
    },
  };
  const provisional = { ...resultBase, eventsCsv: "", localTreesTsv: "", breakpointsTsv: "", networkJson: "" } satisfies JemsprAnalysisResult;
  const result: JemsprAnalysisResult = {
    ...resultBase,
    eventsCsv: jemsprEventsCsv(provisional),
    localTreesTsv: jemsprLocalTreesTsv(provisional),
    breakpointsTsv: jemsprBreakpointsTsv(provisional),
    networkJson: JSON.stringify({ schemaVersion: 1, method: "jemspr", taxaNames: alignment.names, switchingNetwork: network.serializableNetwork, masterTree: network.public.masterTree, templates: network.public.templates, occurrences: network.public.occurrences, maskRuns: network.public.runs, temporal: network.public.temporal, diagnostics: resultBase.diagnostics }, null, 2),
  };
  options.onProgress?.("complete", 1, { message: `JEMSPR completed with ${result.network.templates.length} reticulation template${result.network.templates.length === 1 ? "" : "s"} and ${result.network.occurrences.length} event occurrence${result.network.occurrences.length === 1 ? "" : "s"}.` });
  return result;
}
