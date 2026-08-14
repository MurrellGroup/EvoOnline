import { FLU_DEMO_GTR } from "./codon.js";
import { DEFAULT_TREE_CONFIG } from "./curves.js";
import type { CurveSpec, MarginalDistribution, SimulatorConfig } from "./types.js";

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  seed: 20260814,
  simulateAlignment: true,
  tree: DEFAULT_TREE_CONFIG,
  codon: {
    engine: "mg94",
    sites: 300,
    geneticCodeId: 1,
    gtr: FLU_DEMO_GTR,
    alpha: { kind: "gamma", mean: 1, shape: 2 },
    omega: { kind: "gamma", mean: 0.55, shape: 0.8 },
  },
  recombination: {
    enabled: false,
    eventRate: 0.004,
    mode: "single-tract",
    meanBreakpoints: 2,
    meanTractCodons: 75,
    hotspotMode: "none",
    hotspotCount: 3,
    hotspotWidth: 12,
    hotspotIntensity: 8,
    manualHotspots: [],
    carrierOversample: 2.5,
  },
};

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value: unknown, fallback: number, minimum = 1e-8): number {
  return Math.max(minimum, finite(value, fallback));
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(finite(value, fallback))));
}

function marginal(value: unknown, fallback: MarginalDistribution): MarginalDistribution {
  const candidate = value as Partial<MarginalDistribution> | undefined;
  const mean = Math.max(0, finite(candidate?.mean, fallback.mean));
  if (candidate?.kind === "gamma") return { kind: "gamma", mean, shape: positive(candidate.shape, fallback.kind === "gamma" ? fallback.shape : 1, 0.03) };
  return { kind: "fixed", mean };
}

function curve(value: unknown, fallback: CurveSpec, horizon: number, positiveValues: boolean): CurveSpec {
  const candidate = value as Partial<CurveSpec> | undefined;
  const raw = Array.isArray(candidate?.points) ? candidate.points : fallback.points;
  const points = raw
    .map((point) => point as { time?: unknown; value?: unknown })
    .map((point) => ({ time: Math.max(0, Math.min(horizon, finite(point.time, 0))), value: positiveValues ? positive(point.value, 1) : Math.max(0, finite(point.value, 0)) }))
    .sort((left, right) => left.time - right.time);
  if (points.length < 2) return fallback;
  points[0] = { ...points[0]!, time: 0 };
  points[points.length - 1] = { ...points[points.length - 1]!, time: horizon };
  return { space: candidate?.space === "linear" ? "linear" : "log", points };
}

