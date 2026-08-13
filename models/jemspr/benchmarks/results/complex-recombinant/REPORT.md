# JEMSPR complex-recombinant benchmark

Generated 2026-08-13T14:50:13.155Z.

## Design

- **Truth:** 8 taxa, 1,200 nt, one rooted master, 4 persistent rSPR templates, 5 interval occurrences, 8 endpoint coordinates, and maximum concurrent overlap 3.
- **History:** Crossing and nested tracts, recurrent use of one template, simultaneous endpoints, and one right-censored event. Local trees are exact displays of the planted switching DAG.
- **Evolution:** exact Gillespie GTR CTMC, heterogeneous branch lengths, continuous Gamma site rates, invariant sites, correlated regional rate multipliers, light ambiguity, and short gap tracts.
- **Realized diversity:** mean pairwise p-distance 16.8%; variable 35.5%; parsimony-informative 22.8%.
- **Primary topology metric:** alignment-length-weighted site-averaged normalized unrooted RF, i.e. the normalized RF between true and inferred local tree is computed at every nucleotide and averaged. Rooted RF is reported as a diagnostic, but the reversible GTR simulator contains no information identifying the root.
- **Breakpoint matching:** exact ordered one-to-one assignment within ±30 nt (2.5% of alignment length), maximizing matches then minimizing total absolute error. Endpoint-range coverage is descriptive optimization-gap coverage, not frequentist confidence coverage.
- **Replicates:** 3 independently evolved alignments; the same planted event graph and coordinates are used so ablations are paired.

## Results

| Variant | Median s | Site unrooted RF ↓ | Exact unrooted sites ↑ | Site rooted RF † | Breakpoint F1 ↑ | BP MAE nt ↓ | Event occurrences | Max overlap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Default regularization | 1.35 | 0.343 | 3.3% | 0.576 | 0.133 | 0.0 | 0.33 | 0.33 |
| Default + expanded search | 2.95 | 0.304 | 12.3% | 0.469 | 0.207 | 2.5 | 1.00 | 1.00 |
| Sensitivity profile | 15.75 | 0.162 | 45.3% | 0.449 | 0.543 | 11.5 | 5.00 | 2.33 |
| Sensitivity + overlap cap 1 | 4.04 | 0.156 | 40.1% | 0.460 | 0.515 | 8.2 | 3.33 | 1.00 |
| Sensitivity + one root | 11.97 | 0.155 | 49.3% | 0.356 | 0.571 | 16.2 | 5.67 | 2.00 |
| Sensitivity + two reticulations | 2.95 | 0.212 | 33.2% | 0.469 | 0.426 | 8.1 | 2.33 | 1.67 |
| Sensitivity + expanded search | 29.10 | 0.162 | 42.2% | 0.427 | 0.513 | 10.6 | 4.33 | 2.67 |

### Search/scoring diagnostics

| Variant | Relaxed-path unrooted RF ↓ | Relaxed-path BP F1 ↑ | Planted-network decoder unrooted RF ↓ | Planted-network decoder BP F1 ↑ | Planted-network objective − inferred ↓ | No-event runs |
|---|---:|---:|---:|---:|---:|---:|
| Default regularization | 0.363 | 0.000 | 0.219 | 0.333 | 6.14 | 67% |
| Default + expanded search | 0.365 | 0.000 | 0.219 | 0.333 | 7.45 | 33% |
| Sensitivity profile | 0.137 | 0.538 | 0.092 | 0.604 | -3.77 | 0% |
| Sensitivity + overlap cap 1 | 0.137 | 0.538 | 0.137 | 0.366 | 4.78 | 0% |
| Sensitivity + one root | 0.175 | 0.556 | 0.092 | 0.604 | -2.88 | 0% |
| Sensitivity + two reticulations | 0.137 | 0.538 | 0.092 | 0.604 | -7.08 | 0% |
| Sensitivity + expanded search | 0.135 | 0.628 | 0.092 | 0.604 | -0.37 | 0% |

If the planted-network objective minus the inferred objective is positive, the configured objective itself prefers the inferred solution even when the exact planted switching DAG is supplied; a negative value instead exposes an outer-search miss. The planted-network decoder may choose a different mask path from the simulated one because it is optimized under the same penalties as the fitted method.

## Variants

