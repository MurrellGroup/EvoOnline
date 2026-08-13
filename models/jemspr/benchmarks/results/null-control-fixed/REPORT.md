# JEMSPR complex-recombinant benchmark

Generated 2026-08-13T17:16:04.352Z.

## Design

- **Truth:** 8 taxa, 1,200 nt, one rooted master, 0 persistent rSPR templates, 0 interval occurrences, 0 endpoint coordinates, and maximum concurrent overlap 0.
- **History:** No recombination; this is a false-positive control.
- **Evolution:** exact Gillespie GTR CTMC, heterogeneous branch lengths, continuous Gamma site rates, invariant sites, correlated regional rate multipliers, light ambiguity, and short gap tracts.
- **Realized diversity:** mean pairwise p-distance 17.0%; variable 35.6%; parsimony-informative 23.8%.
- **Primary topology metric:** alignment-length-weighted site-averaged normalized unrooted RF, i.e. the normalized RF between true and inferred local tree is computed at every nucleotide and averaged. Rooted RF is reported as a diagnostic, but the reversible GTR simulator contains no information identifying the root.
- **Breakpoint matching:** exact ordered one-to-one assignment within ±30 nt (2.5% of alignment length), maximizing matches then minimizing total absolute error. Endpoint-range coverage is descriptive optimization-gap coverage, not frequentist confidence coverage.
- **Replicates:** 3 independently evolved alignments; the same planted event graph and coordinates are used so ablations are paired.

## Results

| Variant | Median s | Site unrooted RF ↓ | Exact unrooted sites ↑ | Site rooted RF † | Breakpoint F1 ↑ | BP MAE nt ↓ | Event occurrences | Max overlap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Default regularization | 4.12 | 0.000 | 100.0% | 0.333 | 1.000 | — | 0.00 | 0.00 |

### Search/scoring diagnostics

| Variant | Relaxed-path unrooted RF ↓ | Relaxed-path BP F1 ↑ | Planted-network decoder unrooted RF ↓ | Planted-network decoder BP F1 ↑ | Planted-network objective − inferred ↓ | No-event runs |
|---|---:|---:|---:|---:|---:|---:|
| Default regularization | 0.000 | 1.000 | 0.000 | 1.000 | 0.00 | 100% |

If the planted-network objective minus the inferred objective is positive, the configured objective itself prefers the inferred solution even when the exact planted switching DAG is supplied; a negative value instead exposes an outer-search miss. The planted-network decoder may choose a different mask path from the simulated one because it is optimized under the same penalties as the fitted method.

## Variants

- **Default regularization** (`default`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":3,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"pathBreakpointPenalty":4,"pathEndpointPenalty":1,"pathSpanPenalty":0.002,"maximumReticulations":5,"overlapCap":3,"networkBeamWidth":8,"eventPoolSize":20,"eventOpenPenalty":2,"eventClosePenalty":0,"networkBreakpointPenalty":2,"eventSpanPenalty":0.002,"reticulationPenalty":2,"boundaryConvention":"open"}

## Interpretation guardrails

This benchmark measures reconstruction under a topology-only parsimony objective even though sequence evolution is stochastic GTR. The planted graph is deliberately complex but fixed across replicates. It is an ablation/stress benchmark, not a calibration of biological event probabilities or a comparison with GARD/ClonalFrame/ARG methods. The candidate-tree graph and fixed switching-network dynamic programs are exact within their finite universes; topology generation and the outer network beam remain budgeted.
