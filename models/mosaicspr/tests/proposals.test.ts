import assert from "node:assert/strict";
import test from "node:test";
import { parseMosaicSprFasta } from "../src/alignment.js";
import { proposeMosaicSprBreakpoints } from "../src/proposals.js";
import { mosaicSprTreeWindows } from "../src/windows.js";

test("disabled triplet proposals still produce an independent overlapping topology seed bank", () => {
  const sequence = "A".repeat(99) + "C";
  const alignment = parseMosaicSprFasta(`>a\n${sequence}\n>b\n${"A".repeat(100)}\n>c\n${"C".repeat(100)}\n>d\n${"G".repeat(100)}\n`);
  const proposal = proposeMosaicSprBreakpoints(alignment, { enabled: false, minimumSegmentLength: 20 });
  assert.deepEqual(proposal.proposals, []);
  assert.equal(proposal.diagnostics.source, "overlap-only");
  const windows = mosaicSprTreeWindows(proposal.proposals, alignment.sites, proposal.diagnostics.minimumTreeSpan, true);
  assert.ok(windows.some((window) => window.kind === "global" && window.start === 1 && window.end === alignment.sites));
  assert.ok(windows.some((window) => window.kind === "window"));
});

test("proposal boundaries generate segment, adjacent-pair, and adjacent-triplet seeds without becoming constraints", () => {
  const proposals = [400, 800].map((breakpoint, index) => ({
    id: `BP${index + 1}`, rank: index + 1, breakpoint,
    intervalLow: breakpoint - 5, intervalHigh: breakpoint + 5,
    supportLow: breakpoint - 10, supportHigh: breakpoint + 10,
    consensusScore: 5, evidence: 3, supportTriplets: 4, supportTaxa: 6,
  }));
  const windows = mosaicSprTreeWindows(proposals, 1_200, 150, false);
  assert.equal(windows.filter((window) => window.kind === "segment").length, 3);
  assert.equal(windows.filter((window) => window.kind === "pair").length, 2);
  assert.equal(windows.filter((window) => window.kind === "triplet").length, 0, "the full three-segment span is represented once by GLOBAL");
  assert.equal(windows[0]?.kind, "global");
});
