import {
  FixedGtrModel,
  LinkedTreeLikelihood,
  compileLinkedTree,
  discreteGammaRates,
} from "@phylo-workbench/phylo-likelihood";
import { parseFsartFasta } from "./alignment.js";
import type { TreeEmissionProfile } from "./types.js";

export interface FrozenTreeCandidate {
  readonly id: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sourceRanges?: readonly (readonly [number, number])[];
  /** The complete fitted tree, including its source-window branch lengths. */
  readonly tree: string;
  readonly topologySignature: string;
  /** The Gamma shape fitted on exactly this tree's source window(s). */
  readonly gammaAlpha: number;
}

export interface FixedTreeGtrModel {
  readonly gtrFrequencies: readonly number[];
  readonly gtrRates: readonly number[];
}

interface ParsedNode {
  readonly name?: string;
  readonly length?: number;
  readonly children: readonly ParsedNode[];
  readonly synthetic?: boolean;
}

class NewickParser {
  private position = 0;

  constructor(private readonly text: string) {}

  parse(): ParsedNode {
    this.skipIgnored();
    const root = this.node();
    this.skipIgnored();
    if (this.peek() === ";") this.position += 1;
    this.skipIgnored();
    if (this.position !== this.text.length) throw new Error(`Unexpected Newick content near character ${this.position + 1}.`);
    return root;
  }

  private node(): ParsedNode {
    this.skipIgnored();
    const children: ParsedNode[] = [];
    if (this.peek() === "(") {
      this.position += 1;
      for (;;) {
        children.push(this.node());
        this.skipIgnored();
        if (this.peek() === ",") { this.position += 1; continue; }
        if (this.peek() !== ")") throw new Error(`Expected ',' or ')' near Newick character ${this.position + 1}.`);
        this.position += 1;
        break;
      }
    }
    this.skipIgnored();
    const name = this.optionalLabel();
    this.skipIgnored();
    let length: number | undefined;
    if (this.peek() === ":") {
      this.position += 1;
      this.skipIgnored();
      const start = this.position;
      while (this.position < this.text.length && !/[\s,();\[\]]/.test(this.text[this.position]!)) this.position += 1;
      const token = this.text.slice(start, this.position);
      length = Number(token);
      if (token.length === 0 || !Number.isFinite(length) || length < 0) throw new Error(`Invalid fitted branch length '${token}'.`);
    }
    if (children.length === 0 && name.length === 0) throw new Error("Every fitted-tree tip must have a name.");
    return {
      ...(name.length === 0 ? {} : { name }),
      ...(length === undefined ? {} : { length }),
      children,
    };
  }

  private optionalLabel(): string {
    const quote = this.peek();
    if (quote === "'" || quote === '"') {
      this.position += 1;
      let output = "";
      while (this.position < this.text.length) {
        const token = this.text[this.position++]!;
        if (token !== quote) { output += token; continue; }
        if (this.peek() === quote) { output += quote; this.position += 1; continue; }
        return output;
      }
      throw new Error("Unterminated quoted Newick label.");
    }
    const start = this.position;
    while (this.position < this.text.length && !/[\s(),:;\[\]]/.test(this.text[this.position]!)) this.position += 1;
    return this.text.slice(start, this.position);
  }

  private skipIgnored(): void {
    for (;;) {
      while (/\s/.test(this.peek())) this.position += 1;
      if (this.peek() !== "[") return;
      let depth = 0;
      do {
        const token = this.text[this.position++]!;
        if (token === "[") depth += 1;
        else if (token === "]") depth -= 1;
        if (this.position > this.text.length) throw new Error("Unterminated Newick comment.");
      } while (depth > 0 && this.position < this.text.length);
      if (depth !== 0) throw new Error("Unterminated Newick comment.");
    }
  }

  private peek(): string { return this.text[this.position] ?? ""; }
}

const IUPAC: Readonly<Record<string, number>> = {
  A: 1, C: 2, G: 4, T: 8, U: 8,
  R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3,
  B: 14, D: 13, H: 11, V: 7, N: 15,
  "-": 0, ".": 0, "?": 0,
};

function binaryRoot(root: ParsedNode): ParsedNode {
  if (root.children.length === 2) return root;
  if (root.children.length !== 3) throw new Error(`A resolved unrooted fitted tree must have two or three root children; found ${root.children.length}.`);
  const [first, second, third] = root.children;
  return {
    ...root,
    children: [
      first!,
      { children: [second!, third!], length: 0, synthetic: true },
    ],
  };
}

