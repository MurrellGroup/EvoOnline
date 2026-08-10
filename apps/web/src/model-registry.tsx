import type { ComponentType } from "react";
import { difFubarPlugin } from "@phylo-workbench/model-diffubar/browser-source";
import { fubarPlugin } from "@phylo-workbench/model-fubar/browser-source";
import type { ModelPlugin, ParameterValues } from "@phylo-workbench/model-sdk";
import { ResultsView } from "./components/ResultsView.js";
import { FubarResultsView } from "./components/FubarResultsView.js";
import { DifFubarClient, type RunProgress } from "./lib/diffubar-client.js";
import { FubarClient } from "./lib/fubar-client.js";
import type { DifFubarRunResult, FubarRunResult } from "./types.js";

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
];

export function getRegisteredModel(id: string): BrowserModelRegistration {
  const model = modelRegistry.find((candidate) => candidate.plugin.manifest.id === id);
  if (model === undefined) throw new Error(`Model '${id}' is not registered.`);
  return model;
}
