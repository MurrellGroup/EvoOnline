# Interactive topology-HMM cached-emission stress benchmark

This deterministic benchmark times only inference over a precomputed 3,000-site × 24-tree likelihood bank. It intentionally excludes FastTree: slider changes in EvoOnline reuse exactly this bank. Per-site log-likelihood noise is independent across tree hypotheses, with a planted coherent topology advantage. Breakpoint matching uses a ±40-site tolerance.

## Default comparison (2 prior reset opportunities)

| Scenario | Method | Trees retained | Viterbi breakpoints | Precision | Recall | F1 | Median update |
|---|---|---:|---|---:|---:|---:|---:|
| No topology change | Conservative AICc | 1 | none | 1.000 | 1.000 | 1.000 | 3716.0 ms |
| No topology change | Low-switch Viterbi retention | 1 | none | 1.000 | 1.000 | 1.000 | 16.6 ms |
| No topology change | Sparse Dirichlet-EM | 1 | none | 1.000 | 1.000 | 1.000 | 31.2 ms |
| Two long, strong tracts | Conservative AICc | 3 | 999, 2001 | 1.000 | 1.000 | 1.000 | 3951.5 ms |
| Two long, strong tracts | Low-switch Viterbi retention | 3 | 999, 2001 | 1.000 | 1.000 | 1.000 | 11.6 ms |
| Two long, strong tracts | Sparse Dirichlet-EM | 3 | 999, 2001 | 1.000 | 1.000 | 1.000 | 86.6 ms |
| One weak 300-nt mosaic tract | Conservative AICc | 1 | none | 0.000 | 0.000 | 0.000 | 3606.6 ms |
| One weak 300-nt mosaic tract | Low-switch Viterbi retention | 2 | 1354, 1645 | 1.000 | 1.000 | 1.000 | 11.1 ms |
| One weak 300-nt mosaic tract | Sparse Dirichlet-EM | 2 | 1354, 1645 | 1.000 | 1.000 | 1.000 | 100.2 ms |

## Switching-prior sensitivity

| Scenario | Prior resets | Low-switch breakpoints | Low-switch F1 | Sparse-EM breakpoints | Sparse-EM F1 |
|---|---:|---|---:|---|---:|
| No topology change | 0.25 | none | 1.000 | none | 1.000 |
| No topology change | 0.5 | none | 1.000 | none | 1.000 |
| No topology change | 1 | none | 1.000 | none | 1.000 |
| No topology change | 2 | none | 1.000 | none | 1.000 |
| No topology change | 4 | none | 1.000 | none | 1.000 |
| No topology change | 8 | none | 1.000 | none | 1.000 |
| No topology change | 16 | none | 1.000 | none | 1.000 |
| Two long, strong tracts | 0.25 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 0.5 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 1 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 2 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 4 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 8 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| Two long, strong tracts | 16 | 999, 2001 | 1.000 | 999, 2001 | 1.000 |
| One weak 300-nt mosaic tract | 0.25 | none | 0.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 0.5 | none | 0.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 1 | 1354, 1645 | 1.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 2 | 1354, 1645 | 1.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 4 | 1354, 1645 | 1.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 8 | 1354, 1645 | 1.000 | 1354, 1645 | 1.000 |
| One weak 300-nt mosaic tract | 16 | 1354, 1645 | 1.000 | 1354, 1645 | 1.000 |

## Interpretation

- The conservative result pays for every tree's phylogenetic parameters through AICc; coherent but modest short-tract support can therefore be rejected.
- The two exploratory modes condition on the data-derived draft tree bank as if it were fixed. Their higher sensitivity is real conditional on that bank, but their posterior probabilities are not unconditional model-selection probabilities.
- Low-switch retention is deliberately discontinuous when a Viterbi state enters or leaves the path. Sparse Dirichlet-EM changes more smoothly through its learned post-reset weights, although the final Viterbi path remains discrete.
- This is a kernel stress test, not a calibrated evolutionary simulation. The piecewise-GTR simulation report remains the relevant end-to-end accuracy check; this benchmark isolates the behavior and latency of the new post-analysis controls.
