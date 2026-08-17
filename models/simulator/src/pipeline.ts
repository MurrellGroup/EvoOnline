import { alignmentDiagnostics, scuffDiagnostic, simulateCodonAlignment, writeFasta } from "./codon.js";
import { simulateCoalescentTree, sampleObservedTips } from "./coalescent.js";
import { normalizeSimulatorConfig } from "./config.js";
import { simulateRecombination } from "./recombination.js";
import { Random } from "./random.js";
import type { SimulatedDataset, SimulatorAnalysisResult, SimulatorConfig, SimulatorOptions, TreeSimulationConfig } from "./types.js";

function replicateSeed(seed: number, replicate: number): number {
  let value = (seed ^ Math.imul(replicate + 1, 0x9e3779b1)) | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value | 0;
}

function carrierTreeConfig(config: SimulatorConfig, carrierTips: number): TreeSimulationConfig {
  if (carrierTips === config.tree.observedTips) return config.tree;
  const ratio = carrierTips / config.tree.observedTips;
  const initialTips = config.tree.initialTips === config.tree.observedTips
    ? carrierTips
    : Math.max(1, Math.min(carrierTips, Math.round(config.tree.initialTips * ratio)));
  // A larger latent carrier sample represents denser observation of the same
  // epidemic interval, not an invitation to extend the genealogy arbitrarily
  // far into the constant-rate tail.
  return { ...config.tree, observedTips: carrierTips, initialTips, sampling: { ...config.tree.sampling, points: config.tree.sampling.points.map((point) => ({ ...point, value: point.value * ratio })) } };
}

function emit(options: SimulatorOptions | undefined, stage: string, fraction: number, message: string, current?: number, total?: number): void {
  options?.onProgress?.(stage, Math.max(0, Math.min(1, fraction)), {
    message,
    ...(current === undefined || total === undefined ? {} : { current, total }),
  });
}

export async function runSimulator(configInput: SimulatorConfig | unknown, options?: SimulatorOptions): Promise<SimulatorAnalysisResult> {
  const started = typeof performance === "undefined" ? Date.now() : performance.now();
  const config = normalizeSimulatorConfig(configInput);
  const datasets: SimulatedDataset[] = [];
  const replicateIndices = options?.replicateIndices ?? Array.from({ length: config.tree.replicates }, (_unused, replicate) => replicate);
  if (replicateIndices.some((replicate) => !Number.isInteger(replicate) || replicate < 0 || replicate >= config.tree.replicates)) {
    throw new RangeError("Simulator replicate indexes must refer to configured zero-based replicates.");
  }
  const carrierTips = config.recombination.enabled
    ? Math.max(config.tree.observedTips, Math.ceil(config.tree.observedTips * config.recombination.carrierOversample))
    : config.tree.observedTips;
  for (let shardIndex = 0; shardIndex < replicateIndices.length; shardIndex += 1) {
    const replicate = replicateIndices[shardIndex]!;
    const ordinal = replicate + 1;
    const rng = new Random(replicateSeed(config.seed, replicate));
    emit(options, "tree-simulation", shardIndex / Math.max(1, replicateIndices.length), `Sampling genealogy ${ordinal} of ${config.tree.replicates}`, shardIndex + 1, replicateIndices.length);
    const carrierTree = simulateCoalescentTree(carrierTreeConfig(config, carrierTips), rng, carrierTips);
    const observed = carrierTips === config.tree.observedTips
      ? { tree: carrierTree, carrierTipIds: carrierTree.tips }
      : sampleObservedTips(carrierTree, config.tree.observedTips, rng);
    const observedNames = new Set(observed.carrierTipIds.map((tip) => carrierTree.nodes[tip]!.name!));
    emit(options, "recombination-simulation", shardIndex / Math.max(1, replicateIndices.length), config.recombination.enabled
      ? `Placing branch-interior recombination events for dataset ${ordinal}`
      : `Preparing local genealogy for dataset ${ordinal}`, ordinal, config.tree.replicates);
    const recombination = simulateRecombination(carrierTree, observedNames, config.codon.sites, config.recombination, rng);
    let alignment: ReturnType<typeof simulateCodonAlignment> | undefined;
    if (config.simulateAlignment) {
      const reportEvery = Math.max(1, Math.ceil(config.codon.sites / 200));
      alignment = simulateCodonAlignment(recombination.localTrees, config.codon, rng, (site, total) => {
        if (site !== total && site % reportEvery !== 0) return;
        const overall = (shardIndex + site / total) / Math.max(1, replicateIndices.length);
        emit(options, "sequence-simulation", overall, `${config.codon.engine === "scuff" ? "SCUFF" : "MG94"} codon ${site.toLocaleString()} of ${total.toLocaleString()} · dataset ${ordinal} of ${config.tree.replicates}`, site, total);
      });
    }
    const sequenceDiagnostics = alignment === undefined ? {} : alignmentDiagnostics(alignment.sequences, config.codon.geneticCodeId);
    datasets.push({
      id: `sim-${Math.abs(config.seed)}-${ordinal}`,
      seed: replicateSeed(config.seed, replicate),
      tree: observed.tree,
      ...(carrierTree === observed.tree ? {} : { carrierTree }),
      localTrees: recombination.localTrees,
      recombinationEvents: recombination.events,
      hotspotWeights: recombination.hotspotWeights,
      names: alignment?.names ?? observed.tree.tips.map((tip) => observed.tree.nodes[tip]!.name!).sort(),
      ...(alignment === undefined ? {} : {
        sequences: alignment.sequences,
        fasta: writeFasta(alignment.names, alignment.sequences),
        siteParameters: alignment.siteParameters,
      }),
      diagnostics: {
        treeHeight: observed.tree.height,
        totalTreeLength: observed.tree.totalTimeLength,
        carrierTips,
        observedTips: config.tree.observedTips,
        recombinationEvents: recombination.events.filter((event) => event.visibleAfterSubsampling).length,
        localTrees: recombination.localTrees.length,
        ...sequenceDiagnostics,
      },
    });
    // Give the worker event loop a chance to publish progress between datasets.
    await Promise.resolve();
  }
  const diagnostic = config.codon.engine === "scuff" && options?.includeDiagnostic !== false
    ? (() => {
        emit(options, "scuff-diagnostics", 0.01, "Propagating SCUFF codon frequencies and expected dN/dS");
        return scuffDiagnostic(config.codon, new Random(replicateSeed(config.seed, config.tree.replicates + 1)), (completed, total) => emit(options, "scuff-diagnostics", completed / total, `SCUFF diagnostic time slice ${completed} of ${total}`, completed, total));
      })()
    : undefined;
  emit(options, "complete", 1, `${datasets.length} simulated dataset${datasets.length === 1 ? "" : "s"} ready`, datasets.length, datasets.length);
  const ended = typeof performance === "undefined" ? Date.now() : performance.now();
  return {
    method: "simulator",
    config,
    datasets,
    ...(diagnostic === undefined ? {} : { scuffDiagnostic: diagnostic }),
    elapsedMs: ended - started,
    diagnostics: {
      coalescentHazard: "integrated-competing-risks",
      coalescentRateConvention: "choose(k,2)/(ploidy*Ne(t))",
      samplingProcess: "inhomogeneous-poisson",
      curveInterpolation: "shape-preserving-cubic",
      sequenceSampler: "exact-gillespie",
      recombinationSampler: "branch-interior-time-aware-spr",
    },
  };
}
