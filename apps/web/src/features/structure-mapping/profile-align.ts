import { AMINO_ACIDS } from "./sequence-profile.js";
import type { AminoAcidProfile, ProfileAlignment, StructureChain } from "./types.js";

const BLOSUM62 = new Int8Array([
   4,-1,-2,-2, 0,-1,-1, 0,-2,-1,-1,-1,-1,-2,-1, 1, 0,-3,-2, 0,
  -1, 5, 0,-2,-3, 1, 0,-2, 0,-3,-2, 2,-1,-3,-2,-1,-1,-3,-2,-3,
  -2, 0, 6, 1,-3, 0, 0, 0, 1,-3,-3, 0,-2,-3,-2, 1, 0,-4,-2,-3,
  -2,-2, 1, 6,-3, 0, 2,-1,-1,-3,-4,-1,-3,-3,-1, 0,-1,-4,-3,-3,
   0,-3,-3,-3, 9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1,
  -1, 1, 0, 0,-3, 5, 2,-2, 0,-3,-2, 1, 0,-3,-1, 0,-1,-2,-1,-2,
  -1, 0, 0, 2,-4, 2, 5,-2, 0,-3,-3, 1,-2,-3,-1, 0,-1,-3,-2,-2,
   0,-2, 0,-1,-3,-2,-2, 6,-2,-4,-4,-2,-3,-3,-2, 0,-2,-2,-3,-3,
  -2, 0, 1,-1,-3, 0, 0,-2, 8,-3,-3,-1,-2,-1,-2,-1,-2,-2, 2,-3,
  -1,-3,-3,-3,-1,-3,-3,-4,-3, 4, 2,-3, 1, 0,-3,-2,-1,-3,-1, 3,
  -1,-2,-3,-4,-1,-2,-3,-4,-3, 2, 4,-2, 2, 0,-3,-2,-1,-2,-1, 1,
  -1, 2, 0,-1,-3, 1, 1,-2,-1,-3,-2, 5,-1,-3,-1, 0,-1,-3,-2,-2,
  -1,-1,-2,-3,-1, 0,-2,-3,-2, 1, 2,-1, 5, 0,-2,-1,-1,-1,-1, 1,
  -2,-3,-3,-3,-2,-3,-3,-3,-1, 0, 0,-3, 0, 6,-4,-2,-2, 1, 3,-1,
  -1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-4, 7,-1,-1,-4,-3,-2,
   1,-1, 1, 0,-1, 0, 0, 0,-1,-2,-2, 0,-1,-2,-1, 4, 1,-3,-2,-2,
   0,-1, 0,-1,-1,-1,-1,-2,-2,-1,-1,-1,-1,-2,-1, 1, 5,-2,-2, 0,
  -3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1, 1,-4,-3,-2,11, 2,-3,
  -2,-2,-2,-3,-2,-1,-2,-3, 2,-1,-1,-2,-1, 3,-3,-2,-2, 2, 7,-1,
   0,-3,-3,-3,-1,-2,-2,-3,-3, 3, 1,-2, 1,-1,-2,-2, 0,-3,-1, 4,
]);

const AMINO_INDEX = new Map(Array.from(AMINO_ACIDS, (aminoAcid, index) => [aminoAcid, index]));

export function buildProfileSubstitutionScores(profile: AminoAcidProfile): Float32Array {
  const scores = new Float32Array(profile.columns.length * AMINO_ACIDS.length);
  for (let profileIndex = 0; profileIndex < profile.columns.length; profileIndex += 1) {
    const column = profile.columns[profileIndex]!;
    for (let target = 0; target < AMINO_ACIDS.length; target += 1) {
      if (column.validCount === 0) {
        scores[profileIndex * AMINO_ACIDS.length + target] = -2;
        continue;
      }
      let expected = 0;
      for (let source = 0; source < AMINO_ACIDS.length; source += 1) {
        expected += column.frequencies[source]! * BLOSUM62[source * AMINO_ACIDS.length + target]!;
      }
      scores[profileIndex * AMINO_ACIDS.length + target] = expected;
    }
  }
  return scores;
}

function profileScore(scores: Float32Array, profileIndex: number, aminoAcid: string): number {
  const target = AMINO_INDEX.get(aminoAcid);
  if (target === undefined) return -1;
  return scores[profileIndex * AMINO_ACIDS.length + target]!;
}

