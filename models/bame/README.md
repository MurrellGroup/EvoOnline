# FAME and FLAVOR

Browser-parallel f64 WASM ports of the experimental FAME and FLAVOR models on
`CodonMolecularEvolution.jl`'s `MixtureModels` branch, pinned to commit
`4c65c984b2e7ad121f5e28298de69bdc0dd427b7`.

- FAME uses an explicit convex mixture of two MG94 transition matrices on every
  branch. The recommended mode marginalizes the unknown mixture weight in the
  likelihood domain with Gauss-Legendre quadrature.
- `julia-draft-log-average` reproduces the branch's arithmetic average of log
  likelihoods across equally spaced weight values. That operation is not a
  likelihood marginal and is therefore not the default.
- FLAVOR uses the branch's mid-quantile discrete-Gamma approximation, including
  both uncapped and ω≤1-capped category grids.
- Both methods use Dirichlet-EM by default and additionally offer exact Gibbs
  allocation sampling.
- Browser runs default to a transformed fast grid (512 FAME or 896 FLAVOR
  categories); the exact 3,375/6,720-category development grids remain a
  selectable reproducibility preset.

Atomic MG94 models are represented at α=1 and branch time is scaled per
mixture operator. This removes redundant rate matrices across the α grid.
Repeated capped FLAVOR components are combined exactly within each transition
mixture, without removing the draft's repeated outer grid categories.

## Development-source audit

The pinned Julia branch contains several behaviors worth treating explicitly:

- FAME averages site log likelihoods across weight values instead of averaging
  likelihoods. EvoOnline retains that behavior only in compatibility mode.
- `BAME` accepts a `method.sampler` field but unconditionally calls `weightEM`;
  EvoOnline's Gibbs option is an implemented allocation sampler rather than a
  forwarded no-op setting.
- Every capped FLAVOR `(mu, shape, alpha)` category remains in the outer grid
  even when clamping makes different categories transition-equivalent. That
  multiplicity affects the learned Dirichlet prior, so it is preserved and
  disclosed.
- The reported Bayes factors are empirical-Bayes ratios because their prior
  odds are learned from the same sites. EvoOnline guards zero/one odds instead
  of allowing unlabelled division artifacts.
- The draft labels its generic output `P(beta>alpha)`, although the tested event
  is an episodic branch-mixture event. EvoOnline uses model-specific labels and
  additionally reports FLAVOR's posterior mean positive-branch fraction.
