/// <reference lib="webworker" />

import { alignProfileToChain, buildProfileSubstitutionScores } from "./profile-align.js";
import { buildAminoAcidProfile } from "./sequence-profile.js";
import { parseStructureChains } from "./structure-parser.js";
import type { ProfileAlignment, StructureMappingWorkerRequest, StructureMappingWorkerResponse } from "./types.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function send(message: StructureMappingWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = (event: MessageEvent<StructureMappingWorkerRequest>): void => {
  const request = event.data;
  if (request.type !== "map") return;
  try {
    send({ type: "progress", id: request.id, message: "Translating the codon alignment into an amino-acid profile…" });
    const profile = buildAminoAcidProfile(request.alignmentText);
    send({ type: "progress", id: request.id, message: "Reading coordinate-bearing protein chains…" });
    const chains = parseStructureChains(request.structureText, request.format);
    const alignments: ProfileAlignment[] = [];
    const substitutionScores = buildProfileSubstitutionScores(profile);
    const sequenceGroups = new Map<string, typeof chains>();
    for (const chain of chains) sequenceGroups.set(chain.sequence, [...(sequenceGroups.get(chain.sequence) ?? []), chain]);
    const uniqueSequences = Array.from(sequenceGroups.values());
    for (let index = 0; index < uniqueSequences.length; index += 1) {
      const equivalentChains = uniqueSequences[index]!;
      const representative = equivalentChains[0]!;
      send({
        type: "progress",
        id: request.id,
        message: `Profile-aligning chain ${representative.label}${equivalentChains.length > 1 ? ` and ${equivalentChains.length - 1} sequence-identical chain${equivalentChains.length === 2 ? "" : "s"}` : ""}…`,
        current: index + 1,
        total: uniqueSequences.length,
      });
      const template = alignProfileToChain(profile, representative, -10, -1, substitutionScores);
      for (const chain of equivalentChains) alignments.push({ ...template, chainId: chain.id });
    }
    alignments.sort((left, right) => right.score - left.score || right.mappedResidues - left.mappedResidues);
    const transfer = new Set<Transferable>();
    for (const column of profile.columns) transfer.add(column.frequencies.buffer);
    for (const alignment of alignments) transfer.add(alignment.siteToResidue.buffer);
    send({ type: "result", id: request.id, result: { profile, chains, alignments } }, Array.from(transfer));
  } catch (error) {
    send({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
