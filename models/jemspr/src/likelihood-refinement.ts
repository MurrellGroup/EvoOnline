import {
  FixedGtrModel,
  LinkedTreeLikelihood,
  compileLinkedTree,
  decodeLogHmm,
  discreteGammaRates,
  empiricalBitTransitionMatrix,
  optimizeLinkedBranchLengths,
  type CompiledLinkedTree,
} from "@phylo-workbench/phylo-likelihood";
import { displayNetwork, type NetworkDisplay, type SwitchingNetwork } from "./switching-network.js";
import { leafSet, treeSignature, type RootedNode } from "./tree.js";
import type {
  JemsprAlignment,
  JemsprLikelihoodRound,
  JemsprLikelihoodRun,
  JemsprLinkedLikelihoodResult,
  JemsprOptions,
} from "./types.js";

interface AtomicEdge {
  readonly id: number;
  readonly parent: number;
  readonly child: number;
}

interface CompiledDisplay {
  readonly mask: number;
  readonly display: NetworkDisplay;
  readonly tree: CompiledLinkedTree;
}

const edgeKey = (parent: number, child: number): string => `${parent}>${child}`;
const cladeKey = (node: RootedNode): string => leafSet(node).join(",");
const quoteName = (name: string): string => /[\s,:;()\[\]'\"]/.test(name) ? `'${name.replaceAll("'", "''")}'` : name;

function compileDisplays(network: SwitchingNetwork, masks: readonly number[]): {
  readonly atomicEdges: readonly AtomicEdge[];
  readonly fixedZeroEdges: readonly { readonly parent: number; readonly child: number }[];
  readonly displays: readonly CompiledDisplay[];
  readonly memberships: readonly Set<string>[];
  readonly usedByMasks: readonly Set<number>[];
} {
  const zeroKeys = new Set(network.reticulations.map((event) => edgeKey(event.alternateParentNode, event.reticulationNode)));
  const fixedZeroEdges = network.reticulations.map((event) => ({ parent: event.alternateParentNode, child: event.reticulationNode }));
  const atomicEdges: AtomicEdge[] = [];
  const atomicByKey = new Map<string, number>();
  for (const node of network.nodes) {
    for (const child of node.children) {
      const key = edgeKey(node.id, child);
      if (zeroKeys.has(key)) continue;
      const id = atomicEdges.length;
      atomicEdges.push({ id, parent: node.id, child });
      atomicByKey.set(key, id);
    }
  }
  const memberships = atomicEdges.map(() => new Set<string>());
  const usedByMasks = atomicEdges.map(() => new Set<number>());
  const displays = masks.map((mask): CompiledDisplay => {
    const display = displayNetwork(network, mask);
    if (display === undefined) throw new Error(`Switching-network mask ${mask} could not be displayed during linked-likelihood compilation.`);
    const childA: number[] = [];
    const childB: number[] = [];
    const leaf: number[] = [];
    const atomicEdgesByNode: Int32Array[] = [];
    const originIds = (node: RootedNode): number[] => {
      const origins = display.edgeOrigins.get(cladeKey(node));
      if (origins === undefined) throw new Error(`A displayed branch in mask ${mask} has no switching-network origin path.`);
      return origins.map((origin) => atomicByKey.get(edgeKey(origin.parent, origin.child))).filter((value): value is number => value !== undefined);
    };
    const build = (node: RootedNode, root: boolean, rootGaugeOverride?: readonly number[]): number => {
      const id = childA.length;
      childA.push(-1);
      childB.push(-1);
      leaf.push("leaf" in node ? node.leaf : -1);
      let atomic = new Int32Array(0);
      if (!root) {
        const ids = rootGaugeOverride === undefined ? originIds(node) : [...rootGaugeOverride];
        if (ids.length === 0 && rootGaugeOverride === undefined) throw new Error(`A displayed branch in mask ${mask} contains only a zero-time recombination edge.`);
        atomic = Int32Array.from(ids);
        const branch = rootGaugeOverride === undefined ? cladeKey(node) : "REVERSIBLE-ROOT-GAUGE";
        for (const edge of ids) {
          memberships[edge]!.add(`${mask}:${branch}`);
          usedByMasks[edge]!.add(mask);
        }
      }
      atomicEdgesByNode.push(atomic);
      if (!("leaf" in node)) {
        if (root) {
          // Under a reversible model the two branches incident to a binary
          // root are identifiable only through their sum. Use an explicit
          // zero/sum gauge so the optimizer never pretends otherwise.
          const leftIds = originIds(node.children[0]);
          const rightIds = originIds(node.children[1]);
          const leftIsZero = cladeKey(node.children[0]).localeCompare(cladeKey(node.children[1])) <= 0;
          childA[id] = build(node.children[0], false, leftIsZero ? [] : [...leftIds, ...rightIds]);
          childB[id] = build(node.children[1], false, leftIsZero ? [...leftIds, ...rightIds] : []);
        } else {
          childA[id] = build(node.children[0], false);
          childB[id] = build(node.children[1], false);
        }
      }
      return id;
    };
    const root = build(display.tree, true);
    return {
      mask,
      display,
      tree: compileLinkedTree({
        id: `mask-${mask}`,
        root,
        childA: Int32Array.from(childA),
        childB: Int32Array.from(childB),
        leaf: Int32Array.from(leaf),
        atomicEdgesByNode,
      }),
    };
  });
  return { atomicEdges, fixedZeroEdges, displays, memberships, usedByMasks };
}

function initialLength(alignment: JemsprAlignment, displays: readonly CompiledDisplay[]): number {
  let mismatches = 0;
  let compared = 0;
  for (let left = 0; left < alignment.taxa; left += 1) {
    for (let right = left + 1; right < alignment.taxa; right += 1) {
      for (let site = 0; site < alignment.sites; site += 1) {
        const a = alignment.masks[site * alignment.taxa + left]!;
        const b = alignment.masks[site * alignment.taxa + right]!;
        if (a === 0 || b === 0 || (a & (a - 1)) !== 0 || (b & (b - 1)) !== 0) continue;
        compared += 1;
        if (a !== b) mismatches += 1;
      }
    }
  }
  const p = compared > 0 ? Math.min(0.7, mismatches / compared) : 0.02;
  const distance = p > 0 ? -0.75 * Math.log(Math.max(1e-4, 1 - 4 * p / 3)) : 0.005;
  let pathTotal = 0;
  let branches = 0;
  for (const display of displays) {
    for (let node = 0; node < display.tree.atomicEdgesByNode.length; node += 1) {
      if (node === display.tree.root) continue;
      pathTotal += display.tree.atomicEdgesByNode[node]!.length;
      branches += 1;
    }
  }
  const meanPath = pathTotal / Math.max(1, branches);
  return Math.max(0.002, Math.min(0.2, distance / Math.max(2, 2 * Math.log2(alignment.taxa)) / Math.max(1, meanPath)));
}

function newickWithLengths(compiled: CompiledDisplay, names: readonly string[], lengths: Float64Array): string {
  const render = (node: RootedNode, nodeId: number, root: boolean): string => {
    const body = "leaf" in node
      ? quoteName(names[node.leaf] ?? `taxon_${node.leaf + 1}`)
      : `(${render(node.children[0], compiled.tree.childA[nodeId]!, false)},${render(node.children[1], compiled.tree.childB[nodeId]!, false)})`;
    if (root) return body;
    let length = 0;
    for (const atomic of compiled.tree.atomicEdgesByNode[nodeId]!) length += lengths[atomic]!;
    return `${body}:${Math.max(0, length).toPrecision(10)}`;
  };
  return `${render(compiled.display.tree, compiled.tree.root, true)};`;
}

function runsFromPath(path: Int32Array, masks: readonly number[], treeNewicks: readonly string[]): readonly JemsprLikelihoodRun[] {
  if (path.length === 0) return [];
  const runs: JemsprLikelihoodRun[] = [];
  let start = 0;
  for (let site = 1; site <= path.length; site += 1) {
    if (site < path.length && path[site] === path[start]) continue;
    const state = path[start]!;
    runs.push({ start: start + 1, end: site, mask: masks[state]!, tree: treeNewicks[state]! });
    start = site;
  }
  return runs;
}

function nonidentifiableGroups(memberships: readonly Set<string>[], atomicEdges: readonly AtomicEdge[]): readonly (readonly string[])[] {
  const bySignature = new Map<string, string[]>();
  for (let edge = 0; edge < memberships.length; edge += 1) {
    const signature = [...memberships[edge]!].sort().join("|");
    const group = bySignature.get(signature) ?? [];
    group.push(`E${atomicEdges[edge]!.id + 1}`);
    bySignature.set(signature, group);
  }
  return [...bySignature.values()].filter((group) => group.length > 1);
}

export function fitLinkedNetworkLikelihood(
  alignment: JemsprAlignment,
  network: SwitchingNetwork,
  masks: readonly number[],
  maskPath: Int32Array,
  options: JemsprOptions,
): JemsprLinkedLikelihoodResult {
  const supplied = options.gtrModel;
  if (supplied === undefined) throw new Error("A fixed global GTR matrix is required for linked-network likelihood refinement.");
  options.signal?.throwIfAborted();
  options.onProgress?.("jemspr-linked-likelihood", 0.03, { message: "Compiling displayed branches into shared atomic network-edge parameters." });
  const compiled = compileDisplays(network, masks);
  const model = new FixedGtrModel({ frequencies: supplied.frequencies, exchangeabilities: supplied.exchangeabilities });
  const assignment = Int32Array.from(maskPath, (mask) => {
    const index = masks.indexOf(mask);
    if (index < 0) throw new Error(`Selected switching mask ${mask} is absent from the linked display universe.`);
    return index;
  });
  const categoryCount = Math.max(1, Math.min(8, Math.round(options.likelihoodRateCategories ?? 4)));
  let gammaShape = Math.max(0.05, Math.min(20, options.likelihoodGammaShape ?? 0.5));
  let mixture = discreteGammaRates(gammaShape, categoryCount);
  let likelihood = new LinkedTreeLikelihood(alignment, compiled.displays.map((entry) => entry.tree), model, mixture);
  const lengths = new Float64Array(compiled.atomicEdges.length).fill(initialLength(alignment, compiled.displays));
  const rounds: JemsprLikelihoodRound[] = [];
  const maximumIterations = Math.max(2, Math.min(80, Math.round(options.likelihoodIterations ?? 28)));
  const first = optimizeLinkedBranchLengths(likelihood, assignment, lengths, {
    maximumIterations,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (progress) => options.onProgress?.("jemspr-branch-fit", Math.min(0.98, progress.iteration / progress.maximumIterations), {
      message: `Linked branch ML ${progress.iteration}/${progress.maximumIterations} · ${compiled.atomicEdges.length} shared atomic edges`,
      current: progress.iteration,
      total: progress.maximumIterations,
      metricLabel: "log L",
      metricValue: progress.logLikelihood,
    }),
  });
  let fittedLengths = first.lengths;
  rounds.push({ round: 1, phase: "initial-linked-fit", logLikelihood: first.logLikelihood, iterations: first.iterations, converged: first.converged, gradientRms: first.gradientRms, changedSites: 0 });

  if (categoryCount > 1 && (options.fitLikelihoodGammaShape ?? true)) {
    const candidates = [0.1, 0.18, 0.3, 0.5, 0.8, 1.3, 2.2, 4, 8];
    let bestShape = gammaShape;
    let bestLikelihood = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < candidates.length; index += 1) {
      options.signal?.throwIfAborted();
      const candidate = candidates[index]!;
      const candidateMixture = discreteGammaRates(candidate, categoryCount);
      const candidateLikelihood = new LinkedTreeLikelihood(alignment, compiled.displays.map((entry) => entry.tree), model, candidateMixture).evaluate(fittedLengths, assignment, false).logLikelihood;
      if (candidateLikelihood > bestLikelihood) { bestLikelihood = candidateLikelihood; bestShape = candidate; }
      options.onProgress?.("jemspr-rate-fit", (index + 1) / candidates.length, { message: `Profiling custom discrete-Gamma shape ${index + 1}/${candidates.length}`, current: index + 1, total: candidates.length, metricLabel: "log L", metricValue: candidateLikelihood });
    }
    gammaShape = bestShape;
    mixture = discreteGammaRates(gammaShape, categoryCount);
    likelihood = new LinkedTreeLikelihood(alignment, compiled.displays.map((entry) => entry.tree), model, mixture);
    const profiled = optimizeLinkedBranchLengths(likelihood, assignment, fittedLengths, {
      maximumIterations: Math.max(4, Math.round((options.likelihoodRefitIterations ?? 14) / 2)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (progress) => options.onProgress?.("jemspr-branch-fit", Math.min(0.98, progress.iteration / progress.maximumIterations), { message: `Polishing linked lengths at Gamma shape ${gammaShape}`, current: progress.iteration, total: progress.maximumIterations, metricLabel: "log L", metricValue: progress.logLikelihood }),
    });
    fittedLengths = profiled.lengths;
    rounds.push({ round: rounds.length + 1, phase: "gamma-profile", logLikelihood: profiled.logLikelihood, iterations: profiled.iterations, converged: profiled.converged, gradientRms: profiled.gradientRms, changedSites: 0 });
  }

  options.onProgress?.("jemspr-likelihood-path", 0.15, { message: `Computing custom GTR site likelihoods for ${masks.length} switching masks.`, current: 0, total: masks.length, indeterminate: true });
  let emissions = likelihood.siteLogLikelihoods(fittedLengths);
  const transition = empiricalBitTransitionMatrix(masks, maskPath, network.reticulations.length);
  let decoded = decodeLogHmm(emissions, alignment.sites, masks.length, transition.initial, transition.transition);
  let refinedAssignment = (options.likelihoodRefinement ?? true) ? decoded.path : assignment;
  let changedSites = 0;
  for (let site = 0; site < assignment.length; site += 1) if (refinedAssignment[site] !== assignment[site]) changedSites += 1;
  if ((options.likelihoodRefinement ?? true) && changedSites > 0) {
    const refit = optimizeLinkedBranchLengths(likelihood, refinedAssignment, fittedLengths, {
      maximumIterations: Math.max(2, Math.min(40, Math.round(options.likelihoodRefitIterations ?? 14))),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (progress) => options.onProgress?.("jemspr-branch-refit", Math.min(0.98, progress.iteration / progress.maximumIterations), { message: `Likelihood-path branch refit ${progress.iteration}/${progress.maximumIterations}`, current: progress.iteration, total: progress.maximumIterations, metricLabel: "log L", metricValue: progress.logLikelihood }),
    });
    fittedLengths = refit.lengths;
    emissions = likelihood.siteLogLikelihoods(fittedLengths);
    decoded = decodeLogHmm(emissions, alignment.sites, masks.length, transition.initial, transition.transition);
    refinedAssignment = decoded.path;
    changedSites = 0;
    for (let site = 0; site < assignment.length; site += 1) if (refinedAssignment[site] !== assignment[site]) changedSites += 1;
    rounds.push({ round: rounds.length + 1, phase: "path-refit", logLikelihood: refit.logLikelihood, iterations: refit.iterations, converged: refit.converged, gradientRms: refit.gradientRms, changedSites });
  }
  const finalEvaluation = likelihood.evaluate(fittedLengths, refinedAssignment, false);
  const parsimonyPathLogLikelihood = likelihood.evaluate(fittedLengths, assignment, false).logLikelihood;
  const treeNewicks = compiled.displays.map((entry) => newickWithLengths(entry, alignment.names, fittedLengths));
  const occupied = new Uint32Array(masks.length);
  const treeLogLikelihoods = new Float64Array(masks.length);
  for (let site = 0; site < refinedAssignment.length; site += 1) {
    const state = refinedAssignment[site]!;
    occupied[state] = occupied[state]! + 1;
    treeLogLikelihoods[state] = treeLogLikelihoods[state]! + emissions[site * masks.length + state]!;
  }
  const masterIndex = masks.indexOf(0);
  const groups = nonidentifiableGroups(compiled.memberships, compiled.atomicEdges);
  options.onProgress?.("jemspr-linked-likelihood", 1, { message: `Linked ML complete · ${compiled.atomicEdges.length} shared edge parameters · ${changedSites} site assignments refined`, metricLabel: "log L", metricValue: finalEvaluation.logLikelihood });
  return {
    status: "complete",
    model: supplied,
    rateVariation: { kind: categoryCount === 1 ? "constant" : "custom-discrete-gamma", shape: gammaShape, rates: [...mixture.rates], weights: [...mixture.weights] },
    logLikelihood: finalEvaluation.logLikelihood,
    initialLogLikelihood: first.initialLogLikelihood,
    parsimonyPathLogLikelihood,
    logMarginalLikelihood: decoded.logMarginalLikelihood,
    viterbiLogJoint: decoded.viterbiLogJoint,
    openProbability: transition.openProbability,
    closeProbability: transition.closeProbability,
    refined: (options.likelihoodRefinement ?? true) && changedSites > 0,
    atomicBranches: compiled.atomicEdges.map((edge) => ({ id: `E${edge.id + 1}`, parentNode: `N${edge.parent}`, childNode: `N${edge.child}`, length: fittedLengths[edge.id]!, usedByMasks: [...compiled.usedByMasks[edge.id]!].sort((a, b) => a - b) })),
    fixedZeroEdges: compiled.fixedZeroEdges.map((edge) => ({ parentNode: `N${edge.parent}`, childNode: `N${edge.child}`, reason: "recombination-parent-choice" as const })),
    trees: compiled.displays.map((entry, index) => ({ mask: entry.mask, signature: treeSignature(entry.display.tree), tree: treeNewicks[index]!, occupiedSites: occupied[index]!, dataLogLikelihood: treeLogLikelihoods[index]! })),
    runs: runsFromPath(refinedAssignment, masks, treeNewicks),
    switchPosterior: [...decoded.switchPosterior],
    rounds,
    masterTree: treeNewicks[masterIndex >= 0 ? masterIndex : 0]!,
    nonidentifiableGroups: groups,
    certificate: "FastTree contributes only one whole-alignment fixed GTR frequency/exchangeability matrix. EvoOnline performs every transition-matrix evaluation, discrete-Gamma profile, Felsenstein pruning pass, all-edge analytic gradient, linked L-BFGS branch fit, site-emission calculation, forward/backward pass, and Viterbi refinement itself. Each non-horizontal switching-DAG edge has one length shared across every displayed tree; a displayed branch length is the sum of its underlying edge path, while alternate-parent recombination edges are fixed at zero. The reversible degree-two root gauge is represented exactly as one zero branch plus the summed opposite branch, and remaining exact duplicate design columns are reported rather than presented as separately identified lengths.",
  };
}