/** Parse persisted/UI JSON defensively so old browser snapshots remain usable. */
export function normalizeSimulatorConfig(input: unknown): SimulatorConfig {
  const value = input as Partial<SimulatorConfig> | undefined;
  const treeInput = value?.tree as Partial<SimulatorConfig["tree"]> | undefined;
  const horizon = positive(treeInput?.horizon, DEFAULT_SIMULATOR_CONFIG.tree.horizon, 0.1);
  const observedTips = integer(treeInput?.observedTips, DEFAULT_SIMULATOR_CONFIG.tree.observedTips, 2, 2000);
  const tree = {
    ...DEFAULT_SIMULATOR_CONFIG.tree,
    ...treeInput,
    observedTips,
    initialTips: integer(treeInput?.initialTips, DEFAULT_SIMULATOR_CONFIG.tree.initialTips, 1, observedTips),
    replicates: integer(treeInput?.replicates, DEFAULT_SIMULATOR_CONFIG.tree.replicates, 1, 100),
    ploidy: treeInput?.ploidy === 2 ? 2 as const : 1 as const,
    horizon,
    branchScale: positive(treeInput?.branchScale, DEFAULT_SIMULATOR_CONFIG.tree.branchScale, 1e-7),
    hazardBins: integer(treeInput?.hazardBins, DEFAULT_SIMULATOR_CONFIG.tree.hazardBins, 256, 32768),
    population: curve(treeInput?.population, DEFAULT_SIMULATOR_CONFIG.tree.population, horizon, true),
    sampling: curve(treeInput?.sampling, DEFAULT_SIMULATOR_CONFIG.tree.sampling, horizon, false),
  };
  const codonInput = value?.codon as Partial<SimulatorConfig["codon"]> | undefined;
  const gtrInput = codonInput?.gtr as Partial<SimulatorConfig["codon"]["gtr"]> | undefined;
  const gtr = {
    ...FLU_DEMO_GTR,
    ...gtrInput,
    exchangeabilities: (Array.isArray(gtrInput?.exchangeabilities) && gtrInput.exchangeabilities.length === 6
      ? gtrInput.exchangeabilities.map((entry) => positive(entry, 1))
      : FLU_DEMO_GTR.exchangeabilities) as [number, number, number, number, number, number],
    f3x4: Array.isArray(gtrInput?.f3x4) && gtrInput.f3x4.length === 12
      ? gtrInput.f3x4.map((entry) => positive(entry, 0.25))
      : FLU_DEMO_GTR.f3x4,
  };
  const sites = integer(codonInput?.sites, DEFAULT_SIMULATOR_CONFIG.codon.sites, 1, 10000);
  const geneticCodeId = integer(codonInput?.geneticCodeId, 1, 1, 33) as SimulatorConfig["codon"]["geneticCodeId"];
  const alpha = marginal(codonInput?.alpha, DEFAULT_SIMULATOR_CONFIG.codon.alpha);
  const codon = codonInput?.engine === "scuff" ? {
    engine: "scuff" as const,
    sites,
    geneticCodeId,
    gtr,
    alpha,
    eventRate: marginal(codonInput.eventRate, { kind: "gamma", mean: 12, shape: 3 }),
    equilibriumSigma: marginal(codonInput.equilibriumSigma, { kind: "gamma", mean: 2.2, shape: 8 }),
    mixingRate: marginal(codonInput.mixingRate, { kind: "gamma", mean: 1, shape: 3 }),
    burninTime: Math.max(0, finite(codonInput.burninTime, 3)),
    diagnosticTime: positive(codonInput.diagnosticTime, 4, 0.01),
  } : {
    engine: "mg94" as const,
    sites,
    geneticCodeId,
    gtr,
    alpha,
    omega: marginal(codonInput?.engine === "mg94" ? codonInput.omega : undefined, { kind: "gamma", mean: 0.55, shape: 0.8 }),
  };
  const recombinationInput = value?.recombination as Partial<SimulatorConfig["recombination"]> | undefined;
  const recombination = {
    ...DEFAULT_SIMULATOR_CONFIG.recombination,
    ...recombinationInput,
    enabled: Boolean(recombinationInput?.enabled),
    eventRate: Math.max(0, finite(recombinationInput?.eventRate, DEFAULT_SIMULATOR_CONFIG.recombination.eventRate)),
    meanBreakpoints: positive(recombinationInput?.meanBreakpoints, 2),
    meanTractCodons: positive(recombinationInput?.meanTractCodons, 75),
    hotspotCount: integer(recombinationInput?.hotspotCount, 3, 0, 100),
    hotspotWidth: positive(recombinationInput?.hotspotWidth, 12),
    hotspotIntensity: Math.max(0, finite(recombinationInput?.hotspotIntensity, 8)),
    manualHotspots: Array.isArray(recombinationInput?.manualHotspots) ? recombinationInput.manualHotspots.map((entry) => Math.round(finite(entry, 1))) : [],
    carrierOversample: Math.max(1, Math.min(20, finite(recombinationInput?.carrierOversample, 2.5))),
  };
  return {
    seed: integer(value?.seed, DEFAULT_SIMULATOR_CONFIG.seed, -2147483648, 2147483647),
    simulateAlignment: value?.simulateAlignment !== false,
    tree,
    codon,
    recombination,
  };
}

export function encodeSimulatorConfig(config: SimulatorConfig): string {
  return JSON.stringify(config);
}

export function decodeSimulatorConfig(value: unknown): SimulatorConfig {
  if (typeof value !== "string") return normalizeSimulatorConfig(value);
  try { return normalizeSimulatorConfig(JSON.parse(value)); }
  catch { return DEFAULT_SIMULATOR_CONFIG; }
}
