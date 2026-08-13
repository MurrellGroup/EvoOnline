import type { MosaicSprAlignment } from "./types.js";

interface GraphNode {
  readonly id: number;
  name?: string;
  readonly edges: Map<number, number>;
}

interface TreeGraph {
  readonly nodes: Map<number, GraphNode>;
  nextId: number;
}

export interface SprMove {
  /** Label-independent identifier within the source topology. */
  readonly id: string;
  readonly fromTopology: string;
  readonly toTopology: string;
  /** The side detached by the directed cut. */
  readonly prunedTaxa: readonly string[];
  /** Canonical split identifying the cut edge in the source topology. */
  readonly sourceSplit: readonly string[];
  /** Edge restored when the source attachment vertex is suppressed, expressed
   * as a canonical split of retained taxa. The inverse edit regrafts here. */
  readonly sourceAttachmentSplit: readonly string[];
  /** Canonical retained-taxon split identifying the edge subdivided on regraft. */
  readonly destinationSplit: readonly string[];
}

export interface SprNeighbor {
  readonly tree: string;
  readonly topologySignature: string;
  /** Several directed SPR descriptions can produce the same neighbour. */
  readonly moves: readonly SprMove[];
}

export function invertSprMove(move: SprMove): SprMove {
  return {
    id: `${move.prunedTaxa.join(",")}:${move.destinationSplit.join(",")}=>${move.sourceAttachmentSplit.join(",")}`,
    fromTopology: move.toTopology,
    toTopology: move.fromTopology,
    prunedTaxa: move.prunedTaxa,
    sourceSplit: move.sourceSplit,
    sourceAttachmentSplit: move.destinationSplit,
    destinationSplit: move.sourceAttachmentSplit,
  };
}

class NewickGraphReader {
  private cursor = 0;
  private readonly graph: TreeGraph = { nodes: new Map(), nextId: 0 };

  constructor(private readonly text: string) {}

  parse(): TreeGraph {
    const root = this.readSubtree();
    // A root length is legal but irrelevant for an unrooted topology.
    this.readLength();
    this.skipSpaceAndComments();
    if (this.text[this.cursor] === ";") this.cursor += 1;
    this.skipSpaceAndComments();
    if (this.cursor !== this.text.length) throw new Error("Unexpected text after the Newick tree.");
    // Newick commonly introduces an artificial degree-two root. An unrooted
    // SPR graph must not treat it as a biological vertex.
    suppressDegreeTwo(this.graph, root);
    suppressAllDegreeTwo(this.graph);
    return this.graph;
  }

  private node(name?: string): GraphNode {
    const value: GraphNode = { id: this.graph.nextId++, edges: new Map(), ...(name === undefined ? {} : { name }) };
    this.graph.nodes.set(value.id, value);
    return value;
  }

  private readSubtree(): number {
    this.skipSpaceAndComments();
    const children: Array<{ readonly id: number; readonly length: number }> = [];
    if (this.text[this.cursor] === "(") {
      this.cursor += 1;
      for (;;) {
        const child = this.readSubtree();
        const length = this.readLength();
        children.push({ id: child, length });
        this.skipSpaceAndComments();
        const token = this.text[this.cursor];
        if (token === ",") { this.cursor += 1; continue; }
        if (token === ")") { this.cursor += 1; break; }
        throw new Error("Malformed Newick child list.");
      }
    }
    this.skipSpaceAndComments();
    const label = this.readLabel();
    // Internal labels are support/ancestral annotations, not taxa. Retaining
    // them would prevent suppression of Newick's artificial degree-two root.
    const current = this.node(children.length === 0 && label.length > 0 ? label : undefined);
    for (const child of children) connect(this.graph, current.id, child.id, child.length);
    return current.id;
  }

