import type { PartitionSegment } from "../src/index.js";
import type { TrueSegment } from "./simulator.js";

export interface BreakpointInterval {
  readonly breakpoint: number;
  readonly low?: number;
  readonly high?: number;
}

export interface BreakpointAccuracy {
  readonly trueCount: number;
  readonly predictedCount: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly exactCount: boolean;
  readonly localizationMae: number | null;
  readonly localizationRmse: number | null;
  readonly intervalCoverage: number | null;
  readonly meanIntervalWidth: number | null;
  readonly matches: readonly { readonly truth: number; readonly predicted: number; readonly error: number }[];
}

interface MatchSolution {
  readonly matches: readonly { readonly truth: number; readonly predicted: number; readonly error: number }[];
  readonly error: number;
}

function better(first: MatchSolution, second: MatchSolution): MatchSolution {
  if (first.matches.length !== second.matches.length) return first.matches.length > second.matches.length ? first : second;
  return first.error <= second.error ? first : second;
}

/** Exact ordered one-to-one matching: maximize matches, then minimize total absolute error. */
export function matchBreakpoints(
  truthInput: readonly number[],
  predictionsInput: readonly number[],
  tolerance: number,
): MatchSolution {
  const truth = truthInput.slice().sort((a, b) => a - b);
  const predictions = predictionsInput.slice().sort((a, b) => a - b);
  const table: MatchSolution[][] = Array.from({ length: truth.length + 1 }, () => Array.from(
    { length: predictions.length + 1 },
    () => ({ matches: [], error: 0 }),
  ));
  for (let trueIndex = 1; trueIndex <= truth.length; trueIndex += 1) {
    for (let predictionIndex = 1; predictionIndex <= predictions.length; predictionIndex += 1) {
      let solution = better(table[trueIndex - 1]![predictionIndex]!, table[trueIndex]![predictionIndex - 1]!);
      const error = Math.abs(truth[trueIndex - 1]! - predictions[predictionIndex - 1]!);
      if (error <= tolerance) {
        const previous = table[trueIndex - 1]![predictionIndex - 1]!;
        const matched: MatchSolution = {
          matches: [...previous.matches, { truth: truth[trueIndex - 1]!, predicted: predictions[predictionIndex - 1]!, error }],
          error: previous.error + error,
        };
        solution = better(solution, matched);
      }
      table[trueIndex]![predictionIndex] = solution;
    }
  }
  return table[truth.length]![predictions.length]!;
}

export function breakpointAccuracy(
  truth: readonly number[],
  predictions: readonly BreakpointInterval[],
  tolerance: number,
): BreakpointAccuracy {
  const matched = matchBreakpoints(truth, predictions.map((value) => value.breakpoint), tolerance);
  const truePositive = matched.matches.length;
  const falsePositive = predictions.length - truePositive;
  const falseNegative = truth.length - truePositive;
  const precision = predictions.length === 0 ? null : truePositive / predictions.length;
  const recall = truth.length === 0 ? null : truePositive / truth.length;
  const f1Denominator = 2 * truePositive + falsePositive + falseNegative;
  const f1 = f1Denominator === 0 ? null : 2 * truePositive / f1Denominator;
  const errors = matched.matches.map((value) => value.error);
  const intervalPredictions = predictions.filter((value) => value.low !== undefined && value.high !== undefined);
  const coveredTruth = truth.filter((position) => intervalPredictions.some((value) => position >= value.low! && position <= value.high!)).length;
  return {
    trueCount: truth.length,
    predictedCount: predictions.length,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
    exactCount: truth.length === predictions.length,
    localizationMae: errors.length === 0 ? null : errors.reduce((sum, value) => sum + value, 0) / errors.length,
    localizationRmse: errors.length === 0 ? null : Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length),
    intervalCoverage: truth.length === 0 || intervalPredictions.length === 0 ? null : coveredTruth / truth.length,
    meanIntervalWidth: intervalPredictions.length === 0
      ? null
      : intervalPredictions.reduce((sum, value) => sum + value.high! - value.low! + 1, 0) / intervalPredictions.length,
    matches: matched.matches,
  };
}

