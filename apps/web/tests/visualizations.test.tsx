import assert from "node:assert/strict";
import test from "node:test";
import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_LABELS,
  DifFubarVisualizations,
  PosteriorMarginalFigure,
} from "../src/components/DifFubarVisualizations.js";
import type { DifFubarRunResult } from "../src/types.js";
import { FubarVisualizations } from "../src/components/FubarVisualizations.js";
import { PhylogramFigure } from "../src/components/PhylogramFigure.js";
import type { FubarRunResult } from "../src/types.js";

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
    tree: "((a{G1}:0.1,b{G1}:0.1){G1}:0.1,(c{G2}:0.1,d{G2}:0.1){G2}:0.1);",
    csv: "Codon Sites\n1\n",
  };
  const markup = renderToStaticMarkup(<DifFubarVisualizations result={result} threshold={0.95} onThresholdChange={() => undefined} />);
  assert.match(markup, /DifFUBAR figure studio/);
  assert.match(markup, /Posterior mean selection by codon/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /<svg/);
  assert.match(markup, /data-transient="true"/);
});

test("tagged phylogram exposes branch colors, label controls, and SVG export", () => {
  const markup = renderToStaticMarkup(<PhylogramFigure newick="((a{G1}:0.1,b{G1}:0.1){G1}:0.1,(c{G2}:0.1,d{G2}:0.1){G2}:0.1);" tagged />);
  assert.match(markup, /Tagged input phylogeny/);
  assert.match(markup, /Tip labels/);
  assert.match(markup, /Label size/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /#ff4b4f/);
  assert.match(markup, /#4f46f5/);
});

test("FUBAR studio renders selection overview and site posterior products", () => {
  const result: FubarRunResult = {
    sites: [
      { site: 1, pPositive: 0.98, pPurifying: 0.01, meanAlpha: 0.3, meanBeta: 2.1, selection: "positive" },
      { site: 2, pPositive: 0.02, pPurifying: 0.97, meanAlpha: 2.2, meanBeta: 0.4, selection: "purifying" },
    ],
    positiveSites: [1],
    purifyingSites: [2],
    posterior: {
      siteCount: 2,
      gridSize: 2,
      gridValues: Float64Array.of(0.1, 2),
      surfaces: Float32Array.of(0.05, 0.85, 0.05, 0.05, 0.05, 0.05, 0.85, 0.05),
      alpha: Float32Array.of(0.9, 0.1, 0.1, 0.9),
      beta: Float32Array.of(0.1, 0.9, 0.9, 0.1),
    },
    backend: "wasm-parallel",
    timings: { totalMs: 25 },
    diagnostics: {
      taxa: 4,
      codonSites: 2,
      categories: 4,
      treeRegisterNumber: 2,
      precision: "f64",
      inferenceMethod: "dirichlet-em",
      inferenceIterations: 14,
      inferenceBurnin: 0,
      inferenceLogLikelihood: -2.3,
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n2\n",
  };
  const markup = renderToStaticMarkup(<FubarVisualizations result={result} threshold={0.95} onThresholdChange={() => undefined} showPositive showPurifying />);
  assert.match(markup, /FUBAR figure studio/);
  assert.match(markup, /positive and purifying selection/i);
  assert.match(markup, /Posterior surface/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /mean α/);
});

test("posterior marginals render Julia-style alpha and omega probability-mass lanes", () => {
  const sites = [
    {
      site: 1,
      pOmega1Greater: 0.99,
      pOmega2Greater: 0.01,
      pOmega1Positive: 0.98,
      pOmega2Positive: 0.02,
      meanAlpha: 0.6,
      meanOmega1: 2.1,
      meanOmega2: 0.4,
    },
    {
      site: 2,
      pOmega1Greater: 0.02,
      pOmega2Greater: 0.98,
      pOmega1Positive: 0.03,
      pOmega2Positive: 0.97,
      meanAlpha: 1.1,
      meanOmega1: 0.3,
      meanOmega2: 2.4,
    },
  ] as const;
  const marginals = {
    siteCount: 2,
    alphaValues: Float64Array.of(0.01, 0.2, 1, 4),
    omegaValues: Float64Array.of(0.01, 0.2, 1, 4),
    alpha: Float32Array.of(0.05, 0.8, 0.1, 0.05, 0.1, 0.2, 0.6, 0.1),
    omega1: Float32Array.of(0.05, 0.1, 0.25, 0.6, 0.7, 0.2, 0.08, 0.02),
    omega2: Float32Array.of(0.65, 0.2, 0.1, 0.05, 0.03, 0.07, 0.2, 0.7),
  } as const;
  const markup = renderToStaticMarkup(
    <PosteriorMarginalFigure
      sites={sites}
      threshold={0.95}
      labels={DEFAULT_LABELS}
      onSelectSite={() => undefined}
      svgRef={createRef<SVGSVGElement>()}
      marginals={marginals}
    />,
  );
  const group = (series: string): string => {
    const match = markup.match(new RegExp(`<g data-series="${series}"[\\s\\S]*?<\\/g>`));
    assert.ok(match !== null, `missing ${series} marginal group`);
    return match[0];
  };
  const mark = (series: string, site: number, bin: number): { baseline: number; height: number } => {
    const match = group(series).match(new RegExp(`<rect[^>]*data-site="${site}"[^>]*data-bin="${bin}"[^>]*data-baseline="([^"]+)"[^>]*height="([^"]+)"`));
    assert.ok(match !== null, `missing ${series} mark for site ${site}, bin ${bin}`);
    return { baseline: Number(match[1]), height: Number(match[2]) };
  };

  for (const series of ["alpha", "omega1", "omega2"]) {
    assert.equal((group(series).match(/<rect/g) ?? []).length, 8);
  }
  assert.match(markup, /viewBox="0 0 520 /);
  assert.match(markup, /data-layout="paper-portrait"/);
  assert.match(markup, /data-bin-occupancy="0.8"/);
  assert.match(markup, /style="[^"]*width:520px/);
  assert.match(markup, /min-width:520px/);
  const alpha = mark("alpha", 1, 1);
  const alphaTail = mark("alpha", 1, 0);
  const omega1 = mark("omega1", 1, 1);
  const omega2 = mark("omega2", 1, 1);
  assert.ok(alpha.baseline < omega1.baseline, "alpha must sit above the omega lane");
  assert.equal(omega1.baseline, omega2.baseline, "the two omega marginals share the Julia baseline");
  assert.ok(alpha.height > alphaTail.height * 10, "posterior mass must control local bar thickness");
  assert.match(markup, /Rectangle thickness is proportional to posterior probability/);
});