- **Default regularization** (`default`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":3,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"maximumReticulations":5,"overlapCap":2,"networkBeamWidth":6,"eventPoolSize":16,"eventOpenPenalty":4,"eventClosePenalty":0,"networkBreakpointPenalty":4,"eventSpanPenalty":0.004,"reticulationPenalty":3,"boundaryConvention":"open"}
- **Default + expanded search** (`default-expanded`): {"minimumWindow":80,"maximumDyadicTrees":16,"rootPlacements":4,"maximumGraphStates":42,"maximumGraphIterations":9,"neighbourScreen":96,"frontierStates":6,"nearImprovers":4,"maximumReticulations":7,"overlapCap":2,"networkBeamWidth":8,"eventPoolSize":22,"eventOpenPenalty":4,"eventClosePenalty":0,"networkBreakpointPenalty":4,"eventSpanPenalty":0.004,"reticulationPenalty":3,"boundaryConvention":"open"}
- **Sensitivity profile** (`sensitive`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":3,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"maximumReticulations":5,"overlapCap":3,"networkBeamWidth":6,"eventPoolSize":16,"eventOpenPenalty":1,"eventClosePenalty":0,"networkBreakpointPenalty":1,"eventSpanPenalty":0.0005,"reticulationPenalty":1,"boundaryConvention":"open","pathBreakpointPenalty":2,"pathEndpointPenalty":0.5,"pathSpanPenalty":0.0005}
- **Sensitivity + overlap cap 1** (`sensitive-overlap1`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":3,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"maximumReticulations":5,"overlapCap":1,"networkBeamWidth":6,"eventPoolSize":16,"eventOpenPenalty":1,"eventClosePenalty":0,"networkBreakpointPenalty":1,"eventSpanPenalty":0.0005,"reticulationPenalty":1,"boundaryConvention":"open","pathBreakpointPenalty":2,"pathEndpointPenalty":0.5,"pathSpanPenalty":0.0005}
- **Sensitivity + one root** (`sensitive-one-root`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":1,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"maximumReticulations":5,"overlapCap":3,"networkBeamWidth":6,"eventPoolSize":16,"eventOpenPenalty":1,"eventClosePenalty":0,"networkBreakpointPenalty":1,"eventSpanPenalty":0.0005,"reticulationPenalty":1,"boundaryConvention":"open","pathBreakpointPenalty":2,"pathEndpointPenalty":0.5,"pathSpanPenalty":0.0005}
- **Sensitivity + two reticulations** (`sensitive-retic2`): {"minimumWindow":80,"maximumDyadicTrees":12,"rootPlacements":3,"maximumGraphStates":30,"maximumGraphIterations":7,"neighbourScreen":64,"frontierStates":4,"nearImprovers":2,"maximumReticulations":2,"overlapCap":3,"networkBeamWidth":6,"eventPoolSize":16,"eventOpenPenalty":1,"eventClosePenalty":0,"networkBreakpointPenalty":1,"eventSpanPenalty":0.0005,"reticulationPenalty":1,"boundaryConvention":"open","pathBreakpointPenalty":2,"pathEndpointPenalty":0.5,"pathSpanPenalty":0.0005}
- **Sensitivity + expanded search** (`sensitive-expanded`): {"minimumWindow":80,"maximumDyadicTrees":16,"rootPlacements":4,"maximumGraphStates":42,"maximumGraphIterations":9,"neighbourScreen":96,"frontierStates":6,"nearImprovers":4,"maximumReticulations":7,"overlapCap":3,"networkBeamWidth":8,"eventPoolSize":22,"eventOpenPenalty":1,"eventClosePenalty":0,"networkBreakpointPenalty":1,"eventSpanPenalty":0.0005,"reticulationPenalty":1,"boundaryConvention":"open","pathBreakpointPenalty":2,"pathEndpointPenalty":0.5,"pathSpanPenalty":0.0005}

## Interpretation guardrails

This benchmark measures reconstruction under a topology-only parsimony objective even though sequence evolution is stochastic GTR. The planted graph is deliberately complex but fixed across replicates. It is an ablation/stress benchmark, not a calibration of biological event probabilities or a comparison with GARD/ClonalFrame/ARG methods. The candidate-tree graph and fixed switching-network dynamic programs are exact within their finite universes; topology generation and the outer network beam remain budgeted.
