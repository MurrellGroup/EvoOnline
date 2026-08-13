import { treeBankWindows, treeFamilyWindows } from "@phylo-workbench/model-fsart/browser-source";
import type { MosaicSprBreakpointProposal, MosaicSprTreeWindow } from "./types.js";

/**
 * Proposal regions only seed topology-space search. They are not fixed as the
 * final breakpoints. The constant-size overlap bank protects against a missed
 * triplet peak, while FSART's segment/pair/triplet windows exploit good peaks.
 */
export function mosaicSprTreeWindows(
  proposals: readonly MosaicSprBreakpointProposal[],
  sites: number,
  minimumTreeSpan: number,
  includeOverlapWindows = true,
): MosaicSprTreeWindow[] {
  const byRange = new Map<string, MosaicSprTreeWindow>();
  for (const window of treeFamilyWindows(proposals.map((proposal) => proposal.breakpoint), sites, minimumTreeSpan)) {
    byRange.set(`${window.start}:${window.end}`, { id: window.id, kind: window.kind, start: window.start, end: window.end });
  }
  if (includeOverlapWindows) {
    let index = 0;
    for (const window of treeBankWindows(sites, minimumTreeSpan)) {
      const key = `${window.start}:${window.end}`;
      if (byRange.has(key)) continue;
      index += 1;
      byRange.set(key, { id: `W${index}`, kind: "window", start: window.start, end: window.end });
    }
  }
  return Array.from(byRange.values()).sort((first, second) => {
    const firstGlobal = first.start === 1 && first.end === sites ? 0 : 1;
    const secondGlobal = second.start === 1 && second.end === sites ? 0 : 1;
    return firstGlobal - secondGlobal || first.start - second.start || first.end - second.end;
  });
}
