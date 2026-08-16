import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { csvCell, jsonReplacer, rowsToCsv, safeName, writeJson, writeText } from "./io.js";

export type ArtifactKind = "alignment" | "tree" | "tree-index" | "recombination-bundle" | "result-json" | "result-table" | "plot" | "manifest" | "log" | "truth";

export interface OutputArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly dataset?: string;
  readonly nodeId?: string;
  readonly methodId?: string;
  readonly sourceNodeId?: string;
  readonly downstreamReusable: boolean;
}

export interface ArtifactContext {
  readonly outputRoot: string;
  readonly dataset?: string;
  readonly nodeId?: string;
  readonly methodId?: string;
  readonly sourceNodeId?: string;
}

export function describeArtifact(context: ArtifactContext, path: string, kind: ArtifactKind, mediaType: string, downstreamReusable = false): OutputArtifact {
  return { path: relative(context.outputRoot, path).replaceAll("\\", "/"), kind, mediaType, ...(context.dataset === undefined ? {} : { dataset: context.dataset }), ...(context.nodeId === undefined ? {} : { nodeId: context.nodeId }), ...(context.methodId === undefined ? {} : { methodId: context.methodId }), ...(context.sourceNodeId === undefined ? {} : { sourceNodeId: context.sourceNodeId }), downstreamReusable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function tablePath(parts: readonly string[]): string {
  return parts.map((part) => safeName(part, "value")).join("--").slice(0, 180);
}

function flattenRow(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = isScalar(entry) ? entry : JSON.stringify(entry, jsonReplacer);
  return output;
}

async function exportArrayTable(directory: string, path: readonly string[], values: readonly unknown[]): Promise<string | undefined> {
  if (values.length === 0) return undefined;
  const target = resolve(directory, "tables", `${tablePath(path)}.csv`);
  if (values.every(isScalar)) {
    await writeText(target, rowsToCsv(["index", "value"], values.map((value, index) => [index + 1, value])));
    return target;
  }
  if (values.every(isRecord)) {
    const rows = values.map((value) => flattenRow(value as Record<string, unknown>));
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    await writeText(target, rowsToCsv(headers, rows.map((row) => headers.map((header) => row[header]))));
    return target;
  }
  return undefined;
}

async function walkDetailedTables(value: unknown, directory: string, path: readonly string[], seen: Set<unknown>, output: string[]): Promise<void> {
  if (value === null || value === undefined || isScalar(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const target = await exportArrayTable(directory, path, Array.from(value as unknown as ArrayLike<number>));
    if (target !== undefined) output.push(target);
    return;
  }
  if (Array.isArray(value)) {
    const target = await exportArrayTable(directory, path, value);
    if (target !== undefined) output.push(target);
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (!isRecord(entry)) continue;
      for (const [key, nested] of Object.entries(entry)) {
        if (!isScalar(nested)) await walkDetailedTables(nested, directory, [...path, key], seen, output);
      }
    }
    return;
  }
  if (!isRecord(value)) return;
  const scalarEntries = Object.entries(value).filter(([, entry]) => isScalar(entry) && !(typeof entry === "string" && entry.includes("\n")));
  if (scalarEntries.length > 1 && path.length > 0) {
    const target = resolve(directory, "tables", `${tablePath([...path, "summary"])}.csv`);
    await writeText(target, rowsToCsv(scalarEntries.map(([key]) => key), [scalarEntries.map(([, entry]) => entry)]));
    output.push(target);
  }
  for (const [key, entry] of Object.entries(value)) await walkDetailedTables(entry, directory, [...path, key], seen, output);
}

function collectNewick(value: unknown, path: readonly string[], output: Array<{ readonly label: string; readonly tree: string }>, seen: Set<unknown>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("(") && trimmed.includes(")") && trimmed.endsWith(";")) output.push({ label: path.join("."), tree: trimmed });
    return;
  }
  if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectNewick(entry, [...path, String(index + 1)], output, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) collectNewick(entry, [...path, key], output, seen);
}

