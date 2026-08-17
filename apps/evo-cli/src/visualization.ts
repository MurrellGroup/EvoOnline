import type { ComparisonRecord, ComparisonSignal } from "./comparison.js";
import type { MethodVisualizationSettings, PipelineVisualization } from "./pipeline.js";

export interface ResolvedVisualizationSettings {
  readonly posteriorThreshold: number;
  readonly positivePosteriorThreshold: number;
  readonly purifyingPosteriorThreshold: number;
  readonly significanceThreshold: number;
  readonly bayesFactorThreshold: number;
  readonly siteMetric?: string;
  readonly maxSitesPerPlot: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaultPosteriorThreshold(methodId: string): number {
  if (methodId === "fame" || methodId === "flavor" || methodId === "glamma") return 0.9;
  return 0.95;
}

export function resolveVisualizationSettings(
  record: ComparisonRecord,
  visualization?: PipelineVisualization,
): ResolvedVisualizationSettings {
  const method = visualization?.methods?.[record.methodId] ?? {};
  const node = record.nodeId === undefined ? {} : visualization?.nodes?.[record.nodeId] ?? {};
  const merged: MethodVisualizationSettings = { ...method, ...node };
  const posteriorThreshold = finite(
    merged.posteriorThreshold,
    finite(record.parameters.posteriorThreshold, defaultPosteriorThreshold(record.methodId)),
  );
  return {
    posteriorThreshold,
    positivePosteriorThreshold: finite(merged.positivePosteriorThreshold, posteriorThreshold),
    purifyingPosteriorThreshold: finite(merged.purifyingPosteriorThreshold, posteriorThreshold),
    significanceThreshold: finite(
      merged.significanceThreshold,
      finite(record.parameters.significanceThreshold, 0.05),
    ),
    bayesFactorThreshold: finite(merged.bayesFactorThreshold, 10),
    ...(merged.siteMetric === undefined ? {} : { siteMetric: merged.siteMetric }),
    maxSitesPerPlot: Math.max(1, Math.floor(finite(merged.maxSitesPerPlot, 100))),
  };
}

function thresholdForSignal(
  signal: ComparisonSignal,
  settings: ResolvedVisualizationSettings,
): { readonly threshold: number; readonly direction: "above" | "below" } {
  const metric = signal.metricId;
  if (/pvalue|p-value|p value/i.test(metric)) return { threshold: settings.significanceThreshold, direction: "below" };
  if (metric === "pPositive" && signal.methodId === "fubar") return { threshold: settings.positivePosteriorThreshold, direction: "above" };
  if (metric === "pPurifying" && signal.methodId === "fubar") return { threshold: settings.purifyingPosteriorThreshold, direction: "above" };
  if (/posterior|probability|^p[A-Z]|^p[_-]|pOmega|pShift|pRelaxation|pIntensification/i.test(metric)) {
    return { threshold: settings.posteriorThreshold, direction: "above" };
  }
  if (/bayesfactor|bayes-factor|bayes factor|evidence ratio/i.test(metric)) return { threshold: settings.bayesFactorThreshold, direction: "above" };
  if (/log.*evidence|log.*bf/i.test(metric)) return { threshold: Math.log(settings.bayesFactorThreshold), direction: "above" };
  return { threshold: signal.threshold, direction: signal.direction };
}

export function applyVisualizationSettings(
  signals: readonly ComparisonSignal[],
  settings: ResolvedVisualizationSettings,
): readonly ComparisonSignal[] {
  return signals.map((signal) => {
    const resolved = thresholdForSignal(signal, settings);
    return { ...signal, threshold: resolved.threshold, direction: resolved.direction };
  });
}

export function selectMethodSiteSignal(
  signals: readonly ComparisonSignal[],
  settings: ResolvedVisualizationSettings,
): ComparisonSignal | undefined {
  const sites = signals.filter((signal) => signal.unit === "site");
  if (settings.siteMetric !== undefined) {
    const selected = sites.find((signal) => signal.metricId === settings.siteMetric);
    if (selected !== undefined) return selected;
  }
  const preferences: Readonly<Record<string, readonly string[]>> = {
    simulator: ["true-omega", "true-dn", "true-ds"],
    fubar: ["pPositive", "pPurifying", "exp-log-mean-rate-ratio"],
    diffubar: ["pOmega1Greater", "pOmega2Greater", "pOmega1Positive", "pOmega2Positive"],
    fame: ["pPositive", "meanOmega2"],
    flavor: ["pPositive", "meanOmega"],
    glamma: ["maximumBranchPosterior", "conditionalSupport"],
    "clade-shift": ["pShift", "pRelaxation", "pIntensification"],
  };
  for (const metric of preferences[sites[0]?.methodId ?? ""] ?? []) {
    const candidate = sites.find((signal) => signal.metricId === metric);
    if (candidate !== undefined) return candidate;
  }
  return sites[0];
}
