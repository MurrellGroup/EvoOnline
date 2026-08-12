import type { DiscordantClade, PartitionSegment } from "./types.js";

interface Node {
  name?: string;
  children: Node[];
}

class NewickReader {
  private index = 0;
  constructor(private readonly text: string) {}

  parse(): Node {
    const root = this.node();
    return root;
  }

  private node(): Node {
    this.space();
    const children: Node[] = [];
    if (this.text[this.index] === "(") {
      this.index += 1;
      for (;;) {
        children.push(this.node());
        this.space();
        const token = this.text[this.index];
        if (token === ",") { this.index += 1; continue; }
        if (token === ")") { this.index += 1; break; }
        throw new Error("Malformed Newick tree.");
      }
    }
    this.space();
    const name = this.label();
    this.space();
    if (this.text[this.index] === ":") {
      this.index += 1;
      while (this.index < this.text.length && !",();".includes(this.text[this.index]!)) this.index += 1;
    }
    return { ...(name.length === 0 ? {} : { name }), children };
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
    while (this.index < this.text.length) {
      if (/\s/.test(this.text[this.index]!)) { this.index += 1; continue; }
      if (this.text[this.index] === "[") {
        const end = this.text.indexOf("]", this.index + 1);
        this.index = end < 0 ? this.text.length : end + 1;
        continue;
      }
      break;
    }
  }
}

function splitMap(tree: string): { readonly taxa: readonly string[]; readonly splits: Map<string, string[]> } {
  const root = new NewickReader(tree).parse();
  const all: string[] = [];
  const collectTips = (node: Node): void => {
    if (node.children.length === 0) {
      if (node.name !== undefined) all.push(node.name);
      return;
    }
    for (const child of node.children) collectTips(child);
  };
  collectTips(root);
  const universe = new Set(all);
  const output = new Map<string, string[]>();
  const visit = (node: Node): Set<string> => {
    if (node.children.length === 0) return new Set(node.name === undefined ? [] : [node.name]);
    const descendants = new Set<string>();
    for (const child of node.children) for (const name of visit(child)) descendants.add(name);
    if (descendants.size > 1 && descendants.size < universe.size - 1) {
      const complement = Array.from(universe).filter((name) => !descendants.has(name));
      const side = descendants.size < complement.length
        ? Array.from(descendants)
        : descendants.size > complement.length
          ? complement
          : [Array.from(descendants).sort(), complement.sort()].sort((a, b) => a.join("\0").localeCompare(b.join("\0")))[0]!;
      side.sort();
      output.set(side.join("\0"), side);
    }
    return descendants;
  };
  visit(root);
  return { taxa: all.slice().sort(), splits: output };
}

/** Branch-length- and rooting-independent identity for a labelled unrooted topology. */
export function canonicalTopologySignature(tree: string): string {
  const parsed = splitMap(tree);
  return `${parsed.taxa.join("\0")}::${Array.from(parsed.splits.keys()).sort().join("|")}`;
}

/** FastTree's fixed-topology optimizer requires a fully bifurcating unrooted
 * tree. A resolved n-tip tree has exactly n-3 distinct non-trivial splits,
 * independent of where its Newick representation was rooted. */
export function isFullyResolvedTopology(tree: string): boolean {
  const parsed = splitMap(tree);
  return parsed.taxa.length >= 3 && parsed.splits.size === Math.max(0, parsed.taxa.length - 3);
}

/**
 * Cheap, explicitly exploratory moved-subtree candidates. These are symmetric
 * split differences, not a claimed minimum-SPR reconstruction.
 */
export function findDiscordantClades(segments: readonly PartitionSegment[], maximumPerBoundary = 12): DiscordantClade[] {
  const output: DiscordantClade[] = [];
  const ordered = segments.slice().sort((a, b) => a.start - b.start);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    const leftSplits = splitMap(left.tree).splits;
    const rightSplits = splitMap(right.tree).splits;
    const candidates: DiscordantClade[] = [];
    for (const [key, taxa] of leftSplits) if (!rightSplits.has(key)) candidates.push({ betweenSegments: [left.id, right.id], direction: "lost", taxa, size: taxa.length });
    for (const [key, taxa] of rightSplits) if (!leftSplits.has(key)) candidates.push({ betweenSegments: [left.id, right.id], direction: "gained", taxa, size: taxa.length });
    output.push(...candidates.sort((a, b) => a.size - b.size || a.taxa.join().localeCompare(b.taxa.join())).slice(0, maximumPerBoundary));
  }
  return output;
}
