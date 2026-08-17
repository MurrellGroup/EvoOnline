import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { SegmentEvaluator, SegmentLikelihood, TreeEmissionProfile } from "@phylo-workbench/model-fsart";
import { readableExecutable } from "./io.js";

export interface ParsedFasta {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
}

export interface FastTreeRuntime {
  readonly binary: string;
  readonly label: string;
}

export interface FastTreeEvaluator {
  readonly evaluate: SegmentEvaluator;
  readonly evaluateRanges: (ranges: readonly (readonly [number, number])[]) => Promise<SegmentLikelihood>;
  readonly diagnostics: () => {
    readonly requests: number;
    readonly freshFits: number;
    readonly fastTreeMs: number;
    readonly parallelism: number;
    readonly threadsPerFit: number;
    readonly peakConcurrentFits: number;
  };
}

export function parseFastaText(text: string): ParsedFasta {
  const names: string[] = [];
  const sequences: string[] = [];
  let name: string | undefined;
  let sequence = "";
  const commit = (): void => {
    if (name === undefined) return;
    names.push(name);
    sequences.push(sequence.toUpperCase());
  };
  for (const raw of text.replaceAll("\r", "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(">")) {
      commit();
      name = line.slice(1).trim().split(/\s+/, 1)[0];
      sequence = "";
    } else sequence += line;
  }
  commit();
  if (names.length === 0) throw new Error("The alignment contains no FASTA records.");
  if (sequences.some((value) => value.length !== sequences[0]!.length)) throw new Error("All FASTA sequences must have the same aligned length.");
  return { names, sequences };
}

export async function findFastTree(requested?: string): Promise<FastTreeRuntime | undefined> {
  const explicit = requested ?? process.env.EVO_FASTTREE;
  if (explicit !== undefined) {
    const absolute = resolve(explicit);
    if (!await readableExecutable(absolute)) throw new Error(`FastTree executable is not readable/executable: ${absolute}`);
    return { binary: absolute, label: absolute };
  }
  const names = process.platform === "win32" ? ["FastTree.exe", "FastTreeMP.exe", "fasttree.exe"] : ["FastTree", "FastTreeMP", "fasttree"];
  // Release archives keep the GPL program separate from evo-cli while remaining
  // completely self-contained. Prefer that adjacent executable before PATH.
  const executableDirectories = [...new Set([process.execPath, process.argv[0], process.argv[1]].filter((value): value is string => typeof value === "string" && value.length > 0).map((value) => dirname(resolve(value))))];
  for (const directory of executableDirectories) for (const name of names) {
    const candidate = join(directory, name);
    if (await readableExecutable(candidate)) return { binary: candidate, label: `FastTree 2.1.11 (bundled: ${name})` };
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await readableExecutable(candidate)) return { binary: candidate, label: name };
    }
  }
  return undefined;
}

async function execute(binary: string, args: readonly string[], fasta: string, threads = 1): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OMP_NUM_THREADS: String(Math.max(1, Math.floor(threads))) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`FastTree exited ${code}: ${stderr.slice(-800)}`)));
    child.stdin.end(fasta);
  });
}