export async function exportResult(directory: string, result: unknown, context: ArtifactContext): Promise<readonly OutputArtifact[]> {
  const artifacts: OutputArtifact[] = [];
  const jsonPath = resolve(directory, "result.json");
  await writeJson(jsonPath, result);
  artifacts.push(describeArtifact(context, jsonPath, "result-json", "application/json"));

  if (isRecord(result)) {
    for (const [key, value] of Object.entries(result)) {
      if (typeof value !== "string" || value.length === 0) continue;
      const lower = key.toLowerCase();
      let extension: ".csv" | ".tsv" | ".json" | undefined;
      if (lower.endsWith("csv") || lower === "csv") extension = ".csv";
      else if (lower.endsWith("tsv")) extension = ".tsv";
      else if (lower.endsWith("json")) extension = ".json";
      if (extension === undefined) continue;
      const path = resolve(directory, "reported", `${safeName(key)}${extension}`);
      await writeText(path, value.endsWith("\n") ? value : `${value}\n`);
      artifacts.push(describeArtifact(context, path, "result-table", extension === ".json" ? "application/json" : extension === ".tsv" ? "text/tab-separated-values" : "text/csv"));
    }
  }

  const tables: string[] = [];
  await walkDetailedTables(result, directory, ["result"], new Set(), tables);
  for (const path of [...new Set(tables)]) artifacts.push(describeArtifact(context, path, "result-table", "text/csv"));

  const newick: Array<{ readonly label: string; readonly tree: string }> = [];
  collectNewick(result, ["result"], newick, new Set());
  const unique = new Map<string, { readonly label: string; readonly tree: string }>();
  for (const entry of newick) unique.set(createHash("sha256").update(entry.tree).digest("hex"), entry);
  const treeRows: unknown[][] = [];
  let index = 0;
  for (const [sha256, entry] of unique) {
    index += 1;
    const name = `tree-${String(index).padStart(3, "0")}-${safeName(entry.label, "tree").slice(-80)}.nwk`;
    const path = resolve(directory, "trees", name);
    await writeText(path, `${entry.tree}\n`);
    artifacts.push(describeArtifact(context, path, "tree", "text/x-newick", true));
    treeRows.push([index, entry.label, name, sha256]);
  }
  if (treeRows.length > 0) {
    const indexPath = resolve(directory, "trees", "index.csv");
    await writeText(indexPath, rowsToCsv(["tree", "result path", "file", "sha256"], treeRows));
    artifacts.push(describeArtifact(context, indexPath, "tree-index", "text/csv", true));
  }
  return artifacts;
}

export async function exportTreeSet(directory: string, treeSet: { readonly segments: readonly { readonly startCodon: number; readonly endCodon: number; readonly tree: string; readonly label?: string; readonly mask?: number }[] }, context: ArtifactContext): Promise<readonly OutputArtifact[]> {
  const artifacts: OutputArtifact[] = [];
  const rows: unknown[][] = [];
  for (let index = 0; index < treeSet.segments.length; index += 1) {
    const segment = treeSet.segments[index]!;
    const name = `region-${String(index + 1).padStart(3, "0")}-codons-${segment.startCodon}-${segment.endCodon}.nwk`;
    const path = resolve(directory, "regional-trees", name);
    await writeText(path, `${segment.tree.trim()}\n`);
    artifacts.push(describeArtifact(context, path, "tree", "text/x-newick", true));
    rows.push([index + 1, segment.startCodon, segment.endCodon, segment.label ?? "", segment.mask ?? "", name]);
  }
  const indexPath = resolve(directory, "regional-trees", "regions.csv");
  await writeText(indexPath, rowsToCsv(["region", "start codon", "end codon", "label", "mask", "tree file"], rows));
  artifacts.push(describeArtifact(context, indexPath, "tree-index", "text/csv", true));
  return artifacts;
}

export async function exportPlainArtifact(path: string, value: string, kind: ArtifactKind, mediaType: string, context: ArtifactContext, downstreamReusable = false): Promise<OutputArtifact> {
  await writeText(path, value);
  return describeArtifact(context, path, kind, mediaType, downstreamReusable);
}

export async function exportJsonArtifact(path: string, value: unknown, kind: ArtifactKind, context: ArtifactContext, downstreamReusable = false): Promise<OutputArtifact> {
  await writeJson(path, value);
  return describeArtifact(context, path, kind, "application/json", downstreamReusable);
}

export function csvFromRecords(records: readonly Record<string, unknown>[]): string {
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return `${headers.map(csvCell).join(",")}\n${records.map((record) => headers.map((header) => csvCell(record[header])).join(",")).join("\n")}${records.length > 0 ? "\n" : ""}`;
}
