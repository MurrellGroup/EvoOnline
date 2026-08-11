import type { ProgressDetail } from "@phylo-workbench/model-diffubar";
import { fubarRateAtGridCoordinate } from "../model/grid.js";
import type {
  ApproximateFelDirection,
  ApproximateFelProducts,
  ApproximateFelSiteResult,
  FubarGrid,
} from "../types.js";
import { ExactBicubicLogLikelihoodSpline } from "./exact-bicubic.js";

interface Maximum2D {
  readonly alpha: number;
  readonly beta: number;
  readonly value: number;
}

interface Maximum1D {
  readonly coordinate: number;
  readonly value: number;
}

export interface ApproximateFelOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cellCoordinate(coordinate: number, size: number): readonly [number, number] {
  const bounded = clamp(coordinate, 0, size - 1);
  if (bounded === size - 1) return [size - 2, 1];
  const cell = Math.floor(bounded);
  return [cell, bounded - cell];
}

function quadraticRoots(a: number, b: number, c: number): readonly number[] {
  const scale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c));
  const epsilon = 1e-12 * scale;
  if (Math.abs(a) <= epsilon) {
    if (Math.abs(b) <= epsilon) return [];
    return [-c / b];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -epsilon * scale) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const q = -0.5 * (b + (b >= 0 ? root : -root));
  if (q === 0) return [-b / (2 * a)];
  const first = q / a;
  const second = c / q;
  return Math.abs(first - second) <= 1e-11 ? [first] : [first, second];
}

/** Recover every stationary point of a cubic from its derivative at 0, 1/2, and 1. */
function cubicStationaryPoints(d0: number, dHalf: number, d1: number): readonly number[] {
  const middleDelta = dHalf - d0;
  const endDelta = d1 - d0;
  const quadratic = 2 * endDelta - 4 * middleDelta;
  const linear = 4 * middleDelta - endDelta;
  return quadraticRoots(quadratic, linear, d0).filter((root) => root > 1e-10 && root < 1 - 1e-10);
}

function maximizeAlphaAtBeta(surface: ExactBicubicLogLikelihoodSpline, beta: number): Maximum2D {
  const [cellBeta, v] = cellCoordinate(beta, surface.size);
  let best: Maximum2D = { alpha: 0, beta, value: -Infinity };
  for (let cellAlpha = 0; cellAlpha < surface.size - 1; cellAlpha += 1) {
    const start = surface.evaluateCellWithGradient(cellAlpha, cellBeta, 0, v);
    const middle = surface.evaluateCellWithGradient(cellAlpha, cellBeta, 0.5, v);
    const end = surface.evaluateCellWithGradient(cellAlpha, cellBeta, 1, v);
    const candidates = [0, 1, ...cubicStationaryPoints(start.dx, middle.dx, end.dx)];
    for (const u of candidates) {
      const value = u === 0 ? start.value : u === 1 ? end.value : surface.evaluateCellWithGradient(cellAlpha, cellBeta, u, v).value;
      if (value > best.value) best = { alpha: cellAlpha + u, beta, value };
    }
  }
  return best;
}

function maximizeBetaAtAlpha(surface: ExactBicubicLogLikelihoodSpline, alpha: number): Maximum2D {
  const [cellAlpha, u] = cellCoordinate(alpha, surface.size);
  let best: Maximum2D = { alpha, beta: 0, value: -Infinity };
  for (let cellBeta = 0; cellBeta < surface.size - 1; cellBeta += 1) {
    const start = surface.evaluateCellWithGradient(cellAlpha, cellBeta, u, 0);
    const middle = surface.evaluateCellWithGradient(cellAlpha, cellBeta, u, 0.5);
    const end = surface.evaluateCellWithGradient(cellAlpha, cellBeta, u, 1);
    const candidates = [0, 1, ...cubicStationaryPoints(start.dy, middle.dy, end.dy)];
    for (const v of candidates) {
      const value = v === 0 ? start.value : v === 1 ? end.value : surface.evaluateCellWithGradient(cellAlpha, cellBeta, u, v).value;
      if (value > best.value) best = { alpha, beta: cellBeta + v, value };
    }
  }
  return best;
}

function retainCandidate(candidates: Maximum2D[], candidate: Maximum2D, limit: number): void {
  if (candidates.length >= limit) {
    let worst = 0;
    for (let position = 1; position < candidates.length; position += 1) {
      if (candidates[position]!.value < candidates[worst]!.value) worst = position;
    }
    if (candidate.value <= candidates[worst]!.value) return;
  }
  const existing = candidates.findIndex((item) => Math.hypot(item.alpha - candidate.alpha, item.beta - candidate.beta) < 0.35);
  if (existing >= 0) {
    if (candidate.value > candidates[existing]!.value) candidates[existing] = candidate;
  } else {
    candidates.push(candidate);
  }
  if (candidates.length > limit) {
    let worst = 0;
    for (let position = 1; position < candidates.length; position += 1) {
      if (candidates[position]!.value < candidates[worst]!.value) worst = position;
    }
    candidates.splice(worst, 1);
  }
}

