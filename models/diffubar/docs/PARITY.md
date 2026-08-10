# Parity, validation, and known differences

“Parity” has three different meanings here and should not be collapsed into one claim.

The implementation audit used bioRxiv preprint version 1 (`2025.05.19.654647`), `CodonMolecularEvolution.jl` commit `c76e33d39d8b32050aa9a5eab285717a4c183853`, and dependency `MolecularEvolution.jl` commit `243e6dc59c54630be29bf9034b3ff8da62d24e18`.

## Deterministic structural parity

The implementation reproduces these reference choices:

- transformed grid `10^x - 0.05`, with default 12 alpha, 12 omega-1, 12 omega-2, and (when present) 7 background-omega points;
- 1,728 categories without background and 12,096 with background;
- category order: alpha, omega-1, omega-2, then background omega;
- lexically sorted universal-code sense codons;
- MG94-F3x4 rate construction and F3x4 equilibrium normalization;
- two sorted foreground tags plus an optional untagged background class;
- per-combine sum scaling and log-scale accumulation;
- four posterior probability columns, three posterior means, and one-based codon-site numbering;
- symmetric Dirichlet concentration 0.1, 2,500 iterations, and one-fifth burn-in defaults.

Unit tests assert default grid values/order, parser behavior, analytical zero-edge likelihoods, cache/flat equality, deterministic reference-sampler behavior, sparse/dense equality when the cutoff removes nothing, and an analytical posterior probability for the exact rejection sampler.

## Numerical likelihood parity

The f64 WASM backend uses uniformization rather than the reference package's normal diagonalized-CTMC path. This is algorithmic parity with controlled floating-point/truncation error, not bit identity.

Validation completed in this environment:

| Check | Result |
|---|---|
| Independent SciPy dense `expm` fixture | max absolute log-likelihood error `2.56e-13` |
| WASM cached program versus flat program | within `2e-12` test tolerance |
| Full 12,096-category matrix versus Julia | RMS absolute error `9.46e-14`; maximum `3.10e-12` |
| Dawn WGSL compilation | passed with no shader errors |
| TypeScript typecheck | passed |
| Node test suite | 11/11 passed |

`scripts/generate-julia-reference.jl` and `scripts/compare-julia-reference.ts` provide direct category/log-likelihood comparison with the upstream package. The full-data comparison above used Julia 1.11.5, the upstream `Ace2_reallytiny` alignment/tree, and a Julia-fitted model exported once and reused by both implementations.

## WebGPU parity

The custom shader compiles under Dawn's production validator. `npm run parity:webgpu` requests a real Dawn adapter, evaluates the same fixture on f64 WASM and f32 WebGPU, and requires maximum absolute log-likelihood error at or below `5e-3`.

No physical or software Vulkan adapter was available in this container, so execution was skipped after adapter discovery. The threshold is provisional until several real adapters have been tested. Do not infer GPU numerical parity from shader compilation alone.

## Gibbs parity

With `likelihoodCutoff: 0`, both `reference` and `fast-exact` are exact uncollapsed Gibbs kernels for the same Julia posterior. `reference` performs the Julia-style dense categorical scan. `fast-exact` uses a proposal from theta followed by likelihood rejection; this is a different realization of the same conditional draw, not an approximation. The RNG is xoshiro128**, Gamma(0.1) uses Ahrens–Dieter GS, and other gamma shapes use Marsaglia–Tsang, so none matches Julia's runtime RNG stream. Therefore:

- the same seed will not produce the same chain across languages;
- posterior estimates should agree statistically as retained iterations increase;
- exact seed-for-seed allocation parity is not claimed.

On the 74-site full grid, one 2,500-iteration `fast-exact` chain and one dense `reference` chain had mean absolute difference `0.0115` and maximum difference `0.0400` across the four site posterior probabilities. Those are single-chain Monte Carlo differences, not a deterministic error bound.

The API default is strict (`0`). The CLI and UI use `1e-12` for speed. A positive cutoff drops categories whose site-normalized likelihood ratio is below the cutoff. This is usually negligible but is not mathematically identical to the dense sampler; use `--strict-sampler` for reference-semantic sampling.

## Global-fit parity

This is the largest remaining source of end-to-end differences.

| Mode | Behavior |
|---|---|
| `empirical-fast` | Empirical GTR initialization plus a coarse/refined alpha-beta search; optimized for interactive use |
| `reference-compatible` | Two-step nucleotide then codon fit with bounded Nelder–Mead and one-dimensional golden searches |
| `fittedModel` / `--fitted-model` | Bypasses fitting and gives the strongest downstream parity path |

The reference Julia path uses BOBYQA for nucleotide parameters and Brent/parabolic polishing for alpha/beta. The “reference-compatible” mode matches the parameterization and optimization sequence, but not those exact optimizer trajectories. Use the Julia harness or a saved fitted-model JSON when global-fit identity matters.

## Known scope differences

- Universal genetic code only; the Julia API accepts other genetic-code objects.
- No branch-length or topology optimization option.
- WebGPU accelerates the conditional-likelihood grid. Gibbs remains in f64 WASM; the rejection kernel is already faster than the measured Julia sampler on the validation data and avoids GPU synchronization complexity.
- WebGPU is f32; strict f64 is WASM.
- GPU subtree caching is not yet enabled. The flat GPU program favors massive workgroup parallelism; the CPU uses the dependency-cache DAG.
- The browser displays and exports the reference eight-column table, but it does not reproduce Julia plotting extensions or HyPhy JSON export.

## Recommended acceptance test

For a production GPU target:

1. Generate a small Julia reference with a fixed fitted model and reduced grid.
2. Pass the f64 WASM comparison at `1e-8` maximum absolute log-likelihood error.
3. Run `npm run parity:webgpu` on each target adapter family.
4. Compare normalized GPU conditionals with f64 WASM, not just raw log likelihoods.
5. Run multiple independent 2,500-iteration chains and compare posterior summaries with Monte Carlo confidence intervals.
6. Only then benchmark the full 12,096-category grid.