function quoteNewick(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

function restoreIndexedNames(newick: string, names: readonly string[]): string {
  return newick.replace(/(^|[(,])\s*(\d+)(?=\s*:)/g, (_match, prefix: string, index: string) => `${prefix}${quoteNewick(names[Number(index)] ?? index)}`);
}

function parseModel(stderr: string): Pick<SegmentLikelihood, "gtrFrequencies" | "gtrRates" | "gammaAlpha"> {
  const frequencies = stderr.match(/GTR Frequencies:\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i)
    ?? stderr.match(/GTR frequencies\(A C G T\)\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i);
  const rates = stderr.match(/GTR rates\(ac ag at cg ct gt\)\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i);
  const alpha = stderr.match(/Gamma\(\s*20\s*\)\s+LogLk\s*=\s*[-+\d.eE]+\s+alpha\s*=\s*([\d.eE+-]+)/i);
  return {
    ...(frequencies === null ? {} : { gtrFrequencies: frequencies.slice(1, 5).map(Number) as unknown as [number, number, number, number] }),
    ...(rates === null ? {} : { gtrRates: rates.slice(1, 7).map(Number) as unknown as [number, number, number, number, number, number] }),
    ...(alpha === null ? {} : { gammaAlpha: Number(alpha[1]) }),
  };
}

function segmentFasta(parsed: ParsedFasta, start: number, end: number, indexedNames = true): string {
  return parsed.sequences.map((sequence, index) => `>${indexedNames ? index : parsed.names[index]}\n${sequence.slice(start - 1, end)}`).join("\n");
}

function rangesFasta(parsed: ParsedFasta, ranges: readonly (readonly [number, number])[]): string {
  return parsed.sequences.map((sequence, index) => `>${index}\n${ranges.map(([start, end]) => sequence.slice(start - 1, end)).join("")}`).join("\n");
}

export function variableSiteCount(sequences: readonly string[], start: number, end: number): number {
  let total = 0;
  for (let site = start - 1; site < end; site += 1) {
    let mask = 0;
    for (const sequence of sequences) {
      const state = sequence.charCodeAt(site);
      if (state === 65) mask |= 1;
      else if (state === 67) mask |= 2;
      else if (state === 71) mask |= 4;
      else if (state === 84 || state === 85) mask |= 8;
    }
    if ((mask & (mask - 1)) !== 0) total += 1;
  }
  return total;
}

export async function fitFastTreeSegment(
  runtime: FastTreeRuntime,
  fasta: string,
  names: readonly string[],
  start: number,
  end: number,
  fastest = true,
  sharedModel?: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] },
  threads = 1,
): Promise<SegmentLikelihood> {
  const modelArgs = sharedModel === undefined ? [] : ["-gtrfreq", ...sharedModel.gtrFrequencies.map(String), "-gtrrates", ...sharedModel.gtrRates.map(String)];
  const args = ["-nt", "-gtr", ...modelArgs, "-nosupport", "-gamma", "-nopr", ...(fastest ? ["-fastest"] : [])];
  const started = performance.now();
  const result = await execute(runtime.binary, args, fasta, threads);
  const gamma = result.stderr.match(/Gamma\(\s*20\s*\)\s+LogLk\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i);
  const fallback = Array.from(result.stderr.matchAll(/LogLk\s*(?:~?=)?\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/gi)).at(-1);
  const logLikelihood = Number(gamma?.[1] ?? fallback?.[1]);
  if (!Number.isFinite(logLikelihood)) throw new Error(`FastTree returned no comparable Gamma20 likelihood: ${result.stderr.slice(-800)}`);
  const treeLine = result.stdout.split(/\r?\n/).filter((line) => line.includes("(")).at(-1);
  if (treeLine === undefined) throw new Error("FastTree returned no Newick tree.");
  return { start, end, logLikelihood, tree: restoreIndexedNames(treeLine.trim(), names), variableSites: 0, elapsedMs: performance.now() - started, ...parseModel(result.stderr) };
}

export async function inferFastTree(runtime: FastTreeRuntime, alignment: string, fastest: boolean, threads = 1): Promise<string> {
  const parsed = parseFastaText(alignment);
  const score = await fitFastTreeSegment(runtime, segmentFasta(parsed, 1, parsed.sequences[0]!.length), parsed.names, 1, parsed.sequences[0]!.length, fastest, undefined, threads);
  return score.tree;
}

function parseSiteLikelihoods(text: string, sites: number): Float64Array {
  const output = new Float64Array(sites).fill(Number.NaN);
  const pattern = /^Gamma20\s+(\d+)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/gm;
  for (const match of text.matchAll(pattern)) {
    const site = Number(match[1]);
    if (site >= 0 && site < sites) output[site] = Number(match[2]);
  }
  const missing = output.findIndex((value) => !Number.isFinite(value));
  if (missing >= 0) throw new Error(`FastTree site-likelihood log is missing site ${missing + 1}.`);
  return output;
}

