import {
  inspectRootedSprMove,
  leafSet,
  treeSignature,
  type InternalSprMove,
  type RootedNode,
} from "./tree.js";

export type NetworkNodeKind = "root" | "tree" | "attachment" | "reticulation" | "leaf";

export interface NetworkNode {
  readonly id: number;
  kind: NetworkNodeKind;
  readonly leaf?: number;
  parents: number[];
  children: number[];
}

export interface CompiledReticulation {
  readonly bit: number;
  readonly move: InternalSprMove;
  readonly sourceContextMask: number;
  readonly sourceContextSignature: string;
  readonly reticulationNode: number;
  readonly backgroundParentNode: number;
  readonly alternateParentNode: number;
  readonly recipientChildNode: number;
  readonly donorChildNode: number;
}

export interface SwitchingNetwork {
  root: number;
  readonly nodes: NetworkNode[];
  readonly reticulations: CompiledReticulation[];
}

export interface NetworkDisplay {
  readonly tree: RootedNode;
  readonly signature: string;
  readonly edgeOrigins: ReadonlyMap<string, readonly Readonly<{ readonly parent: number; readonly child: number }>[] >;
}

const cladeKey = (values: readonly number[]): string => [...values].sort((a, b) => a - b).join(",");

export function treeNetwork(root: RootedNode): SwitchingNetwork {
  const nodes: NetworkNode[] = [];
  const build = (node: RootedNode, parent: number | undefined): number => {
    const id = nodes.length;
    const isLeaf = "leaf" in node;
    nodes.push({ id, kind: isLeaf ? "leaf" : parent === undefined ? "root" : "tree", ...(isLeaf ? { leaf: node.leaf } : {}), parents: parent === undefined ? [] : [parent], children: [] });
    if (!isLeaf) {
      for (const child of node.children) nodes[id]!.children.push(build(child, id));
    }
    return id;
  };
  const rootId = build(root, undefined);
  return { root: rootId, nodes, reticulations: [] };
}

export function cloneNetwork(network: SwitchingNetwork): SwitchingNetwork {
  return {
    root: network.root,
    nodes: network.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
    reticulations: network.reticulations.map((event) => ({ ...event, move: { ...event.move } })),
  };
}

function selectedParent(network: SwitchingNetwork, node: NetworkNode, mask: number): number | undefined {
  if (node.kind !== "reticulation") return node.parents[0];
  const event = network.reticulations.find((candidate) => candidate.reticulationNode === node.id);
  if (event === undefined) return undefined;
  return node.parents[(mask & (1 << event.bit)) === 0 ? 0 : 1];
}

interface Rendered {
  readonly tree: RootedNode;
  readonly leading: readonly Readonly<{ readonly parent: number; readonly child: number }>[];
  readonly origins: Map<string, readonly Readonly<{ readonly parent: number; readonly child: number }>[] >;
}

export function displayNetwork(network: SwitchingNetwork, mask: number): NetworkDisplay | undefined {
  const visiting = new Uint8Array(network.nodes.length);
  const render = (nodeId: number): Rendered | undefined => {
    if (visiting[nodeId] !== 0) return undefined;
    visiting[nodeId] = 1;
    const node = network.nodes[nodeId];
    if (node === undefined) return undefined;
    if (node.kind === "leaf") {
      visiting[nodeId] = 0;
      return { tree: { leaf: node.leaf! }, leading: [], origins: new Map() };
    }
    const children: { readonly edge: Readonly<{ readonly parent: number; readonly child: number }>; readonly rendered: Rendered }[] = [];
    for (const childId of node.children) {
      const child = network.nodes[childId];
      if (child === undefined || selectedParent(network, child, mask) !== nodeId) continue;
      const rendered = render(childId);
      if (rendered !== undefined) children.push({ edge: { parent: nodeId, child: childId }, rendered });
    }
    visiting[nodeId] = 0;
    if (children.length === 0) return undefined;
    if (children.length === 1) {
      const child = children[0]!;
      return { tree: child.rendered.tree, leading: [child.edge, ...child.rendered.leading], origins: child.rendered.origins };
    }
    if (children.length !== 2) return undefined;
    const origins = new Map<string, readonly Readonly<{ readonly parent: number; readonly child: number }>[] >();
    for (const child of children) {
      for (const [key, path] of child.rendered.origins) origins.set(key, path);
      origins.set(cladeKey(leafSet(child.rendered.tree)), [child.edge, ...child.rendered.leading]);
    }
    return { tree: { children: [children[0]!.rendered.tree, children[1]!.rendered.tree] }, leading: [], origins };
  };
  const rendered = render(network.root);
  if (rendered === undefined) return undefined;
  const observedLeaves = leafSet(rendered.tree);
  const expectedLeaves = network.nodes.filter((node) => node.kind === "leaf").map((node) => node.leaf!).sort((a, b) => a - b);
  if (cladeKey(observedLeaves) !== cladeKey(expectedLeaves)) return undefined;
  return { tree: rendered.tree, signature: treeSignature(rendered.tree), edgeOrigins: rendered.origins };
}

function removeChild(network: SwitchingNetwork, parent: number, child: number): boolean {
  const children = network.nodes[parent]?.children;
  if (children === undefined) return false;
  const index = children.indexOf(child);
  if (index < 0) return false;
  children.splice(index, 1);
  return true;
}