/** Multi-start coordinate ascent whose one-dimensional steps are exact cubic searches. */
function maximizeSurface(surface: ExactBicubicLogLikelihoodSpline): Maximum2D {
  const candidates: Maximum2D[] = [];
  const halfSteps = 2 * (surface.size - 1);
  for (let alphaStep = 0; alphaStep <= halfSteps; alphaStep += 1) {
    const alpha = alphaStep / 2;
    for (let betaStep = 0; betaStep <= halfSteps; betaStep += 1) {
      const beta = betaStep / 2;
      retainCandidate(candidates, { alpha, beta, value: surface.evaluate(alpha, beta) }, 14);
    }
  }
  candidates.sort((left, right) => right.value - left.value);
  let best = candidates[0] ?? { alpha: 0, beta: 0, value: surface.evaluate(0, 0) };
  for (const seed of candidates) {
    let current = seed;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const alphaMaximum = maximizeAlphaAtBeta(surface, current.beta);
      const betaMaximum = maximizeBetaAtAlpha(surface, alphaMaximum.alpha);
      const polished = maximizeAlphaAtBeta(surface, betaMaximum.beta);
      const next = polished.value >= betaMaximum.value ? polished : betaMaximum;
      const coordinateChange = Math.hypot(next.alpha - current.alpha, next.beta - current.beta);
      const valueChange = Math.abs(next.value - current.value);
      current = next;
      if (coordinateChange <= 1e-9 && valueChange <= 1e-11) break;
    }
    if (current.value > best.value) best = current;
  }
  return best;
}

function maximizeDiagonal(surface: ExactBicubicLogLikelihoodSpline): Maximum1D {
  let best: Maximum1D = { coordinate: 0, value: surface.evaluate(0, 0) };
  const divisions = 24;
  for (let cell = 0; cell < surface.size - 1; cell += 1) {
    let previousT = 0;
    let previous = surface.evaluateCellWithGradient(cell, cell, 0, 0);
    if (previous.value > best.value) best = { coordinate: cell, value: previous.value };
    for (let step = 1; step <= divisions; step += 1) {
      const t = step / divisions;
      const current = surface.evaluateCellWithGradient(cell, cell, t, t);
      if (current.value > best.value) best = { coordinate: cell + t, value: current.value };
      const previousDerivative = previous.dx + previous.dy;
      const currentDerivative = current.dx + current.dy;
      if (previousDerivative > 0 && currentDerivative <= 0) {
        let lower = previousT;
        let upper = t;
        for (let iteration = 0; iteration < 48; iteration += 1) {
          const middle = (lower + upper) / 2;
          const gradient = surface.evaluateCellWithGradient(cell, cell, middle, middle);
          if (gradient.dx + gradient.dy > 0) lower = middle;
          else upper = middle;
        }
        const optimum = (lower + upper) / 2;
        const value = surface.evaluateCellWithGradient(cell, cell, optimum, optimum).value;
        if (value > best.value) best = { coordinate: cell + optimum, value };
      }
      previousT = t;
      previous = current;
    }
  }
  return best;
}

