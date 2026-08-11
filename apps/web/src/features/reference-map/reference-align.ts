import { buildProfileSubstitutionScores } from "../structure-mapping/profile-align.js";
import { AMINO_ACIDS } from "../structure-mapping/sequence-profile.js";
import type { AminoAcidProfile, ProfileAlignment } from "../structure-mapping/types.js";

const NEGATIVE_INFINITY = -1e20;
const MAX_TRACE_CELLS = 100_000_000;

function substitutionScore(scores: Float32Array, profileIndex: number, aminoAcid: string): number {
  const referenceIndex = AMINO_ACIDS.indexOf(aminoAcid);
  return referenceIndex < 0 ? -1 : scores[profileIndex * AMINO_ACIDS.length + referenceIndex]!;
}

function bestOfThree(first: number, second: number, third: number): readonly [number, number] {
  if (second > first && second >= third) return [second, 2];
  if (third > first && third > second) return [third, 3];
  return [first, 1];
}

/**
 * Memory-efficient affine global alignment. Six score rows are retained while one byte per
 * dynamic-programming cell stores the three two-bit traceback predecessors.
 */
export function alignProfileToReference(
  profile: AminoAcidProfile,
  referenceSequence: string,
  gapOpen = -10,
  gapExtend = -1,
  substitutionScores = buildProfileSubstitutionScores(profile),
): ProfileAlignment {
  const rows = profile.columns.length;
  const columns = referenceSequence.length;
  const traceCells = (rows + 1) * (columns + 1);
  if (!Number.isSafeInteger(traceCells) || traceCells > MAX_TRACE_CELLS) {
    throw new Error("This reference/profile pair is too large for exact global alignment in the browser (100 million alignment cells maximum).");
  }

  let previousMatch = new Float32Array(columns + 1);
  let previousGapReference = new Float32Array(columns + 1);
  let previousGapProfile = new Float32Array(columns + 1);
  let currentMatch = new Float32Array(columns + 1);
  let currentGapReference = new Float32Array(columns + 1);
  let currentGapProfile = new Float32Array(columns + 1);
  previousMatch.fill(NEGATIVE_INFINITY);
  previousGapReference.fill(NEGATIVE_INFINITY);
  previousGapProfile.fill(NEGATIVE_INFINITY);
  previousMatch[0] = 0;
  const stride = columns + 1;
  const trace = new Uint8Array(traceCells);

  for (let column = 1; column <= columns; column += 1) {
    previousGapProfile[column] = gapOpen + (column - 1) * gapExtend;
    trace[column] = ((column === 1 ? 1 : 3) << 4);
  }

  for (let row = 1; row <= rows; row += 1) {
    currentMatch.fill(NEGATIVE_INFINITY);
    currentGapReference.fill(NEGATIVE_INFINITY);
    currentGapProfile.fill(NEGATIVE_INFINITY);
    currentGapReference[0] = gapOpen + (row - 1) * gapExtend;
    trace[row * stride] = ((row === 1 ? 1 : 2) << 2);
    for (let column = 1; column <= columns; column += 1) {
      const [diagonal, matchPredecessor] = bestOfThree(
        previousMatch[column - 1]!,
        previousGapReference[column - 1]!,
        previousGapProfile[column - 1]!,
      );
      currentMatch[column] = diagonal + substitutionScore(substitutionScores, row - 1, referenceSequence[column - 1]!);

      const gapReferenceFromMatch = previousMatch[column]! + gapOpen;
      const gapReferenceFromGap = previousGapReference[column]! + gapExtend;
      const gapReferenceFromProfileGap = previousGapProfile[column]! + gapOpen;
      const [gapReference, gapReferencePredecessor] = bestOfThree(gapReferenceFromMatch, gapReferenceFromGap, gapReferenceFromProfileGap);
      currentGapReference[column] = gapReference;

      const gapProfileFromMatch = currentMatch[column - 1]! + gapOpen;
      const gapProfileFromReferenceGap = currentGapReference[column - 1]! + gapOpen;
      const gapProfileFromGap = currentGapProfile[column - 1]! + gapExtend;
      const [gapProfile, gapProfilePredecessorRaw] = bestOfThree(gapProfileFromMatch, gapProfileFromReferenceGap, gapProfileFromGap);
      const gapProfilePredecessor = gapProfilePredecessorRaw === 2 ? 2 : gapProfilePredecessorRaw === 3 ? 3 : 1;
      currentGapProfile[column] = gapProfile;

      trace[row * stride + column] = matchPredecessor | (gapReferencePredecessor << 2) | (gapProfilePredecessor << 4);
    }
    [previousMatch, currentMatch] = [currentMatch, previousMatch];
    [previousGapReference, currentGapReference] = [currentGapReference, previousGapReference];
    [previousGapProfile, currentGapProfile] = [currentGapProfile, previousGapProfile];
  }

  const [score, stateAtEnd] = bestOfThree(previousMatch[columns]!, previousGapReference[columns]!, previousGapProfile[columns]!);
  const siteToResidue = new Int32Array(rows);
  siteToResidue.fill(-1);
  const alignedProfile: string[] = [];
  const alignedReference: string[] = [];
  const matchLine: string[] = [];
  const profileIndices: number[] = [];
  const referenceIndices: number[] = [];
  let mappedResidues = 0;
  let identities = 0;
  let row = rows;
  let column = columns;
  let state = stateAtEnd;

  while (row > 0 || column > 0) {
    if (state === 0) throw new Error("Reference alignment traceback ended before both sequences were consumed.");
    const encoded = trace[row * stride + column]!;
    if (state === 1) {
      const profileAminoAcid = profile.columns[row - 1]!.consensus;
      const referenceAminoAcid = referenceSequence[column - 1]!;
      siteToResidue[row - 1] = column - 1;
      mappedResidues += 1;
      if (profileAminoAcid === referenceAminoAcid && profileAminoAcid !== "X") identities += 1;
      alignedProfile.push(profileAminoAcid);
      alignedReference.push(referenceAminoAcid);
      matchLine.push(profileAminoAcid === referenceAminoAcid ? "|" : ".");
      profileIndices.push(row - 1);
      referenceIndices.push(column - 1);
      row -= 1;
      column -= 1;
      state = encoded & 3;
    } else if (state === 2) {
      alignedProfile.push(profile.columns[row - 1]!.consensus);
      alignedReference.push("-");
      matchLine.push(" ");
      profileIndices.push(row - 1);
      referenceIndices.push(-1);
      row -= 1;
      state = (encoded >> 2) & 3;
    } else {
      alignedProfile.push("-");
      alignedReference.push(referenceSequence[column - 1]!);
      matchLine.push(" ");
      profileIndices.push(-1);
      referenceIndices.push(column - 1);
      column -= 1;
      state = (encoded >> 4) & 3;
    }
  }

  alignedProfile.reverse();
  alignedReference.reverse();
  matchLine.reverse();
  profileIndices.reverse();
  referenceIndices.reverse();
  let gaps = 0;
  let positivePairs = 0;
  let ungappedRun = 0;
  let positiveRun = 0;
  let longestUngappedRun = 0;
  let longestPositiveRun = 0;
  for (let index = 0; index < profileIndices.length; index += 1) {
    const profileIndex = profileIndices[index]!;
    const referenceIndex = referenceIndices[index]!;
    if (profileIndex < 0 || referenceIndex < 0) {
      gaps += 1;
      ungappedRun = 0;
      positiveRun = 0;
      continue;
    }
    ungappedRun += 1;
    longestUngappedRun = Math.max(longestUngappedRun, ungappedRun);
    if (substitutionScore(substitutionScores, profileIndex, referenceSequence[referenceIndex]!) > 0) {
      positivePairs += 1;
      positiveRun += 1;
      longestPositiveRun = Math.max(longestPositiveRun, positiveRun);
    } else positiveRun = 0;
  }
  return {
    chainId: "reference",
    score,
    scorePerMappedResidue: score / Math.max(1, mappedResidues),
    identity: identities / Math.max(1, mappedResidues),
    chainCoverage: mappedResidues / Math.max(1, columns),
    coverage: mappedResidues / Math.max(1, rows),
    mappedResidues,
    gapFraction: gaps / Math.max(1, profileIndices.length),
    positiveMatchFraction: positivePairs / Math.max(1, mappedResidues),
    longestUngappedRun,
    longestPositiveRun,
    siteToResidue,
    profileIndices: Int32Array.from(profileIndices),
    residueIndices: Int32Array.from(referenceIndices),
    alignedProfile: alignedProfile.join(""),
    alignedChain: alignedReference.join(""),
    matchLine: matchLine.join(""),
  };
}