function removeParent(network: SwitchingNetwork, child: number, parent: number): boolean {
  const parents = network.nodes[child]?.parents;
  if (parents === undefined) return false;
  const index = parents.indexOf(parent);
  if (index < 0) return false;
  parents.splice(index, 1);
  return true;
}

function addEdge(network: SwitchingNetwork, parent: number, child: number): void {
  if (!network.nodes[parent]!.children.includes(child)) network.nodes[parent]!.children.push(child);
  if (!network.nodes[child]!.parents.includes(parent)) network.nodes[child]!.parents.push(parent);
}

function replaceEdge(network: SwitchingNetwork, parent: number, child: number, middle: number): boolean {
  if (!removeChild(network, parent, child) || !removeParent(network, child, parent)) return false;
  addEdge(network, parent, middle);
  addEdge(network, middle, child);
  return true;
}

function exactDisplayUniverse(network: SwitchingNetwork): readonly NetworkDisplay[] | undefined {
  const count = 1 << network.reticulations.length;
  const displays: NetworkDisplay[] = [];
  for (let mask = 0; mask < count; mask += 1) {
    const display = displayNetwork(network, mask);
    if (display === undefined) return undefined;
    displays.push(display);
  }
  return displays;
}

export function compileReticulation(networkInput: SwitchingNetwork, contextMask: number, move: InternalSprMove): SwitchingNetwork | undefined {
  const beforeUniverse = exactDisplayUniverse(networkInput);
  const context = beforeUniverse?.[contextMask];
  if (beforeUniverse === undefined || context === undefined) return undefined;
  const desired = inspectRootedSprMove(context.tree, move);
  if (desired.status !== "applied") return undefined;
  const sourcePath = context.edgeOrigins.get(cladeKey(move.pruned));
  const destinationPath = move.destinationIsRoot ? undefined : context.edgeOrigins.get(cladeKey(move.destination));
  if (sourcePath === undefined || sourcePath.length === 0 || (!move.destinationIsRoot && (destinationPath === undefined || destinationPath.length === 0))) return undefined;
  const sourceEdge = sourcePath[sourcePath.length - 1]!;
  const destinationEdge = destinationPath?.[destinationPath.length - 1];
  if (destinationEdge !== undefined && sourceEdge.parent === destinationEdge.parent && sourceEdge.child === destinationEdge.child) return undefined;

  const network = cloneNetwork(networkInput);
  const bit = network.reticulations.length;
  const reticulationId = network.nodes.length;
  network.nodes.push({ id: reticulationId, kind: "reticulation", parents: [], children: [] });
  if (!replaceEdge(network, sourceEdge.parent, sourceEdge.child, reticulationId)) return undefined;
  const attachmentId = network.nodes.length;
  network.nodes.push({ id: attachmentId, kind: move.destinationIsRoot ? "root" : "attachment", parents: [], children: [] });
  let donorChild: number;
  if (move.destinationIsRoot) {
    donorChild = network.root;
    network.nodes[network.root]!.kind = "tree";
    addEdge(network, attachmentId, network.root);
    network.root = attachmentId;
  } else {
    donorChild = destinationEdge!.child;
    if (!replaceEdge(network, destinationEdge!.parent, destinationEdge!.child, attachmentId)) return undefined;
  }
  addEdge(network, attachmentId, reticulationId);
  // Reticulation parent ordering is semantically significant.
  network.nodes[reticulationId]!.parents = [sourceEdge.parent, attachmentId];
  network.reticulations.push({
    bit,
    move,
    sourceContextMask: contextMask,
    sourceContextSignature: context.signature,
    reticulationNode: reticulationId,
    backgroundParentNode: sourceEdge.parent,
    alternateParentNode: attachmentId,
    recipientChildNode: sourceEdge.child,
    donorChildNode: donorChild,
  });
  const afterUniverse = exactDisplayUniverse(network);
  if (afterUniverse === undefined) return undefined;
  for (let oldMask = 0; oldMask < beforeUniverse.length; oldMask += 1) {
    if (afterUniverse[oldMask]!.signature !== beforeUniverse[oldMask]!.signature) return undefined;
  }
  if (afterUniverse[contextMask | (1 << bit)]!.signature !== treeSignature(desired.tree)) return undefined;
  return network;
}

export function networkHash(network: SwitchingNetwork): string {
  // The all-background master is part of network identity.  Omitting it would
  // incorrectly merge identical edit scripts compiled on distinct latent
  // masters during joint master/network search.
  const master = displayNetwork(network, 0)?.signature ?? "INVALID";
  const events = network.reticulations.map((event) => [
    cladeKey(event.move.pruned),
    cladeKey(event.move.destination),
    event.move.destinationIsRoot ? "R" : "E",
    event.sourceContextMask,
  ].join("|")).join(";");
  return `${master}::${events}`;
}

export function networkToSerializable(network: SwitchingNetwork): unknown {
  return {
    root: `N${network.root}`,
    nodes: network.nodes.map((node) => ({ id: `N${node.id}`, kind: node.kind, ...(node.leaf === undefined ? {} : { leaf: node.leaf }), parents: node.parents.map((id) => `N${id}`), children: node.children.map((id) => `N${id}`) })),
    reticulations: network.reticulations.map((event) => ({ ...event, reticulationNode: `N${event.reticulationNode}`, backgroundParentNode: `N${event.backgroundParentNode}`, alternateParentNode: `N${event.alternateParentNode}`, recipientChildNode: `N${event.recipientChildNode}`, donorChildNode: `N${event.donorChildNode}` })),
  };
}
