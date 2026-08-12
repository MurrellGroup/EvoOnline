/// <reference lib="webworker" />

import { buildAminoAcidProfile } from "../structure-mapping/sequence-profile.js";
import { alignProfileToReference } from "./reference-align.js";
import { parseReferenceSequence } from "./reference-sequence.js";
import type { ReferenceAlignmentWorkerRequest, ReferenceAlignmentWorkerResponse } from "./types.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function send(message: ReferenceAlignmentWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = (event: MessageEvent<ReferenceAlignmentWorkerRequest>): void => {
  const request = event.data;
  if (request.type !== "align") return;
  try {
    send({ type: "progress", id: request.id, message: "Translating the codon alignment into an amino-acid profile…" });
    const profile = buildAminoAcidProfile(request.alignmentText, request.geneticCodeId);
    send({ type: "progress", id: request.id, message: "Reading and translating the reference sequence…" });
    const reference = parseReferenceSequence(request.referenceText, request.fallbackName, request.referenceKind, request.geneticCodeId);
    send({ type: "progress", id: request.id, message: `Globally profile-aligning ${reference.sequence.length.toLocaleString()} reference residues…` });
    const alignment = alignProfileToReference(profile, reference.sequence);
    const transfer = new Set<Transferable>();
    for (const column of profile.columns) transfer.add(column.frequencies.buffer);
    transfer.add(alignment.siteToResidue.buffer);
    transfer.add(alignment.profileIndices.buffer);
    transfer.add(alignment.residueIndices.buffer);
    send({ type: "result", id: request.id, result: { profile, reference, alignment } }, Array.from(transfer));
  } catch (error) {
    send({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
