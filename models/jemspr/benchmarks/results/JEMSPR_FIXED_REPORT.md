# JEMSPR search repair and post-fix benchmark

Generated 13 August 2026. This report records the defect, the repair, and paired post-fix tests. The exact fixed-network mask dynamic program was not changed.

## Defect

The previous outer search could stop after only two non-improving reticulation depths. More importantly, it grouped beam candidates mainly by the set of display trees currently occupied by the decoded path. A newly added reticulation can be structurally necessary yet initially unused; such a *bridge prefix* therefore has the same occupied display set as its parent and was routinely discarded before a later event could make it useful. Candidate events were also drawn from a static master-relative pool, so the search did not reliably propose a rooted-SPR move inside an alternate display context created by an earlier reticulation.

This combination explains the characteristic failure mode: the exact decoder often selected one useful event, but the outer search almost never reached the overlapping or multi-step histories needed by the simulated mosaic.

## Repair

The repaired search:

1. regenerates bounded rooted-SPR proposals within retained occupied and latent display contexts;
2. retains deterministic guide-derived moves when they remain legal in those contexts;
3. gives each retained context proposal capacity instead of letting one high-scoring context consume the pool;
4. keeps a diverse beam assembled from fully used objective leaders, raw-parsimony leaders, event-use coverage, and explicitly scored latent bridge prefixes;
5. no longer merges structurally distinct unused prefixes merely because their current decoded display set is identical; and
6. explores the requested reticulation depth unless no legal children remain, rather than stopping after two stale depths.

The production overlap cap is now three, matching the complexity the user-facing method claims to permit. Production penalties were moved to the previously null-safe balanced regime. Every admitted child is still scored by the same exact active-mask dynamic program, and temporal infeasibility remains a hard lazy cut.

## Paired complex-mosaic benchmark

All rows below use the same three independently evolved 8-taxon, 1,200-nt GTR alignments. Their planted history contains four persistent rooted-SPR templates, five occurrences, eight breakpoint coordinates, nine local trees, and maximum overlap three.

| Method | Mean runtime s | Site-averaged unrooted RF ↓ | Exact-tree sites ↑ | Breakpoint F1 ↑ | Predicted breakpoints | Runs |
|---|---:|---:|---:|---:|---:|---:|
| Old JEMSPR web defaults | 1.91 | 0.291 | 15.7% | 0.207 | 1.33 | 2.33 |
| **Repaired JEMSPR web defaults** | **7.17** | **0.201** | **33.8%** | **0.485** | **3.00** | **4.00** |
| Repaired JEMSPR, expanded search | 10.43 | 0.211 | 33.8% | 0.436 | 2.67 | 3.67 |
| MosaicSPR web defaults | 2.54 | 0.203 | 28.0% | 0.388 | 2.33 | 3.33 |

The repair reduces mean site-averaged RF by 31%, more than doubles the exact-tree span, and more than doubles breakpoint F1 relative to the old JEMSPR default. It also removes the implausible one-event collapse: the repaired default returns four genomic runs in every replicate and two or three persistent templates. The larger search budget is not monotonically better on three stochastic replicates, which is why the smaller repaired configuration remains the production default.

Per-replicate outputs and the exact MosaicSPR comparison are in [`../../../mosaicspr/benchmarks/results/jemspr-comparison-fixed`](../../../mosaicspr/benchmarks/results/jemspr-comparison-fixed). The old paired output is retained in the adjacent `jemspr-comparison` directory for auditability.

## Null control

Three independent no-recombination alignments were simulated under the same taxon count, length, heterogeneous GTR process, ambiguity, and gap model. Repaired JEMSPR inferred zero templates, zero occurrences, zero breakpoints, and one genomic run in all three. Mean site-averaged unrooted RF was 0 and exact-tree coverage was 100%. Median runtime was 4.12 s. Rooted RF was 0.333 because the reversible simulation contains no information identifying the root; this is expected and is not the primary metric.

Raw null-control files and the report are in [`null-control-fixed`](null-control-fixed).

## Regression and repository checks

A dedicated regression test constructs three sharply supported four-taxon regions whose explanation requires two event templates, then permits five reticulation depths. It asserts recovery of all three runs at the two planted boundaries and verifies that the search actually traverses the full requested depth. The old stale-depth/beam-collapse search fails this test.

At this checkpoint:

- JEMSPR unit tests: 8/8 passed;
- all workspace tests passed;
- all workspace TypeScript checks passed; and
- the production Vite build completed successfully.

## Interpretation

This is evidence that the observed one-event behavior was an outer-search defect. It is not evidence of global optimality or biological calibration. Fixed-network decoding is exact within a supplied switching DAG; rooted-tree generation and the outer network beam remain finite, explicitly budgeted searches. The benchmark has three paired replicates and should be expanded before making operating-characteristic claims.
