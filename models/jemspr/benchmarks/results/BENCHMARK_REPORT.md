# JEMSPR complex-recombinant benchmark

This report records the first paired stress benchmark of the independent JEMSPR implementation. It is deliberately diagnostic: it separates local-tree reconstruction, breakpoint localization, event-network regularization, outer-search failure, and false-positive behavior.

## Simulated case

The replicated case contains 8 taxa and 1,200 nucleotide sites. A rooted balanced master is modified by four persistent rSPR templates used in five interval occurrences. The history contains crossing and nested tracts, recurrent use of one template, simultaneous endpoints, one right-censored event, eight distinct endpoint coordinates, maximum event overlap three, and nine distinct displayed local trees.

Sequences were generated on the exact local tree at every site under an exact Gillespie GTR CTMC with heterogeneous branch lengths, Gamma-distributed site rates (shape 0.55), 8% invariant sites, correlated regional rate multipliers, light ambiguity, and short gap tracts. The three independent replicates realized 15.1–16.8% mean pairwise p-distance and 19.8–22.8% parsimony-informative sites. The same event history was used for paired comparisons.

A separate no-recombination control used the same master, sequence length, rate model, and three seeds. One additional scaling run used 10 taxa and 2,400 nt with the same four-template/five-occurrence history; it is a single replicate, not a sampling distribution.

## Metrics

The primary topology metric is site-averaged normalized unrooted RF distance:

\[
D_{\mathrm{site}}=\frac{1}{L}\sum_{i=1}^{L}
\frac{|S(T_i)\,\triangle\,S(\widehat T_i)|}{|S(T_i)|+|S(\widehat T_i)|},
\]

where \(S(T_i)\) is the set of non-trivial unrooted splits at nucleotide \(i\). This integrates both topology and breakpoint error: a wrong tree is charged for exactly the span over which it is assigned. Lower is better. The exact-tree fraction reports the fraction of nucleotide positions whose complete unrooted split set is correct.

Rooted RF is retained only as a diagnostic. Reversible GTR data without an outgroup contain no information identifying the root, so using rooted RF as the primary score would reward arbitrary agreement.

Breakpoint precision, recall, and F1 use an exact ordered one-to-one dynamic-programming match within ±30 nt (2.5% of alignment length; ±60 nt in the 2,400-nt case). Among maximum-cardinality matches, total absolute localization error is minimized. Event templates themselves are not naively label-matched: different rSPR factorizations can produce the same local-tree sequence, so local-tree accuracy is the more identifiable target.

The fixed planted-network decoder supplies an oracle diagnostic. If its objective is worse than the inferred result even when given the exact planted DAG, regularization/scoring—not topology search—is responsible. If it is better, the outer topology/network search missed an available improvement.

## Replicated 8-taxon, 1.2-kb results

| Variant | Median runtime | q90 runtime | Site unrooted RF ↓ | Exact unrooted sites ↑ | Breakpoint F1 ↑ | Mean inferred events | Null false-event runs |
|---|---:|---:|---:|---:|---:|---:|---:|
| Default regularization | 1.35 s | 1.37 s | 0.343 | 3.3% | 0.133 | 0.33 | 0/3 |
| Default + expanded search | 2.95 s | 8.58 s | 0.304 | 12.3% | 0.207 | 1.00 | not run |
| Balanced regularization | 5.44 s | 6.57 s | 0.211 | 33.9% | 0.436 | 2.00 | 0/3 |
| Sensitivity profile | 15.75 s | 17.99 s | 0.162 | 45.3% | 0.543 | 5.00 | 2/3 |
| Sensitivity + overlap cap 1 | 4.04 s | 4.59 s | 0.156 | 40.1% | 0.515 | 3.33 | not run |
| Sensitivity + one root start | 11.97 s | 14.22 s | 0.155 | 49.3% | 0.571 | 5.67 | not run |
| Sensitivity + two-reticulation cap | 2.95 s | 3.75 s | 0.212 | 33.2% | 0.426 | 2.33 | not run |
| Sensitivity + expanded search | 29.10 s | 78.26 s | 0.162 | 42.2% | 0.513 | 4.33 | 2/3 |

The sensitivity profile is an accuracy upper bracket, not a safe default: it called events in two of three null controls. Balanced regularization recovered substantially more signal than the current defaults while retaining zero events in all three null replicates. Three controls are not enough to calibrate a production false-positive rate, so the user-facing default has not been changed.

The overlap-cap-one result should not be read as evidence that overlap is unnecessary. Its fixed planted-network decoder has unrooted RF 0.137 versus 0.092 when overlap three is allowed, proving that the restricted model cannot represent the planted history. Its slightly favorable inferred RF in three replicates is sampling/search variation.

Expanded search is heavy-tailed: the sensitivity-expanded runs were 29.1, 90.6, and 28.9 s. More budget did not monotonically improve accuracy, so increasing every beam/graph limit is not a sensible default.

## Single 10-taxon, 2.4-kb scaling result

| Variant | Runtime | Site unrooted RF ↓ | Exact unrooted sites ↑ | Breakpoint F1 ↑ | BP MAE | Templates / occurrences / max overlap |
|---|---:|---:|---:|---:|---:|---:|
| Default regularization | 37.53 s | 0.114 | 61.2% | 0.500 | 30.3 nt | 3 / 4 / 2 |
| Balanced regularization | 138.87 s | 0.032 | 89.8% | 0.875 | 25.4 nt | 6 / 7 / 3 |
| Sensitivity profile | 114.74 s | 0.086 | 62.0% | 0.667 | 22.0 nt | 5 / 7 / 3 |

With twice as much sequence, even default regularization had enough evidence to recover a useful mosaic. Balanced regularization was the most accurate in this replicate and nearly matched the planted-network decoder's site RF (0.032 versus 0.031), but it represented the tree sequence with more templates and occurrences than were planted. This illustrates why the displayed tree sequence is better identified than one particular rSPR factorization.

## Main conclusions

1. The method can reconstruct a genuinely overlapping, recurrent four-template mosaic, especially with 2.4 kb of data.
2. The current defaults are fast and null-safe in this small test, but under-detect the shorter 1.2-kb mosaic.
3. Balanced regularization is the most promising operating point tested: no null events in 3/3 controls, 0.211 mean site RF at 1.2 kb, and 0.032 in the 2.4-kb scaling replicate.
4. The aggressive profile improves short-case sensitivity but overfits the null and should not be exposed as a recommended default without stronger calibration.
5. The remaining error is partly outer-search error. In the short sensitivity runs, the exact planted network had a mean objective 3.77 units better than the inferred result and site RF 0.092 versus 0.162.
6. Runtime is governed by the number of competitive topologies/networks retained, not sequence length alone; high-budget variants have a pronounced heavy tail.

## Reproduction

From the repository root:

```bash
npm run benchmark:jemspr -- --quick --replicates 3
npm run benchmark:jemspr -- --quick --null --replicates 3 --variants default,balanced,sensitive,sensitive-expanded
npm run benchmark:jemspr -- --replicates 1 --variants default,balanced,sensitive
```

Raw FASTA replicates, truth metadata, per-run CSV, summary CSV, fitted JSON, and machine-readable result JSON are in the sibling result directories.
