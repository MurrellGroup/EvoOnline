import type { ProfileAlignment } from "../structure-mapping/types.js";
import type { ReferenceDetectionMark, ReferenceEvidenceSite, ReferenceMapColumn } from "./types.js";

export function insertionSuffix(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("Insertion ordinals begin at one.");
  let remaining = ordinal;
  let output = "";
  while (remaining > 0) {
    remaining -= 1;
    output = String.fromCharCode(65 + (remaining % 26)) + output;
    remaining = Math.floor(remaining / 26);
  }
  return output;
}

export function buildReferenceMapColumns(alignment: ProfileAlignment, referenceStart: number): readonly ReferenceMapColumn[] {
  const start = Math.trunc(referenceStart);
  let precedingReferenceNumber = start - 1;
  let insertionOrdinal = 0;
  return Array.from(alignment.profileIndices, (profileIndex, alignmentIndex) => {
    const referenceIndex = alignment.residueIndices[alignmentIndex]!;
    if (referenceIndex >= 0) {
      const referenceNumber = start + referenceIndex;
      precedingReferenceNumber = referenceNumber;
      insertionOrdinal = 0;
      return {
        alignmentIndex,
        profileIndex,
        ...(profileIndex < 0 ? {} : { profileSite: profileIndex + 1 }),
        referenceIndex,
        referenceNumber,
        coordinateLabel: String(referenceNumber),
      };
    }
    insertionOrdinal += 1;
    return {
      alignmentIndex,
      profileIndex,
      ...(profileIndex < 0 ? {} : { profileSite: profileIndex + 1 }),
      referenceIndex,
      coordinateLabel: `${precedingReferenceNumber}${insertionSuffix(insertionOrdinal)}`,
      insertionOrdinal,
    };
  });
}

export function buildReferenceDetectionMarks(
  columns: readonly ReferenceMapColumn[],
  evidenceSites: readonly ReferenceEvidenceSite[],
  selectedHypothesisIds: ReadonlySet<string>,
  threshold: number,
): readonly ReferenceDetectionMark[] {
  const evidenceBySite = new Map(evidenceSites.map((site) => [site.site, site]));
  const marks: ReferenceDetectionMark[] = [];
  for (const column of columns) {
    if (column.profileSite === undefined || column.coordinateLabel === undefined) continue;
    const evidence = evidenceBySite.get(column.profileSite);
    if (evidence === undefined) continue;
    for (const hypothesisId of selectedHypothesisIds) {
      const probability = evidence.probabilities[hypothesisId];
      if (probability !== undefined && probability > threshold) marks.push({
        site: column.profileSite,
        alignmentIndex: column.alignmentIndex,
        coordinateLabel: column.coordinateLabel,
        hypothesisId,
        probability,
      });
    }
  }
  return marks;
}
