import type { MosaicSprAnalysisResult } from "./types.js";

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function mosaicSprEventsToCsv(result: Pick<MosaicSprAnalysisResult, "reconstruction">): string {
  const header = ["Breakpoint after site", "From state", "To state", "SPR distance", "Edit step", "Pruned taxa", "Source split", "Source attachment", "Regraft destination", "Shortest scripts"];
  const rows = result.reconstruction.events.flatMap((event) => event.edits.map((edit, index) => [
    event.breakpoint,
    edit.fromStateId,
    edit.toStateId,
    event.sprDistance,
    edit.step,
    quote(edit.prunedTaxa.join("; ")),
    quote(edit.sourceSplit.join("; ")),
    quote(edit.sourceAttachmentSplit.join("; ")),
    quote(edit.destinationSplit.join("; ")),
    index === 0 ? `${event.alternativeShortestScripts}${event.alternativesCapped ? "+" : ""}` : "",
  ].join(",")));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}
