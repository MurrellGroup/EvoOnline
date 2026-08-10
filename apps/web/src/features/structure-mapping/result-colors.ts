import type { DifFubarRunResult, FubarRunResult } from "../../types.js";
import type { StructureColorMode, StructureSiteDatum } from "./types.js";

const RED = "#e74652";
const BLUE = "#5148e5";
const GOLD = "#e4a72b";
const TEAL = "#16867a";
const NEUTRAL = "#aeb9b5";

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hexChannel(color: string, offset: number): number {
  return Number.parseInt(color.slice(offset, offset + 2), 16);
}

function interpolateColor(left: string, right: string, fraction: number): string {
  const amount = Math.round(clamp(fraction) * 12) / 12;
  const channel = (offset: number): string => Math.round(hexChannel(left, offset) + (hexChannel(right, offset) - hexChannel(left, offset)) * amount).toString(16).padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function diverging(value: number, domain = 1): string {
  const normalized = clamp(value / Math.max(1e-12, domain), -1, 1);
  return normalized < 0 ? interpolateColor("#f0f2f1", BLUE, -normalized) : interpolateColor("#f0f2f1", RED, normalized);
}

function sequential(value: number, maximum: number): string {
  const normalized = Math.log1p(Math.max(0, value)) / Math.max(1e-12, Math.log1p(Math.max(0, maximum)));
  return interpolateColor("#e9f2ef", "#075b55", normalized);
}

function maximumValue(sites: readonly StructureSiteDatum[], key: string): number {
  return Math.max(1, ...sites.map((site) => site.values[key] ?? 0).filter(Number.isFinite));
}

export function buildFubarStructureSites(result: FubarRunResult, threshold: number, showPositive: boolean, showPurifying: boolean): readonly StructureSiteDatum[] {
  return result.sites.map((site) => {
    const rawDirection = site.pPositive > threshold && site.pPositive >= site.pPurifying
      ? "positive"
      : site.pPurifying > threshold
        ? "purifying"
        : "none";
    const visible = rawDirection === "positive" ? showPositive : rawDirection === "purifying" ? showPurifying : false;
    return {
      site: site.site,
      detected: visible,
      direction: visible ? rawDirection : "none",
      values: {
        pPositive: site.pPositive,
        pPurifying: site.pPurifying,
        signedPosterior: site.pPositive - site.pPurifying,
        meanAlpha: site.meanAlpha,
        meanBeta: site.meanBeta,
        logRatio: Math.log2(Math.max(1e-8, site.meanBeta) / Math.max(1e-8, site.meanAlpha)),
      },
    };
  });
}

export function fubarStructureColorModes(sites: readonly StructureSiteDatum[]): readonly StructureColorMode[] {
  const maximumBeta = maximumValue(sites, "meanBeta");
  return [
    {
      id: "selection-direction",
      label: "Selection direction",
      description: "Positive, purifying, or not detected at the current posterior threshold.",
      color: (site) => site.direction === "positive" ? RED : site.direction === "purifying" ? BLUE : NEUTRAL,
      valueLabel: (site) => site.direction === "none" ? "not detected" : site.direction,
      legend: [{ color: RED, label: "positive" }, { color: BLUE, label: "purifying" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "detected",
      label: "Detected / not detected",
      description: "Binary detection status at the current posterior threshold.",
      color: (site) => site.detected ? GOLD : NEUTRAL,
      valueLabel: (site) => site.detected ? "detected" : "not detected",
      legend: [{ color: GOLD, label: "detected" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "signed-posterior",
      label: "Signed selection posterior",
      description: "P(β>α) minus P(α>β); red is positive and blue is purifying.",
      color: (site) => diverging(site.values.signedPosterior ?? 0),
      valueLabel: (site) => `P+ − P− = ${(site.values.signedPosterior ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "purifying (−1)" }, { color: "#f0f2f1", label: "balanced (0)" }, { color: RED, label: "positive (+1)" }],
    },
    {
      id: "mean-ratio",
      label: "Posterior mean log₂(β/α)",
      description: "Effect-size coloring, clipped at sixteen-fold in either direction.",
      color: (site) => diverging(site.values.logRatio ?? 0, 4),
      valueLabel: (site) => `log₂(β/α) = ${(site.values.logRatio ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "≤ −4" }, { color: "#f0f2f1", label: "0" }, { color: RED, label: "≥ +4" }],
    },
    {
      id: "mean-beta",
      label: "Posterior mean β",
      description: "Sequential coloring by inferred nonsynonymous rate.",
      color: (site) => sequential(site.values.meanBeta ?? 0, maximumBeta),
      valueLabel: (site) => `mean β = ${(site.values.meanBeta ?? 0).toFixed(3)}`,
      legend: [{ color: "#e9f2ef", label: "low" }, { color: "#075b55", label: `high (${maximumBeta.toFixed(2)})` }],
    },
  ];
}

export function buildDifFubarStructureSites(result: DifFubarRunResult, threshold: number): readonly StructureSiteDatum[] {
  return result.sites.map((site) => {
    const pG1 = site.pOmega1Greater;
    const pG2 = site.pOmega2Greater;
    const direction = pG1 > threshold && pG1 >= pG2 ? "g1" : pG2 > threshold ? "g2" : "none";
    const detected = Math.max(pG1, pG2, site.pOmega1Positive, site.pOmega2Positive) > threshold;
    return {
      site: site.site,
      detected,
      direction,
      values: {
        pG1,
        pG2,
        relativePosterior: pG1 - pG2,
        pOmega1Positive: site.pOmega1Positive,
        pOmega2Positive: site.pOmega2Positive,
        meanOmega1: site.meanOmega1,
        meanOmega2: site.meanOmega2,
        logRatio: Math.log2(Math.max(1e-8, site.meanOmega1) / Math.max(1e-8, site.meanOmega2)),
      },
    };
  });
}

export function difFubarStructureColorModes(sites: readonly StructureSiteDatum[]): readonly StructureColorMode[] {
  const maximumOmega1 = maximumValue(sites, "meanOmega1");
  const maximumOmega2 = maximumValue(sites, "meanOmega2");
  return [
    {
      id: "differential-direction",
      label: "Differential direction",
      description: "Red where ω·G1>ω·G2 and blue where ω·G2>ω·G1 at the threshold.",
      color: (site) => site.direction === "g1" ? RED : site.direction === "g2" ? BLUE : NEUTRAL,
      valueLabel: (site) => site.direction === "g1" ? "G1 > G2" : site.direction === "g2" ? "G2 > G1" : "no differential call",
      legend: [{ color: RED, label: "G1 > G2" }, { color: BLUE, label: "G2 > G1" }, { color: NEUTRAL, label: "no differential call" }],
    },
    {
      id: "detected",
      label: "Detected / not detected",
      description: "Any differential or group-specific positive-selection call.",
      color: (site) => site.detected ? GOLD : NEUTRAL,
      valueLabel: (site) => site.detected ? "detected" : "not detected",
      legend: [{ color: GOLD, label: "detected" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "relative-posterior",
      label: "Signed differential posterior",
      description: "P(ω·G1>ω·G2) minus P(ω·G2>ω·G1).",
      color: (site) => diverging(site.values.relativePosterior ?? 0),
      valueLabel: (site) => `P(G1>G2) − P(G2>G1) = ${(site.values.relativePosterior ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "G2 (−1)" }, { color: "#f0f2f1", label: "balanced" }, { color: RED, label: "G1 (+1)" }],
    },
    {
      id: "mean-ratio",
      label: "Posterior mean log₂(ω·G1/ω·G2)",
      description: "Effect-size coloring, clipped at sixteen-fold in either direction.",
      color: (site) => diverging(site.values.logRatio ?? 0, 4),
      valueLabel: (site) => `log₂(ω1/ω2) = ${(site.values.logRatio ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "≤ −4" }, { color: "#f0f2f1", label: "0" }, { color: RED, label: "≥ +4" }],
    },
    {
      id: "mean-omega1",
      label: "Posterior mean ω·G1",
      description: "Sequential coloring by inferred G1 nonsynonymous rate.",
      color: (site) => sequential(site.values.meanOmega1 ?? 0, maximumOmega1),
      valueLabel: (site) => `mean ω·G1 = ${(site.values.meanOmega1 ?? 0).toFixed(3)}`,
      legend: [{ color: "#e9f2ef", label: "low" }, { color: "#075b55", label: `high (${maximumOmega1.toFixed(2)})` }],
    },
    {
      id: "mean-omega2",
      label: "Posterior mean ω·G2",
      description: "Sequential coloring by inferred G2 nonsynonymous rate.",
      color: (site) => sequential(site.values.meanOmega2 ?? 0, maximumOmega2),
      valueLabel: (site) => `mean ω·G2 = ${(site.values.meanOmega2 ?? 0).toFixed(3)}`,
      legend: [{ color: "#e9f2ef", label: "low" }, { color: "#075b55", label: `high (${maximumOmega2.toFixed(2)})` }],
    },
  ];
}
