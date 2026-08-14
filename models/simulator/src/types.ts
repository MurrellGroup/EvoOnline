import type { GeneticCodeId } from "@phylo-workbench/model-diffubar/browser-source";

export type CurveSpace = "linear" | "log";
export interface CurvePoint { readonly time: number; readonly value: number }
export interface CurveSpec {
  readonly points: readonly CurvePoint[];
  readonly space: CurveSpace;
}

export type TreePreset = "constant" | "serial" | "exponential" | "logistic" | "seasonal" | "bottleneck" | "ladder" | "custom";
export interface TreeSimulationConfig {
  readonly preset: TreePreset;
  readonly observedTips: number;
  readonly initialTips: number;
  readonly replicates: number;
  readonly ploidy: 1 | 2;
  /** Backwards-time extent over which the editable curves are defined. */
  readonly horizon: number;
  /** Converts demographic time into expected neutral substitutions per codon. */
  readonly branchScale: number;
  readonly population: CurveSpec;
  readonly sampling: CurveSpec;
  readonly hazardBins: number;
}

export interface SimTreeNode {
  readonly id: number;
  readonly name?: string;
  /** Time before the most recent sampled tip. */
  readonly time: number;
  readonly parent: number | null;
  readonly children: readonly number[];
}

export interface SimulatedTree {
  readonly nodes: readonly SimTreeNode[];
  readonly root: number;
  readonly tips: readonly number[];
  readonly height: number;
  readonly totalTimeLength: number;
  readonly branchScale: number;
  readonly timeNewick: string;
  readonly newick: string;
}

export type MarginalDistribution =
  | { readonly kind: "fixed"; readonly mean: number }
  | { readonly kind: "gamma"; readonly mean: number; readonly shape: number };

export interface GtrSpecification {
  readonly preset: "flu-demo" | "transition-rich" | "balanced" | "custom";
  /** AC, AG, AT, CG, CT, GT exchangeabilities. */
  readonly exchangeabilities: readonly [number, number, number, number, number, number];
  /** A,C,G,T frequency rows for codon positions 1,2,3. */
  readonly f3x4: readonly number[];
}

export interface StandardCodonConfig {
  readonly engine: "mg94";
  readonly sites: number;
  readonly geneticCodeId: GeneticCodeId;
  readonly gtr: GtrSpecification;
  readonly alpha: MarginalDistribution;
  readonly omega: MarginalDistribution;
}

export interface ScuffCodonConfig {
  readonly engine: "scuff";
  readonly sites: number;
  readonly geneticCodeId: GeneticCodeId;
  readonly gtr: GtrSpecification;
  readonly alpha: MarginalDistribution;
  readonly eventRate: MarginalDistribution;
  readonly equilibriumSigma: MarginalDistribution;
  readonly mixingRate: MarginalDistribution;
  readonly burninTime: number;
  readonly diagnosticTime: number;
}

export type CodonSimulationConfig = StandardCodonConfig | ScuffCodonConfig;

export type RecombinationMode = "single-crossover" | "single-tract" | "few-switches" | "template-switching";
export interface RecombinationConfig {
  readonly enabled: boolean;
  /** Events per lineage-time unit on the full carrier tree. */
  readonly eventRate: number;
  readonly mode: RecombinationMode;
  readonly meanBreakpoints: number;
  readonly meanTractCodons: number;
  readonly hotspotMode: "none" | "random" | "manual";
  readonly hotspotCount: number;
  readonly hotspotWidth: number;
  readonly hotspotIntensity: number;
  readonly manualHotspots: readonly number[];
  readonly carrierOversample: number;
}

export interface SimulatorConfig {
  readonly seed: number;
  readonly simulateAlignment: boolean;
  readonly tree: TreeSimulationConfig;
  readonly codon: CodonSimulationConfig;
  readonly recombination: RecombinationConfig;
}

export interface RecombinationEventTruth {
  readonly id: number;
  readonly age: number;
  readonly recipientBranch: number;
  readonly donorBranch: number;
  readonly intervals: readonly { readonly startCodon: number; readonly endCodon: number }[];
  readonly breakpoints: readonly number[];
  readonly visibleAfterSubsampling: boolean;
}

export interface LocalTreeTruth {
  readonly startCodon: number;
  readonly endCodon: number;
  readonly tree: SimulatedTree;
  readonly activeEventIds: readonly number[];
}

export interface SiteParameterTruth {
  readonly alpha: readonly number[];
  readonly omega?: readonly number[];
  readonly eventRate?: readonly number[];
  readonly equilibriumSigma?: readonly number[];
  readonly mixingRate?: readonly number[];
  /** Ω(σ)=sqrt(σ²+π)/sqrt(π): the independent-fitness-redraw expected dN/dS reference. */
  readonly scuffMaximumExpectedDnds?: readonly number[];
}

export interface ScuffDiagnostic {
  readonly times: readonly number[];
  /** Row-major time × 20 amino-acid scaled fitness. */
  readonly fitness: readonly number[];
  /** Row-major time × codon-state frequency. */
  readonly codonFrequencies: readonly number[];
  readonly codons: readonly string[];
  readonly aminoAcids: readonly string[];
  readonly dnds: readonly number[];
  readonly maximumExpectedDnds: number;
  readonly sampledMeanDnds: number;
}

export interface DatasetDiagnostics {
  readonly treeHeight: number;
  readonly totalTreeLength: number;
  readonly carrierTips: number;
  readonly observedTips: number;
  readonly recombinationEvents: number;
  readonly localTrees: number;
  readonly meanNucleotideDistance?: number;
  readonly meanAminoAcidDistance?: number;
  readonly segregatingNucleotideSites?: number;
}

export interface SimulatedDataset {
  readonly id: string;
  readonly seed: number;
  readonly tree: SimulatedTree;
  readonly carrierTree?: SimulatedTree;
  readonly localTrees: readonly LocalTreeTruth[];
  readonly recombinationEvents: readonly RecombinationEventTruth[];
  readonly hotspotWeights: readonly number[];
  readonly names: readonly string[];
  readonly sequences?: readonly string[];
  readonly fasta?: string;
  readonly siteParameters?: SiteParameterTruth;
  readonly diagnostics: DatasetDiagnostics;
}

export interface SimulatorAnalysisResult {
  readonly method: "simulator";
  readonly config: SimulatorConfig;
  readonly datasets: readonly SimulatedDataset[];
  readonly scuffDiagnostic?: ScuffDiagnostic;
  readonly elapsedMs: number;
  readonly diagnostics: {
    readonly coalescentHazard: "integrated-competing-risks";
    readonly coalescentRateConvention: "choose(k,2)/(ploidy*Ne(t))";
    readonly samplingProcess: "inhomogeneous-poisson";
    readonly curveInterpolation: "shape-preserving-cubic";
    readonly sequenceSampler: "exact-gillespie";
    readonly recombinationSampler: "branch-interior-time-aware-spr";
  };
}

export interface SimulatorProgressDetail {
  readonly message?: string;
  readonly current?: number;
  readonly total?: number;
  readonly metricLabel?: string;
  readonly metricValue?: number;
  readonly indeterminate?: boolean;
}

export interface SimulatorOptions {
  readonly onProgress?: (stage: string, fraction: number, detail?: SimulatorProgressDetail) => void;
}
