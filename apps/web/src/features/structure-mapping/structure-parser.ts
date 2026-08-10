import type { StructureChain, StructureFormat, StructureResidue } from "./types.js";

const THREE_TO_ONE: Readonly<Record<string, string>> = Object.freeze({
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  ASX: "N", GLX: "Q", MSE: "M", SEC: "C", PYL: "K", SEP: "S", TPO: "T", PTR: "Y", HYP: "P", CYX: "C",
});

function normalizeCifValue(value: string | undefined): string {
  return value === undefined || value === "." || value === "?" ? "" : value;
}

function buildChains(residues: readonly StructureResidue[]): readonly StructureChain[] {
  const grouped = new Map<string, StructureResidue[]>();
  for (const residue of residues) {
    const id = `${residue.chainId}\u0000${residue.authChainId}`;
    const chain = grouped.get(id);
    if (chain === undefined) grouped.set(id, [residue]);
    else chain.push(residue);
  }
  return Array.from(grouped, ([_groupKey, chainResidues]) => {
    const first = chainResidues[0]!;
    const label = first.authChainId || first.chainId || "(blank)";
    const id = `${encodeURIComponent(first.chainId)}::${encodeURIComponent(first.authChainId)}`;
    return { id, label, residues: chainResidues, sequence: chainResidues.map((residue) => residue.aminoAcid).join("") };
  }).filter((chain) => chain.residues.length > 0);
}

