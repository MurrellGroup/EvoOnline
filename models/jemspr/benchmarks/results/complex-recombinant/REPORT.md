# JEMSPR complex-recombinant benchmark

Generated 2026-08-13T19:27:30.911Z.

## Design

- **Truth:** 10 taxa, 2,400 nt, one rooted master, 4 persistent rSPR templates, 5 interval occurrences, 8 endpoint coordinates, and maximum concurrent overlap 3.
- **History:** Crossing and nested tracts, recurrent use of one template, simultaneous endpoints, and one right-censored event. Local trees are exact displays of the planted switching DAG.
- **Evolution:** exact Gillespie GTR CTMC, heterogeneous branch lengths, continuous Gamma site rates, invariant sites, correlated regional rate multipliers, light ambiguity, and short gap tracts.
- **Realized diversity:** mean pairwise p-distance 17.2%; variable 38.9%; parsimony-informative 26.6%.
- **Primary topology metric:** alignment-length-weighted site-averaged normalized unrooted RF, i.e. the normalized RF between true and inferred local tree is computed at every nucleotide and averaged. Rooted RF is reported as a diagnostic, but the reversible GTR simulator contains no information identifying the root.
- **Breakpoint matching:** exact ordered one-to-one assignment within ±60 nt (2.5% of alignment length), maximizing matches then minimizing total absolute error. Endpoint-range coverage is descriptive optimization-gap coverage, not frequentist confidence coverage.
- **Replicates:** 1 independently evolved alignments; the same planted event graph and coordinates are used so ablations are paired.

## Results

| Variant | Median s | Site unrooted RF ↓ | Exact unrooted sites ↑ | Site rooted RF † | Breakpoint F1 ↑ | BP MAE nt ↓ | Event occurrences | Max overlap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Balanced regularization | 33.34 | 0.052 | 75.5% | 0.133 | 0.800 | 24.0 | 5.00 | 3.00 |

### Search/scoring diagnostics

| Variant | Relaxed-path unrooted RF ↓ | Relaxed-path BP F1 ↑ | Planted-network decoder unrooted RF ↓ | Planted-network decoder BP F1 ↑ | Planted-network objective − inferred ↓ | No-event runs |
|---|---:|---:|---:|---:|---:|---:|
| Balanced regularization | 0.061 | 0.800 | 0.031 | 0.750 | -2.21 | 0% |

If the planted-network objective minus the inferred objective is positive, the configured objective itself prefers the inferred solution even when the exact planted switching DAG is supplied; a negative value instead exposes an outer-search miss. The planted-network decoder may choose a different mask path from the simulated one because it is optimized under the same penalties as the fitted method.

## Variants

- **Balanced regularization** (`balanced`): {"minimumWindow":120,"maximumDyadicTrees":18,"rootPlacements":4,"maximumGraphStates":48,"maximumGraphIterations":12,"neighbourScreen":112,"frontierStates":5,"nearImprovers":3,"pathBreakpointPenalty":4,"pathEndpointPenalty":1,"pathSpanPenalty":0.002,"maximumReticulations":6,"overlapCap":3,"networkBeamWidth":8,"eventPoolSize":24,"eventOpenPenalty":2,"eventClosePenalty":0,"networkBreakpointPenalty":2,"eventSpanPenalty":0.002,"reticulationPenalty":2,"boundaryConvention":"open"}

## Interpretation guardrails

This benchmark measures reconstruction under a topology-only parsimony objective even though sequence evolution is stochastic GTR. The planted graph is deliberately complex but fixed across replicates. It is an ablation/stress benchmark, not a calibration of biological event probabilities or a comparison with GARD/ClonalFrame/ARG methods. The candidate-tree graph and fixed switching-network dynamic programs are exact within their finite universes; topology generation and the outer network beam remain budgeted.