export function alignProfileToChain(
  profile: AminoAcidProfile,
  chain: StructureChain,
  gapOpen = -10,
  gapExtend = -1,
  substitutionScores = buildProfileSubstitutionScores(profile),
): ProfileAlignment {
  const rows = profile.columns.length;
  const columns = chain.residues.length;
  let previousMatch = new Float32Array(columns + 1);
  let previousGapChain = new Float32Array(columns + 1);
  let previousGapProfile = new Float32Array(columns + 1);
  let currentMatch = new Float32Array(columns + 1);
  let currentGapChain = new Float32Array(columns + 1);
  let currentGapProfile = new Float32Array(columns + 1);
  const trace = new Uint8Array((rows + 1) * (columns + 1));
  let bestScore = 0;
  let bestRow = 0;
  let bestColumn = 0;
  let bestState = 0;

  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      let diagonalBase = previousMatch[column - 1]!;
      let matchPredecessor = diagonalBase > 0 ? 1 : 0;
      if (previousGapChain[column - 1]! > diagonalBase) {
        diagonalBase = previousGapChain[column - 1]!;
        matchPredecessor = 2;
      }
      if (previousGapProfile[column - 1]! > diagonalBase) {
        diagonalBase = previousGapProfile[column - 1]!;
        matchPredecessor = 3;
      }
      const match = diagonalBase + profileScore(substitutionScores, row - 1, chain.sequence[column - 1]!);
      currentMatch[column] = Math.max(0, match);
      if (currentMatch[column] === 0) matchPredecessor = 0;

      const openGapChain = previousMatch[column]! + gapOpen;
      const extendGapChain = previousGapChain[column]! + gapExtend;
      const gapChain = Math.max(0, openGapChain, extendGapChain);
      currentGapChain[column] = gapChain;
      const gapChainPredecessor = gapChain === 0 ? 0 : openGapChain >= extendGapChain ? 1 : 2;

      const openGapProfile = currentMatch[column - 1]! + gapOpen;
      const extendGapProfile = currentGapProfile[column - 1]! + gapExtend;
      const gapProfile = Math.max(0, openGapProfile, extendGapProfile);
      currentGapProfile[column] = gapProfile;
      const gapProfilePredecessor = gapProfile === 0 ? 0 : openGapProfile >= extendGapProfile ? 1 : 3;

      trace[row * (columns + 1) + column] = matchPredecessor | (gapChainPredecessor << 2) | (gapProfilePredecessor << 4);
      let cellScore = currentMatch[column]!;
      let cellState = 1;
      if (gapChain > cellScore) { cellScore = gapChain; cellState = 2; }
      if (gapProfile > cellScore) { cellScore = gapProfile; cellState = 3; }
      if (cellScore > bestScore) {
        bestScore = cellScore;
        bestRow = row;
        bestColumn = column;
        bestState = cellState;
      }
    }
    [previousMatch, currentMatch] = [currentMatch, previousMatch];
    [previousGapChain, currentGapChain] = [currentGapChain, previousGapChain];
    [previousGapProfile, currentGapProfile] = [currentGapProfile, previousGapProfile];
    currentMatch.fill(0);
    currentGapChain.fill(0);
    currentGapProfile.fill(0);
  }

  const siteToResidue = new Int32Array(rows);
  siteToResidue.fill(-1);
  const alignedProfile: string[] = [];
  const alignedChain: string[] = [];
  const matchLine: string[] = [];
  const profileIndices: number[] = [];
  const residueIndices: number[] = [];
  let mappedResidues = 0;
  let identities = 0;
  let row = bestRow;
  let column = bestColumn;
  let state = bestState;
  while (row > 0 && column > 0 && state !== 0) {
    const encoded = trace[row * (columns + 1) + column]!;
    if (state === 1) {
      const profileAminoAcid = profile.columns[row - 1]!.consensus;
      const chainAminoAcid = chain.sequence[column - 1]!;
      siteToResidue[row - 1] = column - 1;
      mappedResidues += 1;
      if (profileAminoAcid === chainAminoAcid && profileAminoAcid !== "X") identities += 1;
      alignedProfile.push(profileAminoAcid);
      alignedChain.push(chainAminoAcid);
      matchLine.push(profileAminoAcid === chainAminoAcid ? "|" : ".");
      profileIndices.push(row - 1);
      residueIndices.push(column - 1);
      row -= 1;
      column -= 1;
      state = encoded & 3;
    } else if (state === 2) {
      alignedProfile.push(profile.columns[row - 1]!.consensus);
      alignedChain.push("-");
      matchLine.push(" ");
      profileIndices.push(row - 1);
      residueIndices.push(-1);
      row -= 1;
      state = (encoded >> 2) & 3;
    } else {
      alignedProfile.push("-");
      alignedChain.push(chain.sequence[column - 1]!);
      matchLine.push(" ");
      profileIndices.push(-1);
      residueIndices.push(column - 1);
      column -= 1;
      state = (encoded >> 4) & 3;
    }
  }

  alignedProfile.reverse();
  alignedChain.reverse();
  matchLine.reverse();
  profileIndices.reverse();
  residueIndices.reverse();
  let gaps = 0;
  let positivePairs = 0;
  let ungappedRun = 0;
  let positiveRun = 0;
  let longestUngappedRun = 0;
  let longestPositiveRun = 0;
  for (let index = 0; index < profileIndices.length; index += 1) {
    const profileIndex = profileIndices[index]!;
    const residueIndex = residueIndices[index]!;
    if (profileIndex < 0 || residueIndex < 0) {
      gaps += 1;
      ungappedRun = 0;
      positiveRun = 0;
      continue;
    }
    ungappedRun += 1;
    longestUngappedRun = Math.max(longestUngappedRun, ungappedRun);
    if (profileScore(substitutionScores, profileIndex, chain.sequence[residueIndex]!) > 0) {
      positivePairs += 1;
      positiveRun += 1;
      longestPositiveRun = Math.max(longestPositiveRun, positiveRun);
    } else {
      positiveRun = 0;
    }
  }
  return {
    chainId: chain.id,
    score: bestScore,
    scorePerMappedResidue: bestScore / Math.max(1, mappedResidues),
    identity: identities / Math.max(1, mappedResidues),
    chainCoverage: mappedResidues / Math.max(1, chain.residues.length),
    coverage: mappedResidues / Math.max(1, profile.columns.length),
    mappedResidues,
    gapFraction: gaps / Math.max(1, profileIndices.length),
    positiveMatchFraction: positivePairs / Math.max(1, mappedResidues),
    longestUngappedRun,
    longestPositiveRun,
    siteToResidue,
    profileIndices: Int32Array.from(profileIndices),
    residueIndices: Int32Array.from(residueIndices),
    alignedProfile: alignedProfile.join(""),
    alignedChain: alignedChain.join(""),
    matchLine: matchLine.join(""),
  };
}