export function parsePdbChains(text: string): readonly StructureChain[] {
  const residues: StructureResidue[] = [];
  const seen = new Set<string>();
  let firstModel: number | undefined;
  let activeModel: number | undefined;
  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    lineStart = lineEnd + 1;
    const record = line.slice(0, 6).trim();
    if (record === "MODEL") {
      activeModel = Number.parseInt(line.slice(10, 14).trim(), 10);
      if (firstModel === undefined) firstModel = activeModel;
      continue;
    }
    if (record === "ENDMDL" && firstModel !== undefined && activeModel === firstModel) break;
    if (record !== "ATOM" && record !== "HETATM") continue;
    if (firstModel !== undefined && activeModel !== firstModel) continue;
    const alternate = line.slice(16, 17).trim();
    if (alternate !== "" && alternate !== "A" && alternate !== "1") continue;
    const compId = line.slice(17, 20).trim().toUpperCase();
    const aminoAcid = THREE_TO_ONE[compId];
    if (aminoAcid === undefined) continue;
    const authChainId = line.slice(21, 22).trim();
    const authSeqId = Number.parseInt(line.slice(22, 26).trim(), 10);
    if (!Number.isFinite(authSeqId)) continue;
    const insertionCode = line.slice(26, 27).trim();
    const key = `${authChainId}\u0000${authSeqId}\u0000${insertionCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    residues.push({ chainId: authChainId, authChainId, authSeqId, insertionCode, compId, aminoAcid });
  }
  return buildChains(residues);
}

function isCifWhitespace(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code <= 32 || code === 127;
}

function* cifTokens(text: string): Generator<string> {
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isCifWhitespace(text[index])) index += 1;
    if (index >= text.length) return;
    if (text[index] === "#") {
      const newline = text.indexOf("\n", index + 1);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text[index] === ";" && (index === 0 || text[index - 1] === "\n")) {
      const start = index + 1;
      let end = text.indexOf("\n;", start);
      if (end < 0) end = text.length;
      yield text.slice(start, end).replace(/^\r?\n/, "");
      index = end >= text.length ? end : end + 2;
      continue;
    }
    const quote = text[index] === "'" || text[index] === '"' ? text[index] : undefined;
    if (quote !== undefined) {
      const start = ++index;
      while (index < text.length) {
        if (text[index] === quote && (index + 1 === text.length || isCifWhitespace(text[index + 1]))) break;
        index += 1;
      }
      yield text.slice(start, index);
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && !isCifWhitespace(text[index])) index += 1;
    yield text.slice(start, index);
  }
}

function isControlToken(token: string): boolean {
  const lower = token.toLowerCase();
  return token.startsWith("_") || lower === "loop_" || lower === "stop_" || lower.startsWith("data_") || lower.startsWith("save_");
}

export function parseMmcifChains(text: string): readonly StructureChain[] {
  const iterator = cifTokens(text);
  let pending: string | undefined;
  const read = (): string | undefined => {
    if (pending !== undefined) {
      const value = pending;
      pending = undefined;
      return value;
    }
    return iterator.next().value as string | undefined;
  };

  for (let token = read(); token !== undefined; token = read()) {
    if (token.toLowerCase() !== "loop_") continue;
    const headers: string[] = [];
    let value = read();
    while (value !== undefined && value.startsWith("_")) {
      headers.push(value.toLowerCase());
      value = read();
    }
    const atomSite = headers.some((header) => header.startsWith("_atom_site."));
    const field = atomSite ? new Map(headers.map((header, index) => [header, index])) : undefined;
    const residues: StructureResidue[] = [];
    const seen = new Set<string>();
    let firstModel = "";
    const processAtomRow = (rowValues: readonly string[]): void => {
      if (field === undefined) return;
      const at = (name: string): string => normalizeCifValue(rowValues[field.get(`_atom_site.${name}`) ?? -1]);
      const group = at("group_pdb").toUpperCase();
      if (group !== "ATOM" && group !== "HETATM") return;
      const model = at("pdbx_pdb_model_num") || "1";
      if (firstModel === "") firstModel = model;
      if (model !== firstModel) return;
      const alternate = at("label_alt_id");
      if (alternate !== "" && alternate !== "A" && alternate !== "1") return;
      const compId = (at("label_comp_id") || at("auth_comp_id")).toUpperCase();
      const aminoAcid = THREE_TO_ONE[compId];
      if (aminoAcid === undefined) return;
      const chainId = at("label_asym_id") || at("auth_asym_id");
      const authChainId = at("auth_asym_id") || chainId;
      const labelSeqText = at("label_seq_id");
      const authSeqText = at("auth_seq_id") || labelSeqText;
      const labelSeqId = labelSeqText === "" ? undefined : Number.parseInt(labelSeqText, 10);
      const authSeqId = Number.parseInt(authSeqText, 10);
      if (!Number.isFinite(authSeqId)) return;
      const insertionCode = at("pdbx_pdb_ins_code");
      const key = `${chainId}\u0000${authChainId}\u0000${labelSeqId ?? ""}\u0000${authSeqId}\u0000${insertionCode}`;
      if (seen.has(key)) return;
      seen.add(key);
      residues.push({
        chainId,
        authChainId,
        ...(labelSeqId === undefined || !Number.isFinite(labelSeqId) ? {} : { labelSeqId }),
        authSeqId,
        insertionCode,
        compId,
        aminoAcid,
      });
    };
    let row: string[] = [];
    while (value !== undefined) {
      if (row.length === 0 && isControlToken(value)) {
        pending = value;
        break;
      }
      row.push(value);
      if (row.length === headers.length) {
        if (atomSite) processAtomRow(row);
        row = [];
      }
      value = read();
    }
    if (!atomSite) continue;
    return buildChains(residues);
  }
  return [];
}

export function detectStructureFormat(fileName: string, text: string): StructureFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".cif") || lower.endsWith(".mmcif")) return "mmcif";
  if (lower.endsWith(".pdb") || lower.endsWith(".ent")) return "pdb";
  return /^\s*(?:data_|_atom_site\.)/im.test(text) ? "mmcif" : "pdb";
}

export function parseStructureChains(text: string, format: StructureFormat): readonly StructureChain[] {
  const chains = format === "pdb" ? parsePdbChains(text) : parseMmcifChains(text);
  if (chains.length === 0) throw new Error("No coordinate-bearing protein chains were found in this structure.");
  return chains;
}