function compileFrozenTree(treeText: string, names: readonly string[]): {
  readonly tree: ReturnType<typeof compileLinkedTree>;
  readonly lengths: Float64Array;
} {
  const root = binaryRoot(new NewickParser(treeText).parse());
  const taxonByName = new Map(names.map((name, index) => [name, index]));
  const seenTaxa = new Set<number>();
  const childA: number[] = [];
  const childB: number[] = [];
  const leaf: number[] = [];
  const atomicEdgesByNode: Int32Array[] = [];
  const lengths: number[] = [];
  const build = (node: ParsedNode, isRoot: boolean): number => {
    const id = childA.length;
    childA.push(-1);
    childB.push(-1);
    leaf.push(-1);
    if (isRoot || node.synthetic === true) atomicEdgesByNode.push(new Int32Array(0));
    else {
      if (node.length === undefined) throw new Error(`The fitted tree is missing a branch length${node.name === undefined ? "" : ` for '${node.name}'`}.`);
      const edge = lengths.length;
      lengths.push(node.length);
      atomicEdgesByNode.push(Int32Array.of(edge));
    }
    if (node.children.length === 0) {
      const taxon = taxonByName.get(node.name ?? "");
      if (taxon === undefined) throw new Error(`Fitted-tree tip '${node.name ?? ""}' is absent from the alignment.`);
      if (seenTaxa.has(taxon)) throw new Error(`Fitted-tree tip '${node.name}' occurs more than once.`);
      seenTaxa.add(taxon);
      leaf[id] = taxon;
      return id;
    }
    if (node.children.length !== 2) throw new Error("Every non-root fitted-tree node must be bifurcating.");
    childA[id] = build(node.children[0]!, false);
    childB[id] = build(node.children[1]!, false);
    return id;
  };
  const rootId = build(root, true);
  if (seenTaxa.size !== names.length) {
    const missing = names.filter((_name, index) => !seenTaxa.has(index));
    throw new Error(`The fitted tree is missing alignment tip${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }
  const compiled = compileLinkedTree({
    id: "fsart-frozen-tree",
    root: rootId,
    childA: Int32Array.from(childA),
    childB: Int32Array.from(childB),
    leaf: Int32Array.from(leaf),
    atomicEdgesByNode,
  });
  return { tree: compiled, lengths: Float64Array.from(lengths) };
}

/**
 * Score every alignment site under the complete source-window fit without
 * changing its topology, branch lengths, or Gamma shape. Source coordinates
 * are metadata only; no whole-alignment columns are mixed into parameter
 * estimation and no columns are duplicated for weighting.
 */
export function scoreFrozenTreeProfile(
  alignmentText: string,
  candidate: FrozenTreeCandidate,
  modelInput: FixedTreeGtrModel,
  rateCategories = 20,
): TreeEmissionProfile {
  const started = performance.now();
  if (!(candidate.gammaAlpha > 0) || !Number.isFinite(candidate.gammaAlpha)) {
    throw new Error(`Tree '${candidate.id}' has no valid source-fitted Gamma shape.`);
  }
  const alignment = parseFsartFasta(alignmentText);
  const masks = new Uint8Array(alignment.taxa * alignment.sites);
  for (let site = 0; site < alignment.sites; site += 1) {
    for (let taxon = 0; taxon < alignment.taxa; taxon += 1) {
      const symbol = alignment.sequences[taxon]![site]!;
      const mask = IUPAC[symbol];
      if (mask === undefined) throw new Error(`Unsupported nucleotide symbol '${symbol}' in '${alignment.names[taxon]}', site ${site + 1}.`);
      masks[site * alignment.taxa + taxon] = mask;
    }
  }
  const frozen = compileFrozenTree(candidate.tree, alignment.names);
  const model = new FixedGtrModel({
    frequencies: modelInput.gtrFrequencies,
    exchangeabilities: modelInput.gtrRates,
  });
  const likelihood = new LinkedTreeLikelihood(
    { taxa: alignment.taxa, sites: alignment.sites, masks },
    [frozen.tree],
    model,
    discreteGammaRates(candidate.gammaAlpha, rateCategories),
  );
  const siteLogLikelihoods = likelihood.siteLogLikelihoods(frozen.lengths);
  const logLikelihood = siteLogLikelihoods.reduce((sum, value) => sum + value, 0);
  return {
    ...candidate,
    logLikelihood,
    siteLogLikelihoods,
    elapsedMs: performance.now() - started,
  };
}
