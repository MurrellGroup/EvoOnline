export type StructureFormat = "pdb" | "mmcif";

export interface AminoAcidProfileColumn {
  readonly site: number;
  readonly frequencies: Float32Array;
  readonly consensus: string;
  readonly validCount: number;
  readonly missingCount: number;
}

export interface AminoAcidProfile {
  readonly columns: readonly AminoAcidProfileColumn[];
  readonly sequenceCount: number;
}

export interface StructureResidue {
  readonly chainId: string;
  readonly authChainId: string;
  readonly labelSeqId?: number;
  readonly authSeqId: number;
  readonly insertionCode: string;
  readonly compId: string;
  readonly aminoAcid: string;
}

export interface StructureChain {
  readonly id: string;
  readonly label: string;
  readonly residues: readonly StructureResidue[];
  readonly sequence: string;
}

export interface ProfileAlignment {
  readonly chainId: string;
  readonly score: number;
  readonly scorePerMappedResidue: number;
  readonly identity: number;
  /** Fraction of the structure chain covered by paired alignment columns. */
  readonly chainCoverage: number;
  readonly coverage: number;
  readonly mappedResidues: number;
  readonly gapFraction: number;
  /** Paired columns whose profile-weighted BLOSUM62 score is positive. */
  readonly positiveMatchFraction: number;
  readonly longestUngappedRun: number;
  readonly longestPositiveRun: number;
  readonly siteToResidue: Int32Array;
  /** Profile-column index for every local-alignment column, or -1 for a gap in the profile. */
  readonly profileIndices: Int32Array;
  /** Chain-residue index for every local-alignment column, or -1 for a gap in the structure chain. */
  readonly residueIndices: Int32Array;
  readonly alignedProfile: string;
  readonly alignedChain: string;
  readonly matchLine: string;
}

export type StructureChainMode = "mapped" | "context" | "hidden";
export type StructureRepresentationKind = "cartoon" | "atoms" | "surface";

export interface StructureRepresentations {
  readonly cartoon: boolean;
  readonly atoms: boolean;
  readonly surface: boolean;
  readonly surfaceOpacity: number;
}

export interface StructureChainView {
  readonly chain: StructureChain;
  readonly alignment: ProfileAlignment;
  readonly mode: Exclude<StructureChainMode, "hidden">;
  readonly representations: StructureRepresentations;
}

export type SelectionDirection = "positive" | "purifying" | "g1" | "g2" | "none";

export interface StructureSiteDatum {
  readonly site: number;
  readonly detected: boolean;
  readonly direction: SelectionDirection;
  readonly values: Readonly<Record<string, number>>;
}

export interface StructureColorMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly color: (site: StructureSiteDatum) => string;
  readonly valueLabel: (site: StructureSiteDatum) => string;
  readonly legend: readonly { readonly color: string; readonly label: string }[];
}

export interface StructureMappingWorkerResult {
  readonly profile: AminoAcidProfile;
  readonly chains: readonly StructureChain[];
  readonly alignments: readonly ProfileAlignment[];
}

export interface StructureMappingWorkerRequest {
  readonly type: "map";
  readonly id: string;
  readonly alignmentText: string;
  readonly structureText: string;
  readonly format: StructureFormat;
}

export type StructureMappingWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly message: string; readonly current?: number; readonly total?: number }
  | { readonly type: "result"; readonly id: string; readonly result: StructureMappingWorkerResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };
