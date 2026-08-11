import type { DifFubarRunResult, FubarRunResult } from "../../types.js";
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
