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
import { ApproximateFelResults, approximateFelCall } from "../src/components/ApproximateFelResults.js";
import { normalizeCommittedNumberDraft } from "../src/components/CommittedNumberInput.js";
import { BsrelResultsView } from "../src/components/BsrelResultsView.js";
import type { BsrelRunResult } from "../src/types.js";
import { BameVisualizations } from "../src/components/BameVisualizations.js";
import type { FameRunResult, FlavorRunResult } from "../src/types.js";
import { GlobalGammaResultsView } from "../src/components/GlobalGammaResultsView.js";
import type { GlobalGammaRunResult } from "../src/types.js";
import { CladeShiftResultsView } from "../src/components/CladeShiftResultsView.js";
import type { CladeShiftRunResult } from "../src/types.js";

test("deferred number fields accept replacement text and validate only when committed", () => {
  assert.equal(normalizeCommittedNumberDraft("", 17, 1, 100), 17);
  assert.equal(normalizeCommittedNumberDraft("42", 17, 1, 100), 42);
  assert.equal(normalizeCommittedNumberDraft("999", 17, 1, 100), 100);
  assert.equal(normalizeCommittedNumberDraft("4.9", 17, 1, 100), 4);
});

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

test("BS-REL renders a fitted branch-length phylogram, branch metrics, and SVG export", () => {
  const makeBranch = (branch: number, nodeId: number, name: string, terminal: boolean, p: number): BsrelRunResult["branches"][number] => ({
    branch, nodeId, nodeIndex: nodeId, name, parentName: "Root", terminal, tested: true,
    inputLength: 0.1, fittedLength: 0.08 + branch * 0.01,
    omegaMinus: 0.1, weightMinus: 0.7, omegaNeutral: 0.8, weightNeutral: 0.2,
    omegaPositive: 4.2, weightPositive: 0.1, meanOmega: 0.65,
    nullLogLikelihood: -120, likelihoodRatio: 7.2, pValue: p / 2, pValueHolm: p, significant: p <= 0.05,
  });
  const result: BsrelRunResult = {
    branches: [makeBranch(1, 1, "N", false, 0.01), makeBranch(2, 2, "a", true, 0.02), makeBranch(3, 3, "b", true, 0.4), makeBranch(4, 4, "c", true, 0.8)],
    alternativeLogLikelihood: -116.4,
    backend: "wasm-parallel",
    timings: { totalMs: 1234 },
    diagnostics: {
      taxa: 3, codonSites: 100, branches: 4, testedBranches: 4, significantBranches: 2,
      alternativeIterations: 9, alternativeConverged: true, nullIterations: 8, maximumOmega: 1000,
      lrtCalibration: "0.50*chi2_0 + 0.05*chi2_1 + 0.45*chi2_2",
      multipleTesting: "Holm-Bonferroni", messageAlgorithm: "upward-downward-local-blanket", precision: "f64",
    },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3);",
    csv: "Branch,Name\n1,N\n",
  };
  const markup = renderToStaticMarkup(<BsrelResultsView result={result} threshold={0.05} />);
  assert.match(markup, /Fixed three-rate BS-REL/);
  assert.match(markup, /no AIC complexity selection/i);
  assert.match(markup, /Annotated fitted phylogeny/);
  assert.match(markup, /Holm p-value/);
  assert.match(markup, /Fitted branch length/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /cached two-sided local blanket/);
});

