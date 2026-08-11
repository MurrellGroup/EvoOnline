import type { ComponentType } from "react";
import { difFubarPlugin } from "@phylo-workbench/model-diffubar/browser-source";
import { fubarPlugin } from "@phylo-workbench/model-fubar/browser-source";
import { bsrelPlugin } from "@phylo-workbench/model-bsrel/browser-source";
import { famePlugin, flavorPlugin, globalGammaPlugin } from "@phylo-workbench/model-bame/browser-source";
import type { ModelPlugin, ParameterValues } from "@phylo-workbench/model-sdk";
import { ResultsView } from "./components/ResultsView.js";
import { FubarResultsView } from "./components/FubarResultsView.js";
import { BsrelResultsView } from "./components/BsrelResultsView.js";
import { BameResultsView } from "./components/BameResultsView.js";
import { GlobalGammaResultsView } from "./components/GlobalGammaResultsView.js";
import { DifFubarClient, type RunProgress } from "./lib/diffubar-client.js";
import { FubarClient } from "./lib/fubar-client.js";
import { BsrelClient } from "./lib/bsrel-client.js";
import { BameClient } from "./lib/bame-client.js";
import type { BameRunResult, BsrelRunResult, DifFubarRunResult, FubarRunResult, GlobalGammaRunResult } from "./types.js";

export interface BrowserModelExecutor {
  run(
    alignment: string,
    tree: string,
    parameters: ParameterValues,
    onProgress: (progress: RunProgress) => void,
  ): Promise<unknown>;
  cancel(): void;
  dispose(): void;
}

interface ResultProps {
  readonly result: unknown;
  readonly parameters: ParameterValues;
  readonly alignment: string;
}

export interface BrowserModelRegistration {
  readonly plugin: ModelPlugin<any>;
  readonly glyph: string;
  readonly runtimeLabel: string;
  readonly createExecutor: () => BrowserModelExecutor;
  readonly ResultView: ComponentType<ResultProps>;
  readonly completionMessage: (result: unknown) => string;
}

function DifFubarResult({ result, parameters, alignment }: ResultProps) {
  return <ResultsView result={result as DifFubarRunResult} threshold={Number(parameters.posteriorThreshold ?? 0.95)} alignment={alignment} />;
}

function FubarResult({ result, parameters, alignment }: ResultProps) {
  return <FubarResultsView result={result as FubarRunResult} threshold={Number(parameters.posteriorThreshold ?? 0.95)} alignment={alignment} />;
}

function BsrelResult({ result, parameters }: ResultProps) {
  return <BsrelResultsView result={result as BsrelRunResult} threshold={Number(parameters.significanceThreshold ?? 0.05)} />;
}

function BameResult({ result, parameters, alignment }: ResultProps) {
  return <BameResultsView result={result as BameRunResult} threshold={Number(parameters.posteriorThreshold ?? 0.9)} alignment={alignment} />;
}

function GlobalGammaResult({ result, parameters, alignment }: ResultProps) {
  return <GlobalGammaResultsView result={result as GlobalGammaRunResult} threshold={Number(parameters.posteriorThreshold ?? 0.9)} alignment={alignment} />;
}

export const modelRegistry: readonly BrowserModelRegistration[] = [
  {
    plugin: difFubarPlugin,
    glyph: "Δω",
    runtimeLabel: "GPU · WASM",
    createExecutor: () => new DifFubarClient(),
    ResultView: DifFubarResult,
    completionMessage: (result) => `DifFUBAR completed with ${(result as DifFubarRunResult).backend}.`,
  },
  {
    plugin: fubarPlugin,
    glyph: "αβ",
    runtimeLabel: "WASM · GPU",
    createExecutor: () => new FubarClient(),
    ResultView: FubarResult,
    completionMessage: (result) => {
      const output = result as FubarRunResult;
      return `FUBAR completed with ${output.backend}: ${output.positiveSites.length} positive and ${output.purifyingSites.length} purifying sites.`;
    },
  },
  {
    plugin: bsrelPlugin,
    glyph: "ω↗",
    runtimeLabel: "Parallel WASM",
    createExecutor: () => new BsrelClient(),
    ResultView: BsrelResult,
    completionMessage: (result) => {
      const output = result as BsrelRunResult;
      return `BS-REL completed with ${output.backend}: ${output.diagnostics.significantBranches} Holm-significant branches.`;
    },
  },
  {
    plugin: famePlugin,
    glyph: "ω×2",
    runtimeLabel: "Parallel WASM",
    createExecutor: () => new BameClient("fame"),
    ResultView: BameResult,
    completionMessage: (result) => {
      const output = result as BameRunResult;
      return `FAME completed with ${output.backend}: ${output.detectedSites.length} episodic-positive sites.`;
    },
  },
  {
    plugin: flavorPlugin,
    glyph: "Γω",
    runtimeLabel: "Parallel WASM",
    createExecutor: () => new BameClient("flavor"),
    ResultView: BameResult,
    completionMessage: (result) => {
      const output = result as BameRunResult;
      return `FLAVOR completed with ${output.backend}: ${output.detectedSites.length} episodic-positive sites.`;
    },
  },
  {
    plugin: globalGammaPlugin,
    glyph: "Γω↗",
    runtimeLabel: "Parallel WASM",
    createExecutor: () => new BameClient("glamma"),
    ResultView: GlobalGammaResult,
    completionMessage: (result) => {
      const output = result as GlobalGammaRunResult;
      const supported = output.branches.filter((branch) => branch.activationLogBayesFactor >= Math.log(10)).length;
      return `Glamma completed with ${output.backend}: ${supported} branches have activation empirical BF ≥ 10.`;
    },
  },
];

export function getRegisteredModel(id: string): BrowserModelRegistration {
  const model = modelRegistry.find((candidate) => candidate.plugin.manifest.id === id);
  if (model === undefined) throw new Error(`Model '${id}' is not registered.`);
  return model;
}
