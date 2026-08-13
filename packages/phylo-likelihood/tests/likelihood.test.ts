import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedGtrModel,
  LinkedTreeLikelihood,
  compileLinkedTree,
  decodeLogHmm,
  empiricalBitTransitionMatrix,
  optimizeLinkedBranchLengths,
} from "../src/index.js";

const model = new FixedGtrModel({
  frequencies: [0.3, 0.2, 0.25, 0.25],
  exchangeabilities: [1, 3, 1, 1, 3, 1],
});

const tree = compileLinkedTree({
  id: "balanced-four",
  root: 6,
  childA: Int32Array.of(-1, -1, -1, -1, 0, 2, 4),
  childB: Int32Array.of(-1, -1, -1, -1, 1, 3, 5),
  leaf: Int32Array.of(0, 1, 2, 3, -1, -1, -1),
  atomicEdgesByNode: [Int32Array.of(0), Int32Array.of(1), Int32Array.of(2), Int32Array.of(3), Int32Array.of(4), Int32Array.of(5), new Int32Array(0)],
});

test("fixed GTR transitions are stochastic, stationary, and have a zero derivative row sum", () => {
  const transition = model.transition(0.37);
  for (let row = 0; row < 4; row += 1) {
    let sum = 0;
    let derivative = 0;
    for (let column = 0; column < 4; column += 1) {
      assert.ok(transition.matrix[row * 4 + column]! >= 0);
      sum += transition.matrix[row * 4 + column]!;
      derivative += transition.derivative[row * 4 + column]!;
    }
    assert.ok(Math.abs(sum - 1) < 1e-12);
    assert.ok(Math.abs(derivative) < 1e-12);
  }
  for (let state = 0; state < 4; state += 1) {
    let stationary = 0;
    for (let source = 0; source < 4; source += 1) stationary += model.frequencies[source]! * transition.matrix[source * 4 + state]!;
    assert.ok(Math.abs(stationary - model.frequencies[state]!) < 1e-11);
  }
});

test("all-message atomic branch gradients match central finite differences", () => {
  const alignment = {
    taxa: 4,
    sites: 8,
    masks: Uint8Array.from([
      1, 1, 4, 4,
      1, 1, 4, 4,
      1, 4, 1, 4,
      1, 4, 1, 4,
      2, 2, 8, 8,
      2, 8, 2, 8,
      1, 5, 4, 15,
      8, 8, 8, 8,
    ]),
  };
  const likelihood = new LinkedTreeLikelihood(alignment, [tree], model, { rates: Float64Array.of(0.4, 1.6), weights: Float64Array.of(0.5, 0.5) });
  const assignment = new Int32Array(alignment.sites);
  const lengths = Float64Array.of(0.08, 0.12, 0.07, 0.11, 0.04, 0.06);
  const analytical = likelihood.evaluate(lengths, assignment, true);
  const step = 1e-6;
  for (let edge = 0; edge < lengths.length; edge += 1) {
    const lower = lengths.slice();
    const upper = lengths.slice();
    lower[edge] = lower[edge]! - step;
    upper[edge] = upper[edge]! + step;
    const finite = (likelihood.evaluate(upper, assignment, false).logLikelihood - likelihood.evaluate(lower, assignment, false).logLikelihood) / (2 * step);
    assert.ok(Math.abs(finite - analytical.gradient[edge]!) < 2e-5, `edge ${edge}: analytic ${analytical.gradient[edge]}, finite ${finite}`);
  }
});

test("linked branch optimizer improves a deliberately poor initialization", () => {
  const sites = 80;
  const masks = new Uint8Array(sites * 4);
  for (let site = 0; site < sites; site += 1) masks.set(site % 5 === 0 ? [1, 4, 1, 4] : [1, 1, 4, 4], site * 4);
  const likelihood = new LinkedTreeLikelihood({ taxa: 4, sites, masks }, [tree], model, { rates: Float64Array.of(1), weights: Float64Array.of(1) });
  const result = optimizeLinkedBranchLengths(likelihood, new Int32Array(sites), new Float64Array(6).fill(0.5), { maximumIterations: 20 });
  assert.ok(result.logLikelihood > result.initialLogLikelihood + 1);
  assert.ok(result.lengths.every((value) => value > 0 && Number.isFinite(value)));
});

test("a contracted displayed branch scatters one derivative to every underlying atomic edge", () => {
  const contracted = compileLinkedTree({
    id: "contracted-path",
    root: 6,
    childA: tree.childA,
    childB: tree.childB,
    leaf: tree.leaf,
    atomicEdgesByNode: [Int32Array.of(0, 1), Int32Array.of(2), Int32Array.of(3), Int32Array.of(4), Int32Array.of(5), Int32Array.of(6), new Int32Array(0)],
  });
  const masks = Uint8Array.from([
    1, 1, 4, 4,
    1, 4, 1, 4,
    2, 2, 8, 8,
  ]);
  const likelihood = new LinkedTreeLikelihood({ taxa: 4, sites: 3, masks }, [contracted], model, { rates: Float64Array.of(1), weights: Float64Array.of(1) });
  const evaluated = likelihood.evaluate(new Float64Array(7).fill(0.08), new Int32Array(3));
  assert.ok(Math.abs(evaluated.gradient[0]! - evaluated.gradient[1]!) < 1e-12);
});

test("forward/backward and Viterbi recover a sharp linked-tree switch", () => {
  const sites = 12;
  const states = 2;
  const emissions = new Float64Array(sites * states);
  for (let site = 0; site < sites; site += 1) {
    emissions[site * states] = site < 6 ? 0 : -8;
    emissions[site * states + 1] = site < 6 ? -8 : 0;
  }
  const transition = Float64Array.from([.99, .01, .01, .99], Math.log);
  const decoded = decodeLogHmm(emissions, sites, states, Float64Array.from([.5, .5], Math.log), transition);
  assert.deepEqual([...decoded.path], [...new Int32Array(6).fill(0), ...new Int32Array(6).fill(1)]);
  assert.ok(decoded.switchPosterior[5]! > 0.99);

  const bitTransitions = empiricalBitTransitionMatrix([0, 1], Int32Array.from(decoded.path, (state) => state), 1);
  for (let source = 0; source < 2; source += 1) {
    const total = Math.exp(bitTransitions.transition[source * 2]!) + Math.exp(bitTransitions.transition[source * 2 + 1]!);
    assert.ok(Math.abs(total - 1) < 1e-12);
  }
});
