import type { BameRunResult, CladeShiftRunResult, DifFubarRunResult, FubarRunResult, GlobalGammaRunResult } from "../../types.js";
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

function maximumAbsoluteValue(sites: readonly StructureSiteDatum[], key: string): number {
  return Math.max(1e-9, ...sites.map((site) => Math.abs(site.values[key] ?? 0)).filter(Number.isFinite));
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

export function buildBameStructureSites(result: BameRunResult, threshold: number): readonly StructureSiteDatum[] {
  return result.sites.map((site) => {
    const detected = site.pPositive > threshold;
    const values: Record<string, number> = {
      pPositive: site.pPositive,
      logBayesFactor: Math.log10(Math.max(1e-12, Math.min(1e12, site.bayesFactor))),
      meanAlpha: site.meanAlpha,
    };
    if (result.method === "fame" && "meanOmega1" in site) {
      values.meanOmega1 = site.meanOmega1;
      values.meanOmega2 = site.meanOmega2;
      values.episodicContrast = Math.log2(Math.max(1e-8, site.meanOmega2) / Math.max(1e-8, site.meanOmega1));
    } else if (result.method === "flavor" && "meanOmega" in site) {
      values.meanOmega = site.meanOmega;
      values.positiveBranchFraction = site.meanPositiveBranchFraction;
      values.episodicContrast = Math.log2(Math.max(1e-8, site.meanOmega) / Math.max(1e-8, site.meanAlpha));
    }
    return { site: site.site, detected, direction: detected ? "positive" : "none", values };
  });
}

export function bameStructureColorModes(sites: readonly StructureSiteDatum[]): readonly StructureColorMode[] {
  const maximumPosterior = maximumValue(sites, "pPositive");
  return [
    {
      id: "episodic-detection",
      label: "Episodic selection call",
      description: "Positive branch-mixture evidence at the current posterior threshold.",
      color: (site) => site.detected ? RED : NEUTRAL,
      valueLabel: (site) => site.detected ? "episodic positive" : "not detected",
      legend: [{ color: RED, label: "episodic positive" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "positive-posterior",
      label: "Positive posterior",
      description: "Sequential coloring by posterior support for an omega-above-one branch mixture.",
      color: (site) => interpolateColor("#f1efef", RED, (site.values.pPositive ?? 0) / maximumPosterior),
      valueLabel: (site) => `posterior = ${(site.values.pPositive ?? 0).toFixed(3)}`,
      legend: [{ color: "#f1efef", label: "0" }, { color: RED, label: maximumPosterior.toFixed(2) }],
    },
    {
      id: "empirical-bayes-factor",
      label: "log₁₀ empirical Bayes factor",
      description: "Evidence ratio relative to the inferred global positive-category mass, clipped at 10¹².",
      color: (site) => diverging(site.values.logBayesFactor ?? 0, 4),
      valueLabel: (site) => `log₁₀ BF = ${(site.values.logBayesFactor ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "against" }, { color: "#f0f2f1", label: "BF=1" }, { color: RED, label: "for" }],
    },
    {
      id: "episodic-effect",
      label: "Posterior mean episodic contrast",
      description: "FAME: log₂(ω₂/ω₁). FLAVOR: log₂(mean ω/α).",
      color: (site) => diverging(site.values.episodicContrast ?? 0, 4),
      valueLabel: (site) => `log₂ contrast = ${(site.values.episodicContrast ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "≤ −4" }, { color: "#f0f2f1", label: "0" }, { color: RED, label: "≥ +4" }],
    },
  ];
}

export function buildGlammaStructureSites(
  result: GlobalGammaRunResult,
  threshold: number,
  selectedBranch: number | null,
): readonly StructureSiteDatum[] {
  const branchOffset = selectedBranch === null ? -1 : (selectedBranch - 1) * result.posterior.siteCount;
  return result.sites.map((site, index) => {
    const selectedBranchTail = branchOffset < 0 ? 0 : result.posterior.tailPosterior[branchOffset + index] ?? 0;
    const selectedBranchLogEvidence = branchOffset < 0 ? 0 : result.posterior.localLogEvidence[branchOffset + index] ?? 0;
    const detected = Math.max(site.conditionalSupport, site.maximumBranchPosterior) >= threshold;
    return {
      site: site.site,
      detected,
      direction: detected ? "positive" : "none",
      values: {
        conditionalSupport: site.conditionalSupport,
        centeredConditionalSupport: (site.conditionalSupport - 0.5) * 2,
        maximumBranchPosterior: site.maximumBranchPosterior,
        expectedPositiveBranches: site.expectedPositiveBranches,
        siteLogEvidence: site.cappedLogEvidence,
        selectedBranchTail,
        selectedBranchLogEvidence,
      },
    };
  });
}

export function glammaStructureColorModes(
  sites: readonly StructureSiteDatum[],
  selectedBranchName?: string,
): readonly StructureColorMode[] {
  const maximumExpected = maximumValue(sites, "expectedPositiveBranches");
  const siteEvidenceDomain = maximumAbsoluteValue(sites, "siteLogEvidence");
  const branchEvidenceDomain = maximumAbsoluteValue(sites, "selectedBranchLogEvidence");
  const modes: StructureColorMode[] = [
    {
      id: "glamma-detection",
      label: "Detected / not detected",
      description: "Detected when either full-vs-null site support or the maximum branch-tail posterior reaches the live threshold.",
      color: (site) => site.detected ? RED : NEUTRAL,
      valueLabel: (site) => site.detected ? "positive-selection signal" : "not detected",
      legend: [{ color: RED, label: "detected" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "glamma-site-support",
      label: "Full-vs-null site support",
      description: "Equal-prior transform of the full/all-branches-null evidence ratio; 0.5 is neutral.",
      color: (site) => diverging(site.values.centeredConditionalSupport ?? 0),
      valueLabel: (site) => `support = ${(site.values.conditionalSupport ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "null" }, { color: "#f0f2f1", label: "0.5" }, { color: RED, label: "full" }],
    },
    {
      id: "glamma-site-evidence",
      label: "Full/null site log evidence",
      description: "Natural-log evidence ratio for the full Gamma model versus replacing every branch's omega-above-one categories by one at this site.",
      color: (site) => diverging(site.values.siteLogEvidence ?? 0, siteEvidenceDomain),
      valueLabel: (site) => `log ER = ${(site.values.siteLogEvidence ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "null" }, { color: "#f0f2f1", label: "ER=1" }, { color: RED, label: "full" }],
    },
    {
      id: "glamma-max-branch-tail",
      label: "Maximum branch P(ω > 1)",
      description: "Largest positive-tail posterior among branches at each codon.",
      color: (site) => interpolateColor("#f1efef", RED, site.values.maximumBranchPosterior ?? 0),
      valueLabel: (site) => `max branch posterior = ${(site.values.maximumBranchPosterior ?? 0).toFixed(3)}`,
      legend: [{ color: "#f1efef", label: "0" }, { color: RED, label: "1" }],
    },
    {
      id: "glamma-positive-branch-burden",
      label: "Expected positive branches",
      description: "Sum of branch-specific positive-tail posterior probabilities at each codon.",
      color: (site) => sequential(site.values.expectedPositiveBranches ?? 0, maximumExpected),
      valueLabel: (site) => `E[positive branches] = ${(site.values.expectedPositiveBranches ?? 0).toFixed(3)}`,
      legend: [{ color: "#e9f2ef", label: "0" }, { color: "#075b55", label: maximumExpected.toFixed(2) }],
    },
  ];
  if (selectedBranchName !== undefined) modes.push(
    {
      id: "glamma-selected-branch-tail",
      label: `${selectedBranchName}: P(ω > 1)`,
      description: "Positive-tail posterior for the branch selected in the Glamma tree.",
      color: (site) => interpolateColor("#f1efef", RED, site.values.selectedBranchTail ?? 0),
      valueLabel: (site) => `branch posterior = ${(site.values.selectedBranchTail ?? 0).toFixed(3)}`,
      legend: [{ color: "#f1efef", label: "0" }, { color: RED, label: "1" }],
    },
    {
      id: "glamma-selected-branch-evidence",
      label: `${selectedBranchName}: local log evidence`,
      description: "Full-versus-branch-null log evidence at each codon for the selected branch.",
      color: (site) => diverging(site.values.selectedBranchLogEvidence ?? 0, branchEvidenceDomain),
      valueLabel: (site) => `local log ER = ${(site.values.selectedBranchLogEvidence ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "branch null" }, { color: "#f0f2f1", label: "ER=1" }, { color: RED, label: "full" }],
    },
  );
  return modes;
}

export function buildCladeShiftStructureSites(
  result: CladeShiftRunResult,
  threshold: number,
  selectedBranch: number | null,
): readonly StructureSiteDatum[] {
  return result.sites.map((site, index) => {
    const branchIndex = selectedBranch === null ? -1 : (selectedBranch - 1) * result.posterior.siteCount + index;
    const branchRelaxation = branchIndex < 0 ? 0 : result.posterior.branchRelaxation[branchIndex] ?? 0;
    const branchIntensification = branchIndex < 0 ? 0 : result.posterior.branchIntensification[branchIndex] ?? 0;
    const detected = site.pShift >= threshold;
    return {
      site: site.site,
      detected,
      direction: detected ? (site.pIntensification >= site.pRelaxation ? "positive" : "purifying") : "none",
      values: {
        pShift: site.pShift,
        pRelaxation: site.pRelaxation,
        pIntensification: site.pIntensification,
        signedDirection: site.pIntensification - site.pRelaxation,
        logBayesFactor: site.logBayesFactor,
        mapBranchPosterior: site.mapBranchPosterior,
        meanIntensity: site.meanIntensityGivenShift,
        capturedMass: site.capturedNullPosteriorMass,
        selectedBranchPosterior: branchRelaxation + branchIntensification,
        selectedBranchDirection: branchIntensification - branchRelaxation,
      },
    };
  });
}

export function cladeShiftStructureColorModes(
  sites: readonly StructureSiteDatum[],
  selectedBranchName?: string,
): readonly StructureColorMode[] {
  const logDomain = maximumAbsoluteValue(sites, "logBayesFactor");
  const modes: StructureColorMode[] = [
    {
      id: "clade-shift-direction",
      label: "Persistent-shift direction",
      description: "Blue is relaxation toward neutrality; red is intensification away from neutrality at the live posterior threshold.",
      color: (site) => site.direction === "positive" ? RED : site.direction === "purifying" ? BLUE : NEUTRAL,
      valueLabel: (site) => site.direction === "positive" ? "intensification" : site.direction === "purifying" ? "relaxation" : "not detected",
      legend: [{ color: BLUE, label: "relaxation" }, { color: NEUTRAL, label: "not detected" }, { color: RED, label: "intensification" }],
    },
    {
      id: "clade-shift-detected",
      label: "Shift detected / not detected",
      description: "Binary status using P(any persistent clade shift) and the live threshold.",
      color: (site) => site.detected ? GOLD : NEUTRAL,
      valueLabel: (site) => site.detected ? "detected" : "not detected",
      legend: [{ color: GOLD, label: "detected" }, { color: NEUTRAL, label: "not detected" }],
    },
    {
      id: "clade-shift-signed",
      label: "Signed direction posterior",
      description: "P(intensification) minus P(relaxation).",
      color: (site) => diverging(site.values.signedDirection ?? 0),
      valueLabel: (site) => `P(intense) - P(relax) = ${(site.values.signedDirection ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "relaxation" }, { color: "#f0f2f1", label: "balanced" }, { color: RED, label: "intensification" }],
    },
    {
      id: "clade-shift-posterior",
      label: "P(any persistent shift)",
      description: "Posterior probability integrated over direction, K, and every eligible initiating branch.",
      color: (site) => interpolateColor("#f0f2f1", GOLD, site.values.pShift ?? 0),
      valueLabel: (site) => `P(shift) = ${(site.values.pShift ?? 0).toFixed(3)}`,
      legend: [{ color: "#f0f2f1", label: "0" }, { color: GOLD, label: "1" }],
    },
    {
      id: "clade-shift-log-bf",
      label: "Shift log Bayes factor",
      description: "Evidence for one persistent descendant-clade shift versus no shift.",
      color: (site) => diverging(site.values.logBayesFactor ?? 0, logDomain),
      valueLabel: (site) => `log BF = ${(site.values.logBayesFactor ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "no shift" }, { color: "#f0f2f1", label: "BF=1" }, { color: RED, label: "shift" }],
    },
    {
      id: "clade-shift-map-branch",
      label: "MAP initiating-branch posterior",
      description: "Unconditional posterior assigned to the most likely initiating branch at each codon.",
      color: (site) => interpolateColor("#e9f2ef", TEAL, site.values.mapBranchPosterior ?? 0),
      valueLabel: (site) => `P(MAP branch) = ${(site.values.mapBranchPosterior ?? 0).toFixed(3)}`,
      legend: [{ color: "#e9f2ef", label: "0" }, { color: TEAL, label: "1" }],
    },
  ];
  if (selectedBranchName !== undefined) modes.push(
    {
      id: "clade-shift-selected-branch",
      label: `${selectedBranchName}: initiating posterior`,
      description: "Posterior that the branch selected in the tree initiated the site's persistent shift.",
      color: (site) => interpolateColor("#f0f2f1", GOLD, site.values.selectedBranchPosterior ?? 0),
      valueLabel: (site) => `branch posterior = ${(site.values.selectedBranchPosterior ?? 0).toFixed(3)}`,
      legend: [{ color: "#f0f2f1", label: "0" }, { color: GOLD, label: "1" }],
    },
    {
      id: "clade-shift-selected-direction",
      label: `${selectedBranchName}: direction`,
      description: "Signed posterior direction conditional only through the selected branch's joint mass.",
      color: (site) => diverging(site.values.selectedBranchDirection ?? 0),
      valueLabel: (site) => `intense - relax = ${(site.values.selectedBranchDirection ?? 0).toFixed(3)}`,
      legend: [{ color: BLUE, label: "relaxation" }, { color: "#f0f2f1", label: "balanced" }, { color: RED, label: "intensification" }],
    },
  );
  return modes;
}
