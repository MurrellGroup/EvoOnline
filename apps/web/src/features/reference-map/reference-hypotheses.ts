import type { BameRunResult, DifFubarRunResult, FubarRunResult, GlobalGammaRunResult } from "../../types.js";
import type { ReferenceEvidenceSite, ReferenceHypothesis } from "./types.js";

export const DIFFUBAR_REFERENCE_HYPOTHESES: readonly ReferenceHypothesis[] = Object.freeze([
  { id: "omega1-greater", label: "P(ω·G1 > ω·G2)", shortLabel: "G1 > G2", color: "#e64b50" },
  { id: "omega2-greater", label: "P(ω·G2 > ω·G1)", shortLabel: "G2 > G1", color: "#5148e5" },
  { id: "omega1-positive", label: "P(ω·G1 > 1)", shortLabel: "G1 > 1", color: "#e99016" },
  { id: "omega2-positive", label: "P(ω·G2 > 1)", shortLabel: "G2 > 1", color: "#148da3" },
]);

export const FUBAR_REFERENCE_HYPOTHESES: readonly ReferenceHypothesis[] = Object.freeze([
  { id: "positive", label: "P(β > α)", shortLabel: "Positive", color: "#e64b50" },
  { id: "purifying", label: "P(α > β)", shortLabel: "Purifying", color: "#5148e5" },
]);

export const BAME_REFERENCE_HYPOTHESES: readonly ReferenceHypothesis[] = Object.freeze([
  { id: "episodic-positive", label: "P(episodic ω > 1)", shortLabel: "Episodic +", color: "#e64b50" },
]);

export const GLOBAL_GAMMA_REFERENCE_HYPOTHESES: readonly ReferenceHypothesis[] = Object.freeze([
  { id: "capped-site-support", label: "Equal-prior support for uncapped site model", shortLabel: "Uncapped site", color: "#e64b50" },
  { id: "maximum-branch-tail", label: "Maximum branch P(omega > 1) at site", shortLabel: "Max branch tail", color: "#d88916" },
]);

export function buildDifFubarReferenceEvidence(result: Pick<DifFubarRunResult, "sites">): readonly ReferenceEvidenceSite[] {
  return result.sites.map((site) => ({
    site: site.site,
    probabilities: {
      "omega1-greater": site.pOmega1Greater,
      "omega2-greater": site.pOmega2Greater,
      "omega1-positive": site.pOmega1Positive,
      "omega2-positive": site.pOmega2Positive,
    },
  }));
}

export function buildFubarReferenceEvidence(result: Pick<FubarRunResult, "sites">): readonly ReferenceEvidenceSite[] {
  return result.sites.map((site) => ({
    site: site.site,
    probabilities: { positive: site.pPositive, purifying: site.pPurifying },
  }));
}

export function buildBameReferenceEvidence(result: Pick<BameRunResult, "sites">): readonly ReferenceEvidenceSite[] {
  return result.sites.map((site) => ({ site: site.site, probabilities: { "episodic-positive": site.pPositive } }));
}

export function buildGlobalGammaReferenceEvidence(result: Pick<GlobalGammaRunResult, "sites">): readonly ReferenceEvidenceSite[] {
  return result.sites.map((site) => ({
    site: site.site,
    probabilities: {
      "capped-site-support": site.conditionalSupport,
      "maximum-branch-tail": site.maximumBranchPosterior,
    },
  }));
}