/** Complementary error function, accurate to roughly 1e-7 over the real line. */
function erfc(value: number): number {
  const magnitude = Math.abs(value);
  const t = 1 / (1 + 0.5 * magnitude);
  const approximation = t * Math.exp(
    -magnitude * magnitude - 1.26551223
    + t * (1.00002368
      + t * (0.37409196
        + t * (0.09678418
          + t * (-0.18628806
            + t * (0.27886807
              + t * (-1.13520398
                + t * (1.48851587
                  + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return value >= 0 ? approximation : 2 - approximation;
}

function inferDirection(alpha: number, beta: number, likelihoodRatio: number): ApproximateFelDirection {
  if (likelihoodRatio <= 1e-12 || Math.abs(alpha - beta) <= 1e-10) return "none";
  return beta > alpha ? "positive" : "purifying";
}

function oneSidedPValues(twoSided: number, direction: ApproximateFelDirection): readonly [number, number] {
  if (direction === "none") return [0.5, 0.5];
  const observedTail = twoSided / 2;
  return direction === "positive"
    ? [observedTail, 1 - observedTail]
    : [1 - observedTail, observedTail];
}

/**
 * Statistical target: CodonMolecularEvolution.jl's FIFEFUBAR construction
 * (raw per-site likelihood surface, unrestricted maximum versus alpha=beta).
 * The interpolant and optimizer here are deliberately more defensive.
 * https://github.com/MurrellGroup/CodonMolecularEvolution.jl/blob/main/src/FUBAR/FUBAR.jl
 */
export function analyzeApproximateFel(
  categoryMajorLogLikelihoods: Float64Array,
  grid: FubarGrid,
  siteCount: number,
  options: ApproximateFelOptions = {},
): ApproximateFelProducts {
  if (categoryMajorLogLikelihoods.length !== grid.categoryCount * siteCount) {
    throw new RangeError("Approximate FEL likelihood dimensions do not match the FUBAR grid.");
  }
  const gridSize = grid.values.length;
  if (grid.categoryCount !== gridSize * gridSize) throw new RangeError("Approximate FEL requires a square alpha-beta grid.");
  const relativeLogLikelihoods = new Float32Array(siteCount * grid.categoryCount);
  const sites: ApproximateFelSiteResult[] = [];
  const surfaceValues = new Float64Array(grid.categoryCount);
  let maximumNodeError = 0;
  let minimumSplineTension = 1;
  let guardedSites = 0;

  for (let site = 0; site < siteCount; site += 1) {
    options.signal?.throwIfAborted();
    let gridMaximum = -Infinity;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      const value = categoryMajorLogLikelihoods[category * siteCount + site]!;
      if (!Number.isFinite(value)) throw new RangeError(`Approximate FEL encountered a non-finite log likelihood at codon ${site + 1}.`);
      gridMaximum = Math.max(gridMaximum, value);
    }
    const surfaceOffset = site * grid.categoryCount;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      const relative = categoryMajorLogLikelihoods[category * siteCount + site]! - gridMaximum;
      surfaceValues[category] = relative;
      relativeLogLikelihoods[surfaceOffset + category] = relative;
    }

    const spline = new ExactBicubicLogLikelihoodSpline(surfaceValues, gridSize);
    const nullMaximum = maximizeDiagonal(spline);
    let alternativeMaximum = maximizeSurface(spline);
    // The alternative contains the null. This also protects against a vanishing
    // numerical miss in a multi-start optimizer without inventing evidence.
    if (alternativeMaximum.value < nullMaximum.value) {
      alternativeMaximum = {
        alpha: nullMaximum.coordinate,
        beta: nullMaximum.coordinate,
        value: nullMaximum.value,
      };
    }
    const likelihoodRatio = Math.max(0, 2 * (alternativeMaximum.value - nullMaximum.value));
    const pValue = clamp(erfc(Math.sqrt(likelihoodRatio / 2)), 0, 1);
    const direction = inferDirection(alternativeMaximum.alpha, alternativeMaximum.beta, likelihoodRatio);
    const [pPositive, pPurifying] = oneSidedPValues(pValue, direction);
    const alphaAlternative = fubarRateAtGridCoordinate(alternativeMaximum.alpha);
    const betaAlternative = fubarRateAtGridCoordinate(alternativeMaximum.beta);
    const alphaBetaNull = fubarRateAtGridCoordinate(nullMaximum.coordinate);
    sites.push({
      site: site + 1,
      pValue,
      pPositive,
      pPurifying,
      likelihoodRatio,
      gridLogLikelihoodMaximum: gridMaximum,
      logLikelihoodAlternative: gridMaximum + alternativeMaximum.value,
      logLikelihoodNull: gridMaximum + nullMaximum.value,
      alphaAlternative,
      betaAlternative,
      alphaBetaNull,
      alphaCoordinate: alternativeMaximum.alpha,
      betaCoordinate: alternativeMaximum.beta,
      nullCoordinate: nullMaximum.coordinate,
      direction,
      splineTension: spline.audit.tension,
    });
    maximumNodeError = Math.max(maximumNodeError, spline.audit.maximumNodeError);
    minimumSplineTension = Math.min(minimumSplineTension, spline.audit.tension);
    if (spline.audit.tension < 1 - 1e-10) guardedSites += 1;
    options.onProgress?.((site + 1) / siteCount, {
      message: `Optimized conditional likelihood surface ${site + 1} of ${siteCount}`,
      current: site + 1,
      total: siteCount,
      metricLabel: "site LRT",
      metricValue: likelihoodRatio,
    });
  }

  return {
    siteCount,
    gridSize,
    gridValues: grid.values.slice(),
    relativeLogLikelihoods,
    sites,
    diagnostics: {
      interpolation: "exact-tensioned-bicubic-log-likelihood",
      coordinateSystem: "uniform-fubar-grid-index",
      maximumNodeError,
      minimumSplineTension,
      guardedSites,
    },
  };
}

export function approximateFelResultsToCsv(result: ApproximateFelProducts, threshold = 0.05): string {
  const header = [
    "Codon Sites",
    "FEL p-value (two-sided)",
    "FEL p-value (positive)",
    "FEL p-value (purifying)",
    "LRT",
    "LL alternative",
    "alpha alternative",
    "beta alternative",
    "LL null",
    "alpha=beta null",
    "direction",
    "positive_selected",
    "purifying_selected",
    "spline_tension",
  ];
  const rows = result.sites.map((site) => [
    site.site,
    site.pValue,
    site.pPositive,
    site.pPurifying,
    site.likelihoodRatio,
    site.logLikelihoodAlternative,
    site.alphaAlternative,
    site.betaAlternative,
    site.logLikelihoodNull,
    site.alphaBetaNull,
    site.direction,
    site.pPositive < threshold,
    site.pPurifying < threshold,
    site.splineTension,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}
