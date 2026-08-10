import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";

export type RuntimeKind = "browser-webgpu" | "browser-wasm" | "server-native";
export type ModelCategory = "selection" | "phylogeny" | "ancestral" | "recombination" | "utility";

export interface ModelInputSlot {
  readonly id: "alignment" | "tree" | "foreground" | string;
  readonly label: string;
  readonly kind: "alignment" | "tree" | "selection";
  readonly required: boolean;
  readonly description: string;
}

interface ParameterBase {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly advanced?: boolean;
}

export interface NumberParameter extends ParameterBase {
  readonly type: "integer" | "number";
  readonly default: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
}

export interface SelectParameter extends ParameterBase {
  readonly type: "select";
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface BooleanParameter extends ParameterBase {
  readonly type: "boolean";
  readonly default: boolean;
}

export type ModelParameter = NumberParameter | SelectParameter | BooleanParameter;

export interface ModelManifest {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly description: string;
  readonly category: ModelCategory;
  readonly inputSlots: readonly ModelInputSlot[];
  readonly parameters: readonly ModelParameter[];
  readonly runtimes: readonly RuntimeKind[];
  readonly outputKinds: readonly string[];
  readonly citation?: string;
}

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly artifact?: "alignment" | "tree" | "foreground";
}

export interface ModelValidation {
  readonly ready: boolean;
  readonly issues: readonly ValidationIssue[];
}

export type ParameterValues = Readonly<Record<string, string | number | boolean>>;

export interface AnalysisJobSpec {
  readonly schemaVersion: 1;
  readonly model: {
    readonly id: string;
    readonly version: string;
  };
  readonly inputs: {
    readonly alignmentSha256: string;
    readonly treeSha256: string;
  };
  readonly parameters: ParameterValues;
  readonly seed?: number;
  readonly requestedRuntime: RuntimeKind | "auto";
}

export interface AnalysisProgress {
  readonly stage: string;
  readonly fraction: number;
  readonly message: string;
}

export interface ModelPlugin<Result = unknown> {
  readonly manifest: ModelManifest;
  prepareTreeInput?(text: string): string;
  validate(workspace: PhyloWorkspaceSnapshot): ModelValidation;
  defaultParameters(): ParameterValues;
  createJob(workspace: Required<PhyloWorkspaceSnapshot>, parameters: ParameterValues): AnalysisJobSpec;
  resultToCsv?(result: Result): string;
}

export function defaultsFromManifest(manifest: ModelManifest): ParameterValues {
  return Object.fromEntries(manifest.parameters.map((parameter) => [parameter.id, parameter.default]));
}