  private readLength(): number {
    this.skipSpaceAndComments();
    if (this.text[this.cursor] !== ":") return 0.1;
    this.cursor += 1;
    this.skipSpaceAndComments();
    const start = this.cursor;
    while (this.cursor < this.text.length && !",();[]\t\r\n ".includes(this.text[this.cursor]!)) this.cursor += 1;
    const parsed = Number(this.text.slice(start, this.cursor));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.max(1e-8, parsed) : 0.1;
  }

  private readLabel(): string {
    this.skipSpaceAndComments();
    if (this.text[this.cursor] === "'") {
      this.cursor += 1;
      let output = "";
      while (this.cursor < this.text.length) {
        const token = this.text[this.cursor++]!;
        if (token !== "'") { output += token; continue; }
        if (this.text[this.cursor] === "'") { output += "'"; this.cursor += 1; continue; }
        return output;
      }
      throw new Error("Unterminated quoted Newick label.");
    }
    const start = this.cursor;
    while (this.cursor < this.text.length && !"\t\r\n (),:;[]".includes(this.text[this.cursor]!)) this.cursor += 1;
    return this.text.slice(start, this.cursor);
  }

  private skipSpaceAndComments(): void {
    for (;;) {
      while (/\s/.test(this.text[this.cursor] ?? "")) this.cursor += 1;
      if (this.text[this.cursor] !== "[") return;
      const end = this.text.indexOf("]", this.cursor + 1);
      if (end < 0) throw new Error("Unterminated Newick comment.");
      this.cursor = end + 1;
    }
  }
}

function connect(graph: TreeGraph, first: number, second: number, length = 0.1): void {
  graph.nodes.get(first)!.edges.set(second, Math.max(1e-8, length));
  graph.nodes.get(second)!.edges.set(first, Math.max(1e-8, length));
}

function disconnect(graph: TreeGraph, first: number, second: number): number {
  const length = graph.nodes.get(first)!.edges.get(second) ?? 0.1;
  graph.nodes.get(first)!.edges.delete(second);
  graph.nodes.get(second)!.edges.delete(first);
  return length;
}

function cloneGraph(source: TreeGraph): TreeGraph {
  return {
    nextId: source.nextId,
    nodes: new Map(Array.from(source.nodes, ([id, node]) => [id, { id, ...(node.name === undefined ? {} : { name: node.name }), edges: new Map(node.edges) }])),
  };
}

function suppressDegreeTwo(graph: TreeGraph, id: number): void {
  const node = graph.nodes.get(id);
  if (node === undefined || node.name !== undefined || node.edges.size !== 2) return;
  const entries = Array.from(node.edges);
  const [first, firstLength] = entries[0]!;
  const [second, secondLength] = entries[1]!;
  disconnect(graph, id, first);
  disconnect(graph, id, second);
  graph.nodes.delete(id);
  connect(graph, first, second, firstLength + secondLength);
}

function suppressAllDegreeTwo(graph: TreeGraph): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes.values()) {
      if (node.name === undefined && node.edges.size === 2) {
        suppressDegreeTwo(graph, node.id);
        changed = true;
        break;
      }
    }
  }
}

function tipNames(graph: TreeGraph, start?: number, blocked?: number): string[] {
  const output: string[] = [];
  if (start === undefined) {
    for (const node of graph.nodes.values()) if (node.edges.size <= 1 && node.name !== undefined) output.push(node.name);
  } else {
    const stack: Array<readonly [number, number]> = [[start, blocked ?? -1]];
    while (stack.length > 0) {
      const [id, parent] = stack.pop()!;
      const node = graph.nodes.get(id)!;
      if (node.edges.size <= 1 && node.name !== undefined) output.push(node.name);
      for (const neighbor of node.edges.keys()) if (neighbor !== parent) stack.push([neighbor, id]);
    }
  }
  return output.sort();
}

function componentNodes(graph: TreeGraph, start: number): Set<number> {
  const output = new Set<number>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (output.has(id)) continue;
    output.add(id);
    for (const neighbor of graph.nodes.get(id)!.edges.keys()) if (!output.has(neighbor)) stack.push(neighbor);
  }
  return output;
}