export async function scoreFastTreeTopology(
  runtime: FastTreeRuntime,
  fasta: string,
  names: readonly string[],
  sites: number,
  candidate: { readonly id: string; readonly tree: string; readonly sourceStart: number; readonly sourceEnd: number; readonly sourceRanges?: readonly (readonly [number, number])[]; readonly topologySignature: string },
  model: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] },
  sourceWeight = 4,
  threads = 1,
): Promise<TreeEmissionProfile> {
  if (model.gtrFrequencies.length !== 4 || model.gtrRates.length !== 6) throw new Error("Shared GTR estimates are incomplete.");
  const directory = await mkdtemp(join(tmpdir(), "evo-cli-fasttree-"));
  const treePath = join(directory, "candidate.nwk");
  const logPath = join(directory, "sites.log");
  await writeFile(treePath, candidate.tree.endsWith(";") ? candidate.tree : `${candidate.tree};`);
  const parsed = parseFastaText(fasta);
  const sourceRanges = candidate.sourceRanges ?? [[candidate.sourceStart, candidate.sourceEnd] as const];
  const weight = sourceRanges.length === 1 && candidate.sourceStart === 1 && candidate.sourceEnd === sites ? 1 : Math.max(1, Math.min(8, Math.round(sourceWeight)));
  const scoringFasta = parsed.names.map((name, index) => {
    const sequence = parsed.sequences[index]!;
    const source = sourceRanges.map(([start, end]) => sequence.slice(start - 1, end)).join("");
    return `>${name}\n${sequence}${source.repeat(weight - 1)}`;
  }).join("\n");
  const args = ["-nt", "-gtr", "-gtrfreq", ...model.gtrFrequencies.map(String), "-gtrrates", ...model.gtrRates.map(String), "-nosupport", "-gamma", "-nopr", "-nome", "-mllen", "-intree", treePath, "-log", logPath];
  const started = performance.now();
  try {
    const result = await execute(runtime.binary, args, scoringFasta, threads);
    const treeLine = result.stdout.split(/\r?\n/).filter((line) => line.includes("(")).at(-1);
    if (treeLine === undefined) throw new Error("FastTree returned no fixed-topology Newick tree.");
    const siteLogLikelihoods = parseSiteLikelihoods(await readFile(logPath, "utf8"), sites);
    return {
      ...candidate,
      sourceRanges,
      tree: treeLine.trim(),
      logLikelihood: siteLogLikelihoods.reduce((sum, value) => sum + value, 0),
      siteLogLikelihoods,
      elapsedMs: performance.now() - started,
      ...parseModel(result.stderr),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createFastTreeEvaluator(
  runtime: FastTreeRuntime,
  alignment: string,
  fastest = true,
  parallelism = 1,
  threadsPerFit = 1,
): FastTreeEvaluator {
  const parsed = parseFastaText(alignment);
  const cache = new Map<string, Promise<SegmentLikelihood>>();
  const maximumActive = Math.max(1, Math.floor(parallelism));
  const waiting: Array<() => void> = [];
  let active = 0;
  let peakConcurrentFits = 0;
  let requests = 0;
  let freshFits = 0;
  let fastTreeMs = 0;
  let sharedModel: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] } | undefined;
  const acquire = async (): Promise<void> => {
    if (active >= maximumActive) await new Promise<void>((resolvePromise) => waiting.push(resolvePromise));
    active += 1;
    peakConcurrentFits = Math.max(peakConcurrentFits, active);
  };
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };
  const enqueue = (key: string, fasta: string, start: number, end: number, ranges?: readonly (readonly [number, number])[]): Promise<SegmentLikelihood> => {
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    freshFits += 1;
    const pending = (async () => {
      await acquire();
      try {
        const score = await fitFastTreeSegment(runtime, fasta, parsed.names, start, end, fastest, sharedModel, threadsPerFit);
        fastTreeMs += score.elapsedMs;
        if (start === 1 && end === parsed.sequences[0]!.length && score.gtrFrequencies !== undefined && score.gtrRates !== undefined) sharedModel = { gtrFrequencies: score.gtrFrequencies, gtrRates: score.gtrRates };
        const variableSites = ranges === undefined ? variableSiteCount(parsed.sequences, start, end) : ranges.reduce((sum, [low, high]) => sum + variableSiteCount(parsed.sequences, low, high), 0);
        return { ...score, variableSites };
      } finally {
        release();
      }
    })();
    cache.set(key, pending);
    return pending;
  };
  const evaluate: SegmentEvaluator = (start, end) => {
    requests += 1;
    return enqueue(`${start}:${end}`, segmentFasta(parsed, start, end), start, end);
  };
  const evaluateRanges = (ranges: readonly (readonly [number, number])[]): Promise<SegmentLikelihood> => {
    requests += 1;
    const normalized = ranges.map(([start, end]) => [Math.max(1, Math.round(start)), Math.min(parsed.sequences[0]!.length, Math.round(end))] as const).filter(([start, end]) => end >= start);
    if (normalized.length === 0) return Promise.reject(new Error("At least one non-empty source range is required."));
    return enqueue(`ranges:${normalized.map((range) => range.join("-")).join(",")}`, rangesFasta(parsed, normalized), normalized[0]![0], normalized.at(-1)![1], normalized);
  };
  return { evaluate, evaluateRanges, diagnostics: () => ({ requests, freshFits, fastTreeMs, parallelism: maximumActive, threadsPerFit: Math.max(1, Math.floor(threadsPerFit)), peakConcurrentFits }) };
}

export function segmentAlignment(parsed: ParsedFasta, start: number, end: number): string {
  return segmentFasta(parsed, start, end);
}
