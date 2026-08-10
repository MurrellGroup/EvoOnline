import type { ComponentType } from "react";
import { difFubarPlugin } from "@phylo-workbench/model-diffubar/browser-source";
import type { ModelPlugin, ParameterValues } from "@phylo-workbench/model-sdk";
import { ResultsView } from "./components/ResultsView.js";
import { DifFubarClient, type RunProgress } from "./lib/diffubar-client.js";
import type { DifFubarRunResult } from "./types.js";

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
}

export interface BrowserModelRegistration {
  readonly plugin: ModelPlugin<any>;
  readonly glyph: string;
  readonly runtimeLabel: string;
  readonly createExecutor: () => BrowserModelExecutor;
  readonly ResultView: ComponentType<ResultProps>;
  readonly completionMessage: (result: unknown) => string;
}

function DifFubarResult({ result, parameters }: ResultProps) {
  return <ResultsView result={result as DifFubarRunResult} threshold={Number(parameters.posteriorThreshold ?? 0.95)} />;
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
];

export function getRegisteredModel(id: string): BrowserModelRegistration {
  const model = modelRegistry.find((candidate) => candidate.plugin.manifest.id === id);
  if (model === undefined) throw new Error(`Model '${id}' is not registered.`);
  return model;
}