function canonicalSide(side: readonly string[], all: readonly string[]): string[] {
  const selected = new Set(side);
  const complement = all.filter((name) => !selected.has(name));
  if (side.length < complement.length) return side.slice().sort();
  if (side.length > complement.length) return complement;
  const first = side.slice().sort();
  return first.join("\0").localeCompare(complement.join("\0")) <= 0 ? first : complement;
}

function edgeSplit(graph: TreeGraph, first: number, second: number, all: readonly string[]): string[] {
  return canonicalSide(tipNames(graph, second, first), all);
}

function escapeLabel(label: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(label) ? label : `'${label.replaceAll("'", "''")}'`;
}

function formatLength(value: number): string {
  return Math.max(1e-8, value).toPrecision(8).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
}

function serializeGraph(graph: TreeGraph): string {
  const internals = Array.from(graph.nodes.values()).filter((node) => node.edges.size > 1);
  const root = (internals.length > 0 ? internals : Array.from(graph.nodes.values()))
    .sort((a, b) => a.id - b.id)[0];
  if (root === undefined) throw new Error("Cannot serialize an empty tree.");
  const visit = (id: number, parent: number): string => {
    const node = graph.nodes.get(id)!;
    const children = Array.from(node.edges.keys()).filter((neighbor) => neighbor !== parent);
    const body = children.length === 0
      ? escapeLabel(node.name ?? `node_${id}`)
      : `(${children.map((child) => `${visit(child, id)}:${formatLength(node.edges.get(child)!)}`).sort().join(",")})`;
    return body;
  };
  return `${visit(root.id, -1)};`;
}

function splitKeys(graph: TreeGraph): { readonly taxa: string[]; readonly keys: string[] } {
  const taxa = tipNames(graph);
  const keys: string[] = [];
  for (const node of graph.nodes.values()) {
    for (const neighbor of node.edges.keys()) {
      if (node.id >= neighbor) continue;
      const side = edgeSplit(graph, node.id, neighbor, taxa);
      if (side.length > 1 && side.length < taxa.length - 1) keys.push(side.join("\0"));
    }
  }
  return { taxa, keys: Array.from(new Set(keys)).sort() };
}

function graphTopologySignature(graph: TreeGraph): string {
  const parsed = splitKeys(graph);
  return `${parsed.taxa.join("\0")}::${parsed.keys.join("|")}`;
}

export function topologySignature(tree: string): string {
  return graphTopologySignature(new NewickGraphReader(tree).parse());
}

/** Robinson-Foulds split distance divided by two (the number of splits unique
 * to either resolved topology). It is a search guide, not an SPR distance. */
export function topologySplitDistance(first: string, second: string): number {
  const left = splitKeys(new NewickGraphReader(first).parse());
  const right = splitKeys(new NewickGraphReader(second).parse());
  if (left.taxa.join("\0") !== right.taxa.join("\0")) return Number.POSITIVE_INFINITY;
  const rightSet = new Set(right.keys);
  let unique = left.keys.reduce((sum, key) => sum + (rightSet.has(key) ? 0 : 1), 0);
  const leftSet = new Set(left.keys);
  unique += right.keys.reduce((sum, key) => sum + (leftSet.has(key) ? 0 : 1), 0);
  return unique / 2;
}

/** Enumerate the complete one-unrooted-SPR neighbourhood of a resolved tree.
 * No assumption is made about which move is active elsewhere in the genome. */
