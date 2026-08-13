import { parseFsartFasta } from "@phylo-workbench/model-fsart/browser-source";
import type { MosaicSprAlignment } from "./types.js";

/** MosaicSPR deliberately reuses the audited nucleotide parser/bit planes. */
export function parseMosaicSprFasta(text: string): MosaicSprAlignment {
  try {
    return parseFsartFasta(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll("FSART", "MosaicSPR"));
  }
}
