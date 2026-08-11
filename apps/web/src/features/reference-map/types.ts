import type { AminoAcidProfile, ProfileAlignment } from "../structure-mapping/types.js";

export type ReferenceSequenceKind = "auto" | "protein" | "nucleotide";
export type ParsedReferenceSequenceKind = Exclude<ReferenceSequenceKind, "auto">;

export interface ParsedReferenceSequence {
  readonly name: string;
  readonly sequence: string;
  readonly kind: ParsedReferenceSequenceKind;
  readonly sourceLength: number;
}

export interface ReferenceHypothesis {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly color: string;
}

export interface ReferenceEvidenceSite {
  readonly site: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ReferenceAlignmentResult {
  readonly profile: AminoAcidProfile;
  readonly reference: ParsedReferenceSequence;
  readonly alignment: ProfileAlignment;
}

export interface ReferenceAlignmentWorkerRequest {
  readonly type: "align";
  readonly id: string;
  readonly alignmentText: string;
  readonly referenceText: string;
  readonly fallbackName: string;
  readonly referenceKind: ReferenceSequenceKind;
}

export type ReferenceAlignmentWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly message: string }
  | { readonly type: "result"; readonly id: string; readonly result: ReferenceAlignmentResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export interface ReferenceMapColumn {
  readonly alignmentIndex: number;
  readonly profileIndex: number;
  readonly profileSite?: number;
  readonly referenceIndex: number;
  readonly coordinateLabel?: string;
  readonly referenceNumber?: number;
  readonly insertionOrdinal?: number;
}

export interface ReferenceDetectionMark {
  readonly site: number;
  readonly alignmentIndex: number;
  readonly coordinateLabel: string;
  readonly hypothesisId: string;
  readonly probability: number;
}