interface NewickNode {
  readonly name?: string;
  readonly children: readonly NewickNode[];
}

class NewickParser {
  private index = 0;
  constructor(private readonly text: string) {}

  parse(): NewickNode {
    return this.node();
  }

  private node(): NewickNode {
    this.space();
    const children: NewickNode[] = [];
    if (this.text[this.index] === "(") {
      this.index += 1;
      for (;;) {
        children.push(this.node());
        this.space();
        if (this.text[this.index] === ",") { this.index += 1; continue; }
        if (this.text[this.index] === ")") { this.index += 1; break; }
        throw new Error("Malformed Newick tree in simulation benchmark.");
      }
    }
    this.space();
    const name = this.label();
    this.space();
    if (this.text[this.index] === ":") {
      this.index += 1;
      while (this.index < this.text.length && !",();".includes(this.text[this.index]!)) this.index += 1;
    }
    return name.length === 0 ? { children } : { name, children };
  }

  private label(): string {
    if (this.text[this.index] === "'") {
      this.index += 1;
      let value = "";
      while (this.index < this.text.length) {
        const token = this.text[this.index++]!;
        if (token !== "'") { value += token; continue; }
        if (this.text[this.index] === "'") { value += "'"; this.index += 1; continue; }
        break;
      }
      return value;
    }
    const start = this.index;
    while (this.index < this.text.length && !"\t\r\n (),:;[]".includes(this.text[this.index]!)) this.index += 1;
    return this.text.slice(start, this.index);
  }

  private space(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index += 1;
  }
}

function splitSet(tree: string): { readonly tips: readonly string[]; readonly splits: ReadonlySet<string> } {
  const root = new NewickParser(tree).parse();
  const tips: string[] = [];
  const collect = (node: NewickNode): void => {
    if (node.children.length === 0) { if (node.name !== undefined) tips.push(node.name); return; }
    for (const child of node.children) collect(child);
  };
  collect(root);
  tips.sort();
  const universe = new Set(tips);
  const splits = new Set<string>();
  const visit = (node: NewickNode): Set<string> => {
    if (node.children.length === 0) return new Set(node.name === undefined ? [] : [node.name]);
    const descendants = new Set<string>();
    for (const child of node.children) for (const tip of visit(child)) descendants.add(tip);
    if (descendants.size > 1 && descendants.size < universe.size - 1) {
      const first = Array.from(descendants).sort();
      const second = tips.filter((tip) => !descendants.has(tip));
      const canonical = first.length < second.length
        ? first
        : first.length > second.length
          ? second
          : first.join("\0") <= second.join("\0") ? first : second;
      splits.add(canonical.join("\0"));
    }
    return descendants;
  };
  visit(root);
  return { tips, splits };
}

export function normalizedRobinsonFoulds(firstTree: string, secondTree: string): number {
  const first = splitSet(firstTree);
  const second = splitSet(secondTree);
  if (first.tips.join("\0") !== second.tips.join("\0")) throw new Error("RF trees have different tip sets.");
  let symmetricDifference = 0;
  for (const split of first.splits) if (!second.splits.has(split)) symmetricDifference += 1;
  for (const split of second.splits) if (!first.splits.has(split)) symmetricDifference += 1;
  const denominator = Math.max(1, first.splits.size + second.splits.size);
  return symmetricDifference / denominator;
}

/** Alignment-length-weighted RF, integrating every inferred/true segment overlap. */
export function partitionTopologyRf(
  inferred: readonly Pick<PartitionSegment, "start" | "end" | "tree">[],
  truth: readonly TrueSegment[],
): number | null {
  if (inferred.length === 0 || truth.length === 0) return null;
  let weighted = 0;
  let sites = 0;
  for (const estimate of inferred) {
    for (const actual of truth) {
      const overlap = Math.max(0, Math.min(estimate.end, actual.end) - Math.max(estimate.start, actual.start) + 1);
      if (overlap === 0) continue;
      weighted += overlap * normalizedRobinsonFoulds(estimate.tree, actual.tree);
      sites += overlap;
    }
  }
  return sites === 0 ? null : weighted / sites;
}