export function enumerateSprNeighbors(tree: string): SprNeighbor[] {
  const source = new NewickGraphReader(tree).parse();
  const all = tipNames(source);
  if (all.length < 4) return [];
  const fromTopology = graphTopologySignature(source);
  const output = new Map<string, { tree: string; moves: SprMove[] }>();
  const sourceEdges: Array<readonly [number, number]> = [];
  for (const node of source.nodes.values()) for (const neighbor of node.edges.keys()) if (node.id < neighbor) sourceEdges.push([node.id, neighbor]);

  for (const [edgeA, edgeB] of sourceEdges) {
    for (const [baseId, pruneId] of [[edgeA, edgeB], [edgeB, edgeA]] as const) {
      const prunedTaxa = tipNames(source, pruneId, baseId);
      if (prunedTaxa.length === 0 || all.length - prunedTaxa.length < 2) continue;
      const sourceSplit = canonicalSide(prunedTaxa, all);
      const cut = cloneGraph(source);
      const cutLength = disconnect(cut, baseId, pruneId);
      const sourceAttachment = Array.from(cut.nodes.get(baseId)!.edges.keys());
      if (sourceAttachment.length !== 2) continue;
      suppressDegreeTwo(cut, baseId);
      const retainedTaxa = all.filter((name) => !prunedTaxa.includes(name));
      const retainedTaxon = retainedTaxa[0];
      if (retainedTaxon === undefined) continue;
      const sourceAttachmentSplit = edgeSplit(cut, sourceAttachment[0]!, sourceAttachment[1]!, retainedTaxa);
      const retainedTip = Array.from(cut.nodes.values()).find((node) => node.name === retainedTaxon);
      if (retainedTip === undefined) continue;
      const retainedNodes = componentNodes(cut, retainedTip.id);
      const destinationEdges: Array<readonly [number, number]> = [];
      for (const nodeId of retainedNodes) {
        const node = cut.nodes.get(nodeId)!;
        for (const neighbor of node.edges.keys()) {
          if (node.id >= neighbor || !retainedNodes.has(neighbor)) continue;
          destinationEdges.push([node.id, neighbor]);
        }
      }
      for (const [first, second] of destinationEdges) {
        const candidate = cloneGraph(cut);
        const destinationSplit = edgeSplit(candidate, first, second, retainedTaxa);
        const length = disconnect(candidate, first, second);
        const join = candidate.nextId++;
        candidate.nodes.set(join, { id: join, edges: new Map() });
        connect(candidate, first, join, length / 2);
        connect(candidate, second, join, length / 2);
        connect(candidate, join, pruneId, cutLength);
        const nextTree = serializeGraph(candidate);
        const toTopology = graphTopologySignature(candidate);
        if (toTopology === fromTopology) continue;
        const move: SprMove = {
          id: `${prunedTaxa.join(",")}:${sourceAttachmentSplit.join(",")}=>${destinationSplit.join(",")}`,
          fromTopology,
          toTopology,
          prunedTaxa,
          sourceSplit,
          sourceAttachmentSplit,
          destinationSplit,
        };
        const previous = output.get(toTopology);
        if (previous === undefined) output.set(toTopology, { tree: nextTree, moves: [move] });
        else if (!previous.moves.some((item) => item.id === move.id)) previous.moves.push(move);
      }
    }
  }
  return Array.from(output, ([topologySignature, value]) => ({ tree: value.tree, topologySignature, moves: value.moves }))
    .sort((a, b) => a.topologySignature.localeCompare(b.topologySignature));
}

function sameTaxa(first: readonly string[], second: ReadonlySet<string>): boolean {
  return first.length === second.size && first.every((name) => second.has(name));
}

/** Apply a recorded edit by taxon-labelled cut and retained-tree destination
 * splits. This is used to validate that exported edit tapes are executable. */