test("Glamma results link full/null evidence, activation evidence, sites, and tree posteriors", () => {
  const branches: GlobalGammaRunResult["branches"] = [
    { branch: 1, nodeId: 1, nodeIndex: 1, name: "N", parentName: "Root", terminal: false, branchLength: 0.2, cappedLogEvidence: 3.1, cappedEvidenceRatio: 22.2, activationLogBayesFactor: 2.8, activationBayesFactor: 16.4, activationPosteriorMean: 0.34, expectedPositiveSites: 1.2, anySitePositivePosterior: 0.72, anySitePositiveLogBayesFactor: 1.8, maximumSitePosterior: 0.84 },
    { branch: 2, nodeId: 2, nodeIndex: 2, name: "a", parentName: "N", terminal: true, branchLength: 0.1, cappedLogEvidence: 0.2, cappedEvidenceRatio: 1.22, activationLogBayesFactor: 0.1, activationBayesFactor: 1.1, activationPosteriorMean: 0.11, expectedPositiveSites: 0.3, anySitePositivePosterior: 0.25, anySitePositiveLogBayesFactor: 0.1, maximumSitePosterior: 0.22 },
    { branch: 3, nodeId: 3, nodeIndex: 3, name: "b", parentName: "N", terminal: true, branchLength: 0.1, cappedLogEvidence: -0.4, cappedEvidenceRatio: 0.67, activationLogBayesFactor: -0.2, activationBayesFactor: 0.82, activationPosteriorMean: 0.08, expectedPositiveSites: 0.2, anySitePositivePosterior: 0.18, anySitePositiveLogBayesFactor: -0.2, maximumSitePosterior: 0.16 },
    { branch: 4, nodeId: 4, nodeIndex: 4, name: "c", parentName: "Root", terminal: true, branchLength: 0.3, cappedLogEvidence: 1.1, cappedEvidenceRatio: 3, activationLogBayesFactor: 0.7, activationBayesFactor: 2, activationPosteriorMean: 0.17, expectedPositiveSites: 0.6, anySitePositivePosterior: 0.45, anySitePositiveLogBayesFactor: 0.5, maximumSitePosterior: 0.55 },
  ];
  const result: GlobalGammaRunResult = {
    method: "glamma",
    sites: [
      { site: 1, cappedLogEvidence: 2.1, cappedEvidenceRatio: 8.17, conditionalSupport: 0.891, expectedPositiveBranches: 1.4, maximumBranchPosterior: 0.84 },
      { site: 2, cappedLogEvidence: -0.3, cappedEvidenceRatio: 0.74, conditionalSupport: 0.426, expectedPositiveBranches: 0.3, maximumBranchPosterior: 0.22 },
    ],
    branches,
    fit: { omegaMean: 0.72, omegaShape: 0.8, alphaShape: 1.6, logLikelihood: -123.4 },
    omegaValues: Float64Array.of(0.1, 0.5, 1.4, 4),
    alphaValues: Float64Array.of(0.2, 0.8, 1.2, 1.8),
    positivePrior: 0.15,
    posterior: { siteCount: 2, branchCount: 4, tailPosterior: Float32Array.of(0.84, 0.1, 0.22, 0.08, 0.16, 0.06, 0.55, 0.06), localLogEvidence: Float32Array.of(2, 0.1, 0.2, 0, -0.1, -0.2, 0.8, 0.3) },
    backend: "wasm-parallel",
    timings: { totalMs: 2300 },
    diagnostics: {
      taxa: 3, codonSites: 2, branches: 4, omegaSlices: 4, alphaSlices: 4, fitPreset: "fast", coarseCandidates: 20, refinementCandidates: 9,
      activationPriorAlpha: 1, activationPriorBeta: 9, messageAlgorithm: "upward-downward-local-blanket", alphaModel: "mean-one-global-discrete-gamma",
      omegaModel: "global-discrete-gamma-iid-branch-site", evidenceCalibration: "plug-in-conditional-empirical-bayes", fitNumerics: "coarse-to-fine-grid-ml-julia-interpolation", finalNumerics: "direct-f64-uniformization",
    },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3);",
    siteCsv: "Codon site\n1\n",
    branchCsv: "Branch\n1\n",
  };
  const markup = renderToStaticMarkup(<GlobalGammaResultsView result={result} threshold={0.9} alignment=">a\nATGAAA\n>b\nATGAAG\n>c\nATGAAA\n" />);
  assert.match(markup, /Glamma/);
  assert.match(markup, /Full data range/);
  assert.match(markup, /Map selection onto a protein structure/);
  assert.match(markup, /same site-wise α is used on every edge/);
  assert.match(markup, /each edge independently integrates/);
  assert.match(markup, /Activation empirical BF/);
  assert.match(markup, /Full vs branch-null evidence/);
  assert.match(markup, /Selected-site tail posterior/);
  assert.match(markup, /Codon alignment evidence track/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 2);
});

