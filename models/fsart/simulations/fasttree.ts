import { spawn } from "node:child_process";
import type { SegmentEvaluator, SegmentLikelihood } from "../src/index.js";

interface ParsedFasta {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
}

export interface FastTreeEvaluator {
  readonly evaluate: SegmentEvaluator;
  readonly evaluateRanges: (ranges: readonly (readonly [number, number])[]) => Promise<SegmentLikelihood>;
  readonly diagnostics: () => {
    readonly requests: number;
    readonly freshFits: number;
    readonly fastTreeMs: number;
  };
}

function parseFasta(text: string): ParsedFasta {
  const names: string[] = [];
  const sequences: string[] = [];
  let name: string | undefined;
  let sequence = "";
  const commit = (): void => {
    if (name === undefined) return;
    names.push(name);
    sequences.push(sequence);
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
  return { names, sequences };
}

function quoteNewick(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

function restoreNames(newick: string, names: readonly string[]): string {
  return newick.replace(/(^|[(,])\s*(\d+)(?=\s*:)/g, (_match, prefix: string, index: string) => {
    const name = names[Number(index)] ?? index;
    return `${prefix}${quoteNewick(name)}`;
  });
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

async function executeFastTree(binary: string, args: readonly string[], fasta: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`FastTree exited ${code}: ${stderr.slice(-500)}`)));
    child.stdin.end(fasta);
  });
}

function segmentFasta(parsed: ParsedFasta, start: number, end: number): string {
  return parsed.sequences.map((sequence, index) => `>${index}\n${sequence.slice(start - 1, end)}`).join("\n");
}

function rangesFasta(parsed: ParsedFasta, ranges: readonly (readonly [number, number])[]): string {
  return parsed.sequences.map((sequence, index) => `>${index}\n${ranges.map(([start, end]) => sequence.slice(start - 1, end)).join("")}`).join("\n");
}

function variableSites(sequences: readonly string[], start: number, end: number): number {
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

export async function runFastTree(
  binary: string,
  fasta: string,
  names: readonly string[],
  start: number,
  end: number,
  fastest = true,
  sharedModel?: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] },
): Promise<SegmentLikelihood> {
  const modelArgs = sharedModel === undefined ? [] : [
    "-gtrfreq", ...sharedModel.gtrFrequencies.map(String),
    "-gtrrates", ...sharedModel.gtrRates.map(String),
  ];
  const args = ["-nt", "-gtr", ...modelArgs, "-nosupport", "-gamma", "-nopr", ...(fastest ? ["-fastest"] : [])];
  const started = performance.now();
  const execution = await executeFastTree(binary, args, fasta);
  const gamma = execution.stderr.match(/Gamma\(\s*20\s*\)\s+LogLk\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i);
  const fallback = Array.from(execution.stderr.matchAll(/LogLk\s*(?:~?=)?\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/gi)).at(-1);
  const logLikelihood = Number(gamma?.[1] ?? fallback?.[1]);
  if (!Number.isFinite(logLikelihood)) throw new Error(`FastTree returned no comparable Gamma20 likelihood: ${execution.stderr.slice(-500)}`);
  const treeLine = execution.stdout.split(/\r?\n/).filter((line) => line.includes("(")).at(-1);
  if (treeLine === undefined) throw new Error("FastTree returned no Newick tree.");
  return {
    start,
    end,
    logLikelihood,
    tree: restoreNames(treeLine.trim(), names),
    variableSites: 0,
    elapsedMs: performance.now() - started,
    ...parseModel(execution.stderr),
  };
}

export function createFastTreeEvaluator(binary: string, alignment: string, fastest = true): FastTreeEvaluator {
  const parsed = parseFasta(alignment);
  const cache = new Map<string, Promise<SegmentLikelihood>>();
  let queue: Promise<unknown> = Promise.resolve();
  let requests = 0;
  let freshFits = 0;
  let fastTreeMs = 0;
  let sharedModel: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] } | undefined;
  const evaluate: SegmentEvaluator = (start, end) => {
    requests += 1;
    const key = `${start}:${end}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    freshFits += 1;
    const sliced = segmentFasta(parsed, start, end);
    const pending = queue.then(() => runFastTree(binary, sliced, parsed.names, start, end, fastest, sharedModel)).then((result) => {
      fastTreeMs += result.elapsedMs;
      if (start === 1 && end === parsed.sequences[0]!.length && result.gtrFrequencies !== undefined && result.gtrRates !== undefined) {
        sharedModel = { gtrFrequencies: result.gtrFrequencies, gtrRates: result.gtrRates };
      }
      return { ...result, variableSites: variableSites(parsed.sequences, start, end) };
    });
    queue = pending.catch(() => undefined);
    cache.set(key, pending);
    return pending;
  };
  const evaluateRanges = (ranges: readonly (readonly [number, number])[]): Promise<SegmentLikelihood> => {
    requests += 1;
    const normalized = ranges.map(([start, end]) => [Math.max(1, Math.round(start)), Math.min(parsed.sequences[0]!.length, Math.round(end))] as const)
      .filter(([start, end]) => end >= start);
    if (normalized.length === 0) return Promise.reject(new Error("At least one non-empty source range is required."));
    const key = `ranges:${normalized.map((range) => range.join("-")).join(",")}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    freshFits += 1;
    const sliced = rangesFasta(parsed, normalized);
    const start = normalized[0]![0];
    const end = normalized.at(-1)![1];
    const pending = queue.then(() => runFastTree(binary, sliced, parsed.names, start, end, fastest, sharedModel)).then((result) => {
      fastTreeMs += result.elapsedMs;
      return { ...result, variableSites: normalized.reduce((sum, [low, high]) => sum + variableSites(parsed.sequences, low, high), 0) };
    });
    queue = pending.catch(() => undefined);
    cache.set(key, pending);
    return pending;
  };
  return { evaluate, evaluateRanges, diagnostics: () => ({ requests, freshFits, fastTreeMs }) };
}