export function applySprMove(tree: string, move: SprMove): string {
  const graph = new NewickGraphReader(tree).parse();
  const all = tipNames(graph);
  if (graphTopologySignature(graph) !== move.fromTopology) throw new Error("SPR edit source topology does not match the supplied tree.");
  const pruned = new Set(move.prunedTaxa);
  let directedCut: readonly [number, number] | undefined;
  for (const node of graph.nodes.values()) {
    for (const neighbor of node.edges.keys()) {
      if (sameTaxa(tipNames(graph, neighbor, node.id), pruned)) {
        directedCut = [node.id, neighbor];
        break;
      }
    }
    if (directedCut !== undefined) break;
  }
  if (directedCut === undefined) throw new Error("The recorded pruned subtree is not an edge component of the source tree.");
  const [baseId, pruneId] = directedCut;
  const cutLength = disconnect(graph, baseId, pruneId);
  suppressDegreeTwo(graph, baseId);
  const retainedTaxa = all.filter((name) => !pruned.has(name));
  const retainedTipName = retainedTaxa[0];
  if (retainedTipName === undefined) throw new Error("An SPR edit cannot prune the complete tree.");
  const retainedTip = Array.from(graph.nodes.values()).find((node) => node.name === retainedTipName)!;
  const retainedNodes = componentNodes(graph, retainedTip.id);
  const destinationKey = move.destinationSplit.slice().sort().join("\0");
  let destination: readonly [number, number] | undefined;
  for (const nodeId of retainedNodes) {
    const node = graph.nodes.get(nodeId)!;
    for (const neighbor of node.edges.keys()) {
      if (node.id >= neighbor || !retainedNodes.has(neighbor)) continue;
      if (edgeSplit(graph, node.id, neighbor, retainedTaxa).join("\0") === destinationKey) {
        destination = [node.id, neighbor];
        break;
      }
    }
    if (destination !== undefined) break;
  }
  if (destination === undefined) throw new Error("The recorded retained-tree destination split is absent.");
  const [first, second] = destination;
  const length = disconnect(graph, first, second);
  const join = graph.nextId++;
  graph.nodes.set(join, { id: join, edges: new Map() });
  connect(graph, first, join, length / 2);
  connect(graph, second, join, length / 2);
  connect(graph, join, pruneId, cutLength);
  const output = serializeGraph(graph);
  if (graphTopologySignature(graph) !== move.toTopology) throw new Error("Applying the recorded SPR edit did not produce its declared target topology.");
  return output;
}

/** Exact Fitch parsimony cost at every aligned site for a labelled tree. */
export function fitchParsimonyBySite(tree: string, alignment: MosaicSprAlignment): Uint16Array {
  const graph = new NewickGraphReader(tree).parse();
  const taxa = tipNames(graph);
  if (taxa.length !== alignment.taxa || taxa.some((name, index) => name !== alignment.names.slice().sort()[index])) {
    throw new Error("Tree and alignment taxon labels do not match exactly.");
  }
  const taxonIndex = new Map(alignment.names.map((name, index) => [name, index]));
  const root = Array.from(graph.nodes.values()).find((node) => node.edges.size > 1) ?? Array.from(graph.nodes.values())[0]!;
  const order: number[] = [];
  const parent = new Map<number, number>([[root.id, -1]]);
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    order.push(id);
    for (const neighbor of graph.nodes.get(id)!.edges.keys()) if (neighbor !== parent.get(id)) {
      parent.set(neighbor, id);
      stack.push(neighbor);
    }
  }
  const masks = new Uint8Array(graph.nextId);
  const output = new Uint16Array(alignment.sites);
  for (let site = 0; site < alignment.sites; site += 1) {
    let changes = 0;
    for (let cursor = order.length - 1; cursor >= 0; cursor -= 1) {
      const id = order[cursor]!;
      const node = graph.nodes.get(id)!;
      if (node.edges.size <= 1) {
        const index = taxonIndex.get(node.name ?? "");
        if (index === undefined) throw new Error(`Tree tip '${node.name ?? ""}' is absent from the alignment.`);
        const code = alignment.matrix[site * alignment.taxa + index]!;
        masks[id] = code < 4 ? 1 << code : 0b1111;
        continue;
      }
      let combined = 0;
      let initialized = false;
      for (const neighbor of node.edges.keys()) {
        if (neighbor === parent.get(id)) continue;
        const child = masks[neighbor]!;
        if (!initialized) { combined = child; initialized = true; continue; }
        const intersection = combined & child;
        if (intersection === 0) { combined |= child; changes += 1; }
        else combined = intersection;
      }
      masks[id] = initialized ? combined : 0b1111;
    }
    output[site] = changes;
  }
  return output;
}