test("CladeShift keeps its exploratory scan isolated while linking sites, clades, reference, and structure views", () => {
  const result: CladeShiftRunResult = {
    method: "clade-shift",
    sites: [
      { site: 1, pShift: 0.96, pRelaxation: 0.91, pIntensification: 0.05, logBayesFactor: 5.1, relaxationLogBayesFactor: 5.7, intensificationLogBayesFactor: -0.2, direction: "relaxation", detected: true, mapBranch: 1, mapBranchName: "N", mapBranchPosterior: 0.79, mapIntensity: 0.5, meanIntensityGivenShift: 0.57, capturedNullPosteriorMass: 0.97, baselineMeanAlpha: 0.8, baselineMeanBeta: 0.2 },
      { site: 2, pShift: 0.92, pRelaxation: 0.08, pIntensification: 0.84, logBayesFactor: 4.3, relaxationLogBayesFactor: -0.1, intensificationLogBayesFactor: 5, direction: "intensification", detected: true, mapBranch: 4, mapBranchName: "c", mapBranchPosterior: 0.68, mapIntensity: 2, meanIntensityGivenShift: 1.8, capturedNullPosteriorMass: 0.94, baselineMeanAlpha: 0.7, baselineMeanBeta: 1.4 },
    ],
    branches: [
      { branch: 1, nodeId: 1, nodeIndex: 1, name: "N", parentName: "root", terminal: false, descendantTips: 2, eligible: true, expectedShiftedSites: 0.8, expectedRelaxedSites: 0.75, expectedIntensifiedSites: 0.05, maximumSitePosterior: 0.79, mapSite: 1 },
      { branch: 2, nodeId: 2, nodeIndex: 2, name: "a", parentName: "N", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.1, expectedRelaxedSites: 0.08, expectedIntensifiedSites: 0.02, maximumSitePosterior: 0.07, mapSite: 1 },
      { branch: 3, nodeId: 3, nodeIndex: 3, name: "b", parentName: "N", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.1, expectedRelaxedSites: 0.07, expectedIntensifiedSites: 0.03, maximumSitePosterior: 0.06, mapSite: 1 },
      { branch: 4, nodeId: 4, nodeIndex: 4, name: "c", parentName: "root", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.7, expectedRelaxedSites: 0.04, expectedIntensifiedSites: 0.66, maximumSitePosterior: 0.68, mapSite: 2 },
    ],
    detectedSites: [1, 2],
    posterior: {
      siteCount: 2, branchCount: 4, intensities: Float64Array.of(0.5, 2),
      branchPosterior: Float32Array.of(0.79, 0.03, 0.07, 0.03, 0.06, 0.02, 0.04, 0.68),
      branchRelaxation: Float32Array.of(0.75, 0.02, 0.06, 0.01, 0.05, 0.01, 0.03, 0.02),
      branchIntensification: Float32Array.of(0.04, 0.01, 0.01, 0.02, 0.01, 0.01, 0.01, 0.66),
      intensityPosterior: Float32Array.of(0.91, 0.05, 0.08, 0.84),
    },
    intensities: Float64Array.of(0.5, 2),
    shiftPrior: 0.2,
    backend: "wasm-parallel",
    timings: { totalMs: 2100 },
    diagnostics: { taxa: 3, codonSites: 2, branches: 4, candidateClades: 4, gridPoints: 16, baselineCategories: 256, posteriorComponents: 18, meanPosteriorComponents: 15.5, posteriorMassTarget: 0.9, intensityStates: 2, intensityPreset: "fast", minimumDescendantTips: 1, minimumCapturedPosteriorMass: 0.94, meanCapturedPosteriorMass: 0.955, nullIntegration: "compressed-fubar-posterior-identity", cladeAlgorithm: "baseline-outside-plus-shifted-subtree-inside", evidenceCalibration: "fixed-prior-empirical-bayes", validatedMethod: false, precision: "f64" },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3)root;",
    siteCsv: "Codon site\n1\n2\n",
    branchCsv: "Branch\n1\n2\n3\n4\n",
  };
  const markup = renderToStaticMarkup(<CladeShiftResultsView result={result} threshold={0.9} alignment=">a\nATGAAA\n>b\nATGAAG\n>c\nATGAAA\n" />);
  assert.match(markup, /CladeShift/);
  assert.match(markup, /Exploratory and not simulation-validated/);
  assert.match(markup, /none is selected by an unpenalized maximum/);
  assert.match(markup, /Where did the persistent shift begin/);
  assert.match(markup, /Map selection onto a protein structure/);
  assert.match(markup, /Optional selection-on-profile visualization/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 2);
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

test("FAME studio exposes linked evidence, mass lanes, posterior projection, and SVG export", () => {
  const result: FameRunResult = {
    method: "fame",
    sites: [
      { site: 1, pPositive: 0.97, bayesFactor: 18, meanAlpha: 0.5, meanOmega1: 0.2, meanOmega2: 2.4, detected: true },
      { site: 2, pPositive: 0.1, bayesFactor: 0.2, meanAlpha: 1.2, meanOmega1: 0.4, meanOmega2: 0.7, detected: false },
    ],
    detectedSites: [1],
    posterior: {
      siteCount: 2,
      alphaValues: Float64Array.of(0.1, 2),
      omega1Values: Float64Array.of(0.1, 1),
      omega2Values: Float64Array.of(0.1, 3),
      surfaces: Float32Array.from({ length: 16 }, (_unused, index) => index % 8 === 7 ? 0.7 : 0.3 / 7),
      alpha: Float32Array.of(0.7, 0.3, 0.2, 0.8),
      omega1: Float32Array.of(0.8, 0.2, 0.6, 0.4),
      omega2: Float32Array.of(0.1, 0.9, 0.8, 0.2),
    },
    positivePrior: 0.2,
    backend: "wasm-parallel",
    timings: { totalMs: 1000 },
    diagnostics: {
      taxa: 4, codonSites: 2, categories: 8, branchMixtureOperators: 32, atomicOmegaModels: 4,
      treeRegisterNumber: 2, precision: "f64", inferenceMethod: "dirichlet-em", inferenceIterations: 10,
      inferenceBurnin: 0, inferenceLogLikelihood: -8, modelDraftCommit: "4c65c984", numericalEngine: "fused-sparse-or-dense-uniformization",
      weightIntegration: "likelihood-quadrature", weightPoints: 4, gridPreset: "fast",
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n2\n",
  };
  const markup = renderToStaticMarkup(<BameVisualizations result={result} threshold={0.9} onThresholdChange={() => undefined} />);
  assert.match(markup, /FAME figure studio/);
  assert.match(markup, /Parameter posteriors/);
  assert.match(markup, /Posterior projection/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /data-figure="bame-evidence-overview"/);
});

test("FLAVOR studio exposes capped-state projection controls and branch-omega CDF", () => {
  const result: FlavorRunResult = {
    method: "flavor",
    sites: [{
      site: 1, pPositive: 0.96, pUncapped: 0.98, bayesFactor: 22, meanAlpha: 0.6, meanOmega: 2.2,
      meanShape: 1.4, meanOmegaStandardDeviation: 1.8, meanPositiveBranchFraction: 0.35, detected: true,
    }],
    detectedSites: [1],
    posterior: {
      siteCount: 1,
      muValues: Float64Array.of(0.2, 3),
      shapeValues: Float64Array.of(0.2, 2),
      alphaValues: Float64Array.of(0.1, 2),
      surfaces: Float32Array.from({ length: 16 }, (_unused, index) => index === 15 ? 0.7 : 0.3 / 15),
      mu: Float32Array.of(0.2, 0.8),
      shape: Float32Array.of(0.3, 0.7),
      alpha: Float32Array.of(0.6, 0.4),
      capState: Float32Array.of(0.98, 0.02),
    },
    positivePrior: 0.15,
    backend: "wasm-parallel",
    timings: { totalMs: 2000 },
    diagnostics: {
      taxa: 4, codonSites: 1, categories: 16, branchMixtureOperators: 16, atomicOmegaModels: 20,
      treeRegisterNumber: 2, precision: "f64", inferenceMethod: "dirichlet-em", inferenceIterations: 12,
      inferenceBurnin: 0, inferenceLogLikelihood: -4, modelDraftCommit: "4c65c984", numericalEngine: "fused-sparse-or-dense-uniformization",
      gammaSlices: 12, cappedGridMultiplicityRetained: true, gridPreset: "fast",
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n",
  };
  const markup = renderToStaticMarkup(<BameVisualizations result={result} threshold={0.9} onThresholdChange={() => undefined} />);
  assert.match(markup, /FLAVOR figure studio/);
  assert.match(markup, /Surface categories/);
  assert.match(markup, /Uncapped only/);
  assert.match(markup, /Branch-ω CDF/);
  assert.match(markup, /Posterior projection/);
});

test("approximate FEL stays separate and renders conditional likelihood optima plus SVG export", () => {
  const result = {
    siteCount: 2,
    gridSize: 3,
    gridValues: Float64Array.of(0.01, 1, 8),
    relativeLogLikelihoods: Float32Array.of(
      -8, -5, -3, -6, -2, 0, -7, -3, -1,
      -1, -3, -7, 0, -2, -6, -3, -5, -8,
    ),
    sites: [
      {
        site: 1, pValue: 0.02, pPositive: 0.01, pPurifying: 0.99, likelihoodRatio: 5.41,
        gridLogLikelihoodMaximum: -100, logLikelihoodAlternative: -99.9, logLikelihoodNull: -102.605,
        alphaAlternative: 0.7, betaAlternative: 2.4, alphaBetaNull: 1.1,
        alphaCoordinate: 0.9, betaCoordinate: 1.35, nullCoordinate: 1.04,
        direction: "positive", splineTension: 1,
      },
      {
        site: 2, pValue: 0.03, pPositive: 0.985, pPurifying: 0.015, likelihoodRatio: 4.7,
        gridLogLikelihoodMaximum: -80, logLikelihoodAlternative: -79.8, logLikelihoodNull: -82.15,
        alphaAlternative: 2.8, betaAlternative: 0.6, alphaBetaNull: 1.2,
        alphaCoordinate: 1.45, betaCoordinate: 0.8, nullCoordinate: 1.06,
        direction: "purifying", splineTension: 1,
      },
    ],
    diagnostics: {
      interpolation: "exact-tensioned-bicubic-log-likelihood",
      coordinateSystem: "uniform-fubar-grid-index",
      maximumNodeError: 0,
      minimumSplineTension: 1,
      guardedSites: 0,
    },
  } as const;
  assert.equal(approximateFelCall(result.sites[0], 0.05), "positive");
  assert.equal(approximateFelCall(result.sites[1], 0.05), "purifying");
  const markup = renderToStaticMarkup(<ApproximateFelResults result={result} elapsedMs={640} />);
  assert.match(markup, /Optional frequentist companion/);
  assert.match(markup, /Separate from FUBAR/);
  assert.match(markup, /No FUBAR prior enters these results/);
  assert.match(markup, /data-figure="approximate-fel-surface"/);
  assert.match(markup, /data-optimum="null"/);
  assert.match(markup, /data-optimum="alternative"/);
  assert.match(markup, /data-lrt-connector="true"/);
  assert.match(markup, /Download FEL CSV/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /FEL compute time/);
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
