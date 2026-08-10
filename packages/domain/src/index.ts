export type ArtifactKind = "alignment" | "tree" | "selection" | "result";

export interface ArtifactBase {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface FastaRecord {
  readonly name: string;
  readonly description: string;
  readonly sequence: string;
}

export interface AlignmentArtifact extends ArtifactBase {
  readonly kind: "alignment";
  readonly text: string;
  readonly records: readonly FastaRecord[];
  readonly taxa: number;
  readonly sites: number;
  readonly aligned: boolean;
  readonly divisibleByThree: boolean;
  readonly alphabet: "nucleotide" | "amino-acid" | "mixed";
}

export interface TreeArtifact extends ArtifactBase {
  readonly kind: "tree";
  readonly text: string;
  readonly tags: readonly string[];
  readonly source: "upload" | "fasttree" | "editor";
}

export interface PhyloWorkspaceSnapshot {
  readonly alignment?: AlignmentArtifact;
  readonly tree?: TreeArtifact;
}

export class ArtifactParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArtifactParseError";
  }
}

export function parseFastaRecords(text: string): readonly FastaRecord[] {
  const records: FastaRecord[] = [];
  let header: string | undefined;
  let chunks: string[] = [];

  const flush = (): void => {
    if (header === undefined) return;
    const [name = "", ...description] = header.trim().split(/\s+/);
    const sequence = chunks.join("").replaceAll(/\s+/g, "").toUpperCase();
    if (name.length === 0) throw new ArtifactParseError("EMPTY_NAME", "A FASTA record has an empty identifier.");
    if (sequence.length === 0) throw new ArtifactParseError("EMPTY_SEQUENCE", `Sequence '${name}' is empty.`);
    records.push({ name, description: description.join(" "), sequence });
    chunks = [];
  };

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      flush();
      header = line.slice(1);
    } else {
      if (header === undefined) throw new ArtifactParseError("INVALID_FASTA", "Sequence data appears before the first FASTA header.");
      chunks.push(line);
    }
  }
  flush();
  if (records.length < 2) throw new ArtifactParseError("TOO_FEW_SEQUENCES", "Load at least two FASTA sequences.");
  const names = new Set<string>();
  for (const record of records) {
    if (names.has(record.name)) throw new ArtifactParseError("DUPLICATE_NAME", `Duplicate FASTA identifier '${record.name}'.`);
    names.add(record.name);
  }
  return records;
}

function inferAlphabet(records: readonly FastaRecord[]): AlignmentArtifact["alphabet"] {
  const characters = records.map((record) => record.sequence).join("").replaceAll(/[-?.]/g, "");
  if (/^[ACGTURYSWKMBDHVN]*$/i.test(characters)) return "nucleotide";
  if (/^[ABCDEFGHIKLMNPQRSTVWXYZ*OUJ]*$/i.test(characters)) return "amino-acid";
  return "mixed";
}

export function writeFastaRecords(records: readonly FastaRecord[], lineWidth = 80): string {
  return `${records.map((record) => {
    const lines: string[] = [];
    for (let offset = 0; offset < record.sequence.length; offset += lineWidth) {
      lines.push(record.sequence.slice(offset, offset + lineWidth));
    }
    return `>${record.name}${record.description.length > 0 ? ` ${record.description}` : ""}\n${lines.join("\n")}`;
  }).join("\n")}\n`;
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAlignmentArtifact(name: string, text: string): Promise<AlignmentArtifact> {
  const records = parseFastaRecords(text);
  // Model/tree identity is the first FASTA token. Keep descriptions as metadata,
  // but omit them from the canonical text passed to viewers and tree builders.
  const normalizedText = writeFastaRecords(records.map((record) => ({ ...record, description: "" })));
  const sha256 = await sha256Text(normalizedText);
  const firstLength = records[0]?.sequence.length ?? 0;
  const aligned = records.every((record) => record.sequence.length === firstLength);
  return {
    id: `alignment-${sha256.slice(0, 16)}`,
    kind: "alignment",
    name,
    sha256,
    createdAt: new Date().toISOString(),
    text: normalizedText,
    records,
    taxa: records.length,
    sites: aligned ? firstLength : Math.max(...records.map((record) => record.sequence.length)),
    aligned,
    divisibleByThree: aligned && firstLength % 3 === 0,
    alphabet: inferAlphabet(records),
  };
}

export function extractNewickTags(text: string): readonly string[] {
  return [...new Set([...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "").filter(Boolean))].sort();
}

export async function createTreeArtifact(
  name: string,
  text: string,
  source: TreeArtifact["source"],
): Promise<TreeArtifact> {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  if (!normalized.includes("(") || !normalized.includes(")")) {
    throw new ArtifactParseError("INVALID_TREE", "The tree does not look like Newick or NEXUS data.");
  }
  const sha256 = await sha256Text(normalized);
  return {
    id: `tree-${sha256.slice(0, 16)}`,
    kind: "tree",
    name,
    sha256,
    createdAt: new Date().toISOString(),
    text: normalized,
    tags: extractNewickTags(normalized),
    source,
  };
}
