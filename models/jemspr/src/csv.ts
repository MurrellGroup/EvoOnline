import type { JemsprAnalysisResult } from "./types.js";

const quote = (value: string): string => /[",\n\t]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function jemsprEventsCsv(result: Pick<JemsprAnalysisResult, "network">): string {
  const templates = new Map(result.network.templates.map((template) => [template.id, template]));
  const header = ["Occurrence", "Template", "Start", "End", "Left censored", "Right censored", "Maximum overlap", "Opening gap", "Closing gap", "Opening interval low", "Opening interval high", "Closing interval low", "Closing interval high", "Pruned taxa", "Source sibling", "Destination taxa", "Destination is root"];
  const rows = result.network.occurrences.map((occurrence) => {
    const template = templates.get(occurrence.templateId)!;
    return [occurrence.id, occurrence.templateId, occurrence.start, occurrence.end, occurrence.leftCensored, occurrence.rightCensored, occurrence.maximumConcurrentEvents, occurrence.openingGap, occurrence.closingGap, occurrence.openingIntervalLow, occurrence.openingIntervalHigh, occurrence.closingIntervalLow, occurrence.closingIntervalHigh, quote(template.move.prunedTaxa.join("; ")), quote(template.move.sourceSiblingTaxa.join("; ")), quote(template.move.destinationTaxa.join("; ")), template.move.destinationIsRoot].join(",");
  });
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function jemsprLocalTreesTsv(result: Pick<JemsprAnalysisResult, "network">): string {
  const trees = new Map(result.network.trees.map((tree) => [tree.id, tree]));
  const rows = result.network.runs.map((run) => [run.start, run.end, run.treeId, run.mask, run.activeTemplateIds.join(";"), run.dataParsimony, trees.get(run.treeId)?.tree ?? ""].join("\t"));
  return `left\tright\ttree_id\tmask\tactive_templates\tparsimony\tnewick\n${rows.join("\n")}\n`;
}

export function jemsprBreakpointsTsv(result: Pick<JemsprAnalysisResult, "network">): string {
  const bySite = new Map(result.network.breakpointGaps.map((entry) => [entry.afterSite, entry]));
  const rows = result.network.runs.slice(1).map((run) => {
    const gap = bySite.get(run.start - 1);
    return [run.start - 1, gap?.intervalLow ?? run.start - 1, gap?.intervalHigh ?? run.start - 1, gap?.gap ?? 0, run.mask, run.activeTemplateIds.join(";")].join("\t");
  });
  return `after_site\tinterval_low\tinterval_high\tmin_marginal_gap\tnew_mask\tactive_templates\n${rows.join("\n")}\n`;
}
