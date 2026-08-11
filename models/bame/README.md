# FAME, FLAVOR, and Glamma

Browser-parallel f64 WASM ports of the experimental FAME and FLAVOR models on
`CodonMolecularEvolution.jl`'s `MixtureModels` branch, pinned to commit
`4c65c984b2e7ad121f5e28298de69bdc0dd427b7`.

The package also contains EvoOnline's exploratory Glamma branch–site
scan. That model is not claimed as part of the pinned Julia branch: it fits a
single Gamma(ω) over branch–site cells and a mean-one Gamma(α) over sites,
always reports exact full-vs-ω>1→1-null evidence, and integrates a sparse branch
activation alternative from the same two-sided local likelihood ratios.

- FAME uses an explicit convex mixture of two MG94 transition matrices on every
  branch. The recommended mode marginalizes the unknown mixture weight in the
  likelihood domain with Gauss-Legendre quadrature.
- `julia-draft-log-average` reproduces the branch's arithmetic average of log
  likelihoods across equally spaced weight values. That operation is not a
  likelihood marginal and is therefore not the default.
- FLAVOR uses the branch's mid-quantile discrete-Gamma approximation, including
  both uncapped and ω≤1-capped category grids.
- FLAVOR defaults to the source's `matrix_sequence` transition interpolation:
  one `exp(Q * 0.001)` per atomic ω, the same 50-node/cap-35 semigroup
  recurrence, and element-wise linear interpolation. One Gamma-mixture table
  is shared by every α value, branch, and site. Direct uniformization remains
  selectable as a no-interpolation accuracy reference.
- Both methods use Dirichlet-EM by default and additionally offer exact Gibbs
  allocation sampling.
- Browser runs default to a transformed fast grid (512 FAME or 896 FLAVOR
  categories); the exact 3,375/6,720-category development grids remain a
  selectable reproducibility preset.

For Glamma, α is an outer site category shared by the entire tree and ω
is an inner transition mixture drawn independently on each branch. Its tests
compare that nesting to complete enumeration of latent branch states. The ω
quadrature is split at one and uses conditional-bin means/weights, preserving
both the Gamma mean and its exact positive-tail probability. Alpha uses
equal-probability conditional means with an exact discrete mean of one.

Atomic MG94 models are represented at α=1 and branch time is scaled per
mixture operator. This removes redundant rate matrices across the α grid.
Repeated capped FLAVOR components are combined exactly within each transition
mixture, without removing the draft's repeated outer grid categories.

FAME deliberately retains direct uniformization. The pinned FAME source does
not use `InterpolatedDiscreteModel`, and applying FLAVOR's shared table would
change or duplicate its mixture-weight integration rather than merely port an
upstream acceleration.

Run `npm run bench:transitions -w @phylo-workbench/model-bame` to compare the
two FLAVOR transition engines on the bundled demo.

Run `npm run bench:glamma -w @phylo-workbench/model-bame` for a staged Glamma
benchmark. The fast global fit evaluates a 64-point logarithmic parameter
design followed by two local refinements; the thorough preset retains the
dense 1,100-point coarse scan.

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
