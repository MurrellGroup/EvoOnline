import type { ParameterValues } from "@phylo-workbench/model-sdk";

export const PIPELINE_SCHEMA_VERSION = 1 as const;
export const PIPELINE_DRAG_TYPE = "application/x-evoonline-pipeline-component";
export const PIPELINE_ADD_EVENT = "evoonline:add-pipeline-node";
export const PIPELINE_STORAGE_KEY = "evoonline-pipelines-v1";

export type PipelineNodeKind = "fasttree" | "user-trees" | "model";

export interface PipelineNode {
  readonly id: string;
  readonly kind: PipelineNodeKind;
  readonly modelId?: string;
  readonly parameters: ParameterValues;
}

export interface PipelineDefinition {
  readonly schemaVersion: typeof PIPELINE_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly PipelineNode[];
}

export interface PipelineFileLike {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

export interface TreeMatch<FileType extends PipelineFileLike = PipelineFileLike> {
  readonly alignment: FileType;
  readonly tree?: FileType;
  readonly candidates: readonly FileType[];
  readonly status: "matched" | "missing" | "ambiguous";
}

const ALIGNMENT_EXTENSIONS = new Set(["fa", "fas", "fasta", "fna", "ffn", "aln"]);
const TREE_EXTENSIONS = new Set(["nwk", "newick", "tree", "tre", "nex", "nexus"]);

export function pipelineFilePath(file: PipelineFileLike): string {
  return file.webkitRelativePath?.trim() || file.name;
}

export function pipelineFileExtension(file: PipelineFileLike): string {
  const filename = file.name.toLowerCase();
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index + 1);
}

export function pipelineFileStem(file: PipelineFileLike): string {
  const filename = file.name.trim();
  const index = filename.lastIndexOf(".");
  return (index <= 0 ? filename : filename.slice(0, index)).toLowerCase();
}

export function isPipelineAlignmentFile(file: PipelineFileLike): boolean {
  return ALIGNMENT_EXTENSIONS.has(pipelineFileExtension(file));
}

export function isPipelineTreeFile(file: PipelineFileLike): boolean {
  return TREE_EXTENSIONS.has(pipelineFileExtension(file));
}

export function matchPipelineTrees<FileType extends PipelineFileLike>(files: readonly FileType[]): readonly TreeMatch<FileType>[] {
  const alignments = files.filter(isPipelineAlignmentFile).sort((left, right) => pipelineFilePath(left).localeCompare(pipelineFilePath(right)));
  const treeMap = new Map<string, FileType[]>();
  for (const tree of files.filter(isPipelineTreeFile)) {
    const stem = pipelineFileStem(tree);
    treeMap.set(stem, [...(treeMap.get(stem) ?? []), tree]);
  }
  return alignments.map((alignment) => {
    const candidates = [...(treeMap.get(pipelineFileStem(alignment)) ?? [])].sort((left, right) => pipelineFilePath(left).localeCompare(pipelineFilePath(right)));
    if (candidates.length === 1) return { alignment, tree: candidates[0]!, candidates, status: "matched" as const };
    return { alignment, candidates, status: candidates.length === 0 ? "missing" as const : "ambiguous" as const };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameterValues(value: unknown): value is ParameterValues {
  return record(value) && Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}

export function parsePipelineDefinition(text: string): PipelineDefinition {
  const parsed: unknown = JSON.parse(text);
  if (!record(parsed) || parsed.schemaVersion !== PIPELINE_SCHEMA_VERSION || typeof parsed.id !== "string" || typeof parsed.name !== "string" || !Array.isArray(parsed.nodes)) {
    throw new Error("This is not an EvoOnline pipeline definition (schema version 1).");
  }
  const nodes: PipelineNode[] = parsed.nodes.map((value, index) => {
    if (!record(value) || typeof value.id !== "string" || !["fasttree", "user-trees", "model"].includes(String(value.kind)) || !parameterValues(value.parameters)) {
      throw new Error(`Pipeline component ${index + 1} is invalid.`);
    }
    if (value.kind === "model" && typeof value.modelId !== "string") throw new Error(`Pipeline component ${index + 1} has no method identifier.`);
    return {
      id: value.id,
      kind: value.kind as PipelineNodeKind,
      ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
      parameters: value.parameters,
    };
  });
  return { schemaVersion: PIPELINE_SCHEMA_VERSION, id: parsed.id, name: parsed.name, nodes };
}

export function stringifyPipelineDefinition(definition: PipelineDefinition): string {
  return `${JSON.stringify(definition, null, 2)}\n`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodePipelineShare(definition: PipelineDefinition): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(definition)));
}

export function decodePipelineShare(value: string): PipelineDefinition {
  return parsePipelineDefinition(new TextDecoder().decode(base64UrlToBytes(value)));
}

export function createPipelineId(prefix = "pipeline"): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