export interface StructureAlignmentAssessment {
  readonly credible: boolean;
  readonly label: "strong" | "credible" | "weak";
  readonly reason: string;
}

/**
 * Conservative against short random local hits, but deliberately permissive
 * for cleaved polyprotein chains: good coverage of either the input profile or
 * the structure chain is sufficient. Long, positive-scoring contiguous runs
 * can rescue remote homologs with modest exact identity.
 */
export function assessStructureAlignment(alignment: ProfileAlignment): StructureAlignmentAssessment {
  const coverageEvidence = alignment.coverage >= 0.08 || alignment.chainCoverage >= 0.25 || alignment.mappedResidues >= 45;
  const almostExactShortMatch = alignment.mappedResidues >= 3
    && alignment.identity >= 0.85
    && Math.max(alignment.coverage, alignment.chainCoverage) >= 0.65
    && alignment.longestUngappedRun >= Math.max(3, Math.floor(alignment.mappedResidues * 0.8));
  if (almostExactShortMatch) return { credible: true, label: "strong", reason: "near-exact covered segment" };
  const enoughSpan = alignment.mappedResidues >= 8;
  const cleanRun = alignment.longestUngappedRun >= 8 && alignment.longestPositiveRun >= 5;
  const boundedGaps = alignment.gapFraction <= 0.45;
  const scoreEvidence = alignment.score >= Math.max(22, 0.75 * alignment.mappedResidues)
    && alignment.scorePerMappedResidue >= 0.85;
  const sequenceEvidence = alignment.identity >= 0.20
    || (alignment.identity >= 0.14 && alignment.positiveMatchFraction >= 0.62 && alignment.scorePerMappedResidue >= 1.35);
  const credible = enoughSpan && coverageEvidence && cleanRun && boundedGaps && scoreEvidence && sequenceEvidence;
  if (!credible) return { credible: false, label: "weak", reason: "insufficient span, coverage, or contiguous sequence evidence" };
  const strong = alignment.identity >= 0.35
    || (alignment.positiveMatchFraction >= 0.75 && alignment.longestPositiveRun >= 12)
    || (Math.max(alignment.coverage, alignment.chainCoverage) >= 0.8 && alignment.identity >= 0.25);
  return {
    credible: true,
    label: strong ? "strong" : "credible",
    reason: strong ? "strong contiguous sequence match" : "credible contiguous sequence match",
  };
}

export function alignProfileToChains(profile: AminoAcidProfile, chains: readonly StructureChain[]): readonly ProfileAlignment[] {
  const substitutionScores = buildProfileSubstitutionScores(profile);
  return chains
    .map((chain) => alignProfileToChain(profile, chain, -10, -1, substitutionScores))
    .sort((left, right) => right.score - left.score || right.mappedResidues - left.mappedResidues);
}
