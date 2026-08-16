import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const ALIGNMENT_EXTENSIONS = new Set([".fa", ".fas", ".fasta", ".fna", ".ffn", ".aln"]);
const TREE_EXTENSIONS = new Set([".nwk", ".newick", ".tree", ".tre", ".nex", ".nexus"]);

export interface DiscoveredFile {
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly name: string;
  readonly kind: "alignment" | "tree";
  readonly stem: string;
}

export interface TreePairing {
  readonly alignment: DiscoveredFile;
  readonly status: "matched" | "missing" | "ambiguous";
  readonly tree?: DiscoveredFile;
  readonly candidates: readonly DiscoveredFile[];
}

export function safeName(value: string, fallback = "artifact"): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `${headers.map(csvCell).join(",")}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function fileKind(path: string): DiscoveredFile["kind"] | undefined {
  const extension = extname(path).toLowerCase();
  if (ALIGNMENT_EXTENSIONS.has(extension)) return "alignment";
  if (TREE_EXTENSIONS.has(extension)) return "tree";
  return undefined;
}

function stem(path: string): string {
  const name = basename(path);
  const extension = extname(name);
  return name.slice(0, Math.max(0, name.length - extension.length)).toLowerCase();
}

async function walk(path: string): Promise<readonly string[]> {
  const value = await stat(path);
  if (value.isFile()) return [path];
  if (!value.isDirectory()) return [];
  const children = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(children.sort((a, b) => a.name.localeCompare(b.name)).map((child) => walk(join(path, child.name))));
  return nested.flat();
}

export async function discoverInputs(paths: readonly string[], configDirectory: string): Promise<readonly DiscoveredFile[]> {
  const roots = paths.map((path) => resolve(configDirectory, path));
  const discovered = (await Promise.all(roots.map(walk))).flat();
  const commonDisplayRoot = roots.length === 1 && (await stat(roots[0]!)).isDirectory() ? roots[0]! : configDirectory;
  const unique = new Map<string, DiscoveredFile>();
  for (const absolutePath of discovered) {
    const kind = fileKind(absolutePath);
    if (kind === undefined) continue;
    const displayRelative = relative(commonDisplayRoot, absolutePath);
    const displayPath = displayRelative.length > 0 && !displayRelative.startsWith(`..${sep}`) ? displayRelative : absolutePath;
    unique.set(absolutePath, { absolutePath, displayPath, name: basename(absolutePath), kind, stem: stem(absolutePath) });
  }
  return [...unique.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

export function pairTrees(files: readonly DiscoveredFile[]): readonly TreePairing[] {
  const treesByStem = new Map<string, DiscoveredFile[]>();
  for (const tree of files.filter((file) => file.kind === "tree")) treesByStem.set(tree.stem, [...(treesByStem.get(tree.stem) ?? []), tree]);
  return files.filter((file) => file.kind === "alignment").map((alignment) => {
    const candidates = [...(treesByStem.get(alignment.stem) ?? [])].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    if (candidates.length === 1) return { alignment, status: "matched" as const, tree: candidates[0]!, candidates };
    return { alignment, status: candidates.length === 0 ? "missing" as const : "ambiguous" as const, candidates };
  });
}

export async function prepareOutputDirectory(path: string, overwrite: boolean): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true });
  const entries = await readdir(absolute);
  if (entries.length > 0 && !overwrite) throw new Error(`Output directory is not empty: ${absolute}. Choose an empty directory or pass --overwrite.`);
  return absolute;
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

export async function readableExecutable(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK | constants.X_OK); return true; }
  catch { return false; }
}

export { readFile };
