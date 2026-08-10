import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DifFubarVisualizations } from "../src/components/DifFubarVisualizations.js";
import type { DifFubarRunResult } from "../src/types.js";

test("DifFUBAR result studio renders a native SVG overview and export control", () => {
  const result: DifFubarRunResult = {
    sites: [{
      site: 1,
      pOmega1Greater: 0.98,
      pOmega2Greater: 0.01,
      pOmega1Positive: 0.97,
      pOmega2Positive: 0.1,
      meanAlpha: 0.5,
      meanOmega1: 2.2,
      meanOmega2: 0.4,
    }],
    detectedSites: [1],
    posteriorMarginals: {
      siteCount: 1,
      alphaValues: Float64Array.of(0.01, 1, 2),
      omegaValues: Float64Array.of(0.01, 1, 2),
      alpha: Float32Array.of(0.1, 0.8, 0.1),
      omega1: Float32Array.of(0.05, 0.15, 0.8),
      omega2: Float32Array.of(0.8, 0.15, 0.05),
    },
    backend: "wasm",
    timings: { totalMs: 12 },
    diagnostics: { taxa: 4, codonSites: 1, categories: 27, treeRegisterNumber: 1, precision: "f64" },
    csv: "Codon Sites\n1\n",
  };
  const markup = renderToStaticMarkup(<DifFubarVisualizations result={result} threshold={0.95} onThresholdChange={() => undefined} />);
  assert.match(markup, /DifFUBAR figure studio/);
  assert.match(markup, /Posterior mean selection by codon/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /<svg/);
  assert.match(markup, /data-transient="true"/);
});
