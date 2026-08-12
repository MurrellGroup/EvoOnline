# FSART recombination simulation benchmark

Generated 2026-08-12T20:53:47.654Z. This report is descriptive for the pinned simulator/configuration below; it is not a claim of general calibration.

## Design

- **Replicates:** 3 per diversity × recombination scenario; 9 taxa; 3000 aligned nucleotides; deterministic base seed 20260812.
- **Evolution:** exact Gillespie simulation under a four-state GTR CTMC (π = 0.30/0.20/0.22/0.28, elevated transition rates) on random bifurcating trees with heterogeneous branch lengths.
- **Diversity:** paired branch-length scales target the approximately 5% and 25% divergence regimes in GARD's broad 8-taxon, 3,000-nt simulations. All interpretation uses realized pairwise p-distance and informative-event supply rather than the scale label.
- **Rate variation:** continuous Gamma(shape 0.55) site rates, approximately 8% invariant sites, and an AR(1)-correlated lognormal regional multiplier. Realized mean invariant fraction was 0.080; positive-rate median 0.485, q90 2.851, maximum 16.262.
- **Data imperfections:** sparse ambiguous bases and short gap tracts.
- **Recombination:** the primary suite uses 0, 1, 2, or 3 well-separated breakpoints over 3000 nt. Every adjacent tree is required to differ in its **unrooted split set** by at least one NNI; root-only rearrangements are rejected by the simulator. Four- and eight-event mosaics are separate stress cases.
- **Matching:** a predicted breakpoint is a true positive only in a one-to-one assignment within ±60 nt. The assignment first maximizes matches and then minimizes total absolute error.
- **Intervals:** triplet-HMM intervals condition on a candidate-associated local switch mode. Topology-HMM intervals instead use the full-alignment switching posterior, merge nearby subpeaks belonging to one posterior mode, and discard modes carrying negligible expected-switch mass.
- **Topology:** normalized Robinson–Foulds distance is integrated over every overlap between inferred and true segments; 0 is perfect and 1 is maximally discordant under the observed split sets.
- **Timing:** wall time excludes simulation. The legacy fixed partition and consensus-family HMM are timed independently after the shared scan; the HMM row includes family generation, all site-emission fits, rapid subset search, and up to three Viterbi/tree-refit cycles. Scanner timings use one Node worker (the browser shards across up to eight); tree timings use FastTree 2.2.0 Double precision rather than bioWASM. Oracle+AICc and single-tree rows are diagnostics, not deployable breakpoint detectors.

## Headline findings

- **GARD low-diversity regime (~5% target) (realized p-distance 0.045):** legacy fixed-partition F1 0.242; consensus-family topology-HMM F1 0.320; oracle-candidate AICc F1 0.714.
- **GARD high-diversity regime (~25% target) (realized p-distance 0.230):** legacy fixed-partition F1 0.579; consensus-family topology-HMM F1 0.600; oracle-candidate AICc F1 0.875.

- No multiple-comparisons correction is used to admit initial breakpoint candidates. The scan produces a bounded evidence ranking; whole-model AICc controls complexity downstream.
- Candidate-local HMM interval coverage must be read together with width and point-estimate error. Conditioning fixes the invalid whole-alignment normalization but cannot rescue a scan candidate attached to the wrong biological breakpoint.

## Candidate retrieval (not final discoveries)

The two scan layers are deliberately uncorrected bounded rankings. Precision and null false-positive counts are therefore category errors; the useful quantities are whether a true breakpoint entered the budget, where it ranked/localized, and how much time candidate generation cost.

| Diversity | Candidate layer | Recall within retained budget | Mean candidates/alignment | Nearest MAE (nt) | Interval coverage | Mean interval width | Median time |
|---|---|---:|---:|---:|---:|---:|---:|
| GARD low-diversity regime (~5% target) | Ranked window candidates | 0.889 | 48.7 | 16.7 | — | — | 3.6 ms |
| GARD low-diversity regime (~5% target) | Consensus triplet proposals | 0.333 | 5.8 | 20.5 | 0.407 | 107.6 | 82.2 ms |
| GARD high-diversity regime (~25% target) | Ranked window candidates | 1.000 | 64.0 | 8.1 | — | — | 6.2 ms |
| GARD high-diversity regime (~25% target) | Consensus triplet proposals | 0.778 | 12.8 | 29.4 | 0.278 | 29.9 | 326.6 ms |

## Realized diversity and usable triplet information

| Diversity stratum | Branch scale | Mean p-distance | Pairwise q10–q90 | Variable sites | Parsimony-informative | Median events/triplet | Triplets with ≥48 events |
|---|---:|---:|---:|---:|---:|---:|---:|
| GARD low-diversity regime (~5% target) | 0.12 | 0.045 | 0.025–0.063 | 0.124 | 0.063 | 192.8 | 1.000 |
| GARD high-diversity regime (~25% target) | 1.20 | 0.230 | 0.161–0.284 | 0.476 | 0.332 | 814.5 | 1.000 |

The final column is the fraction of taxa triplets capable of supplying FSART's default 24 informative events on each side of a boundary. High event count is necessary but not sufficient: recurrent substitutions and branch-length asymmetry can still obscure which pair dominates.

## Final-model breakpoint and topology results

Pooled over all non-null recombination scenarios within each diversity stratum:

| Diversity | Approach | Precision | Recall | F1 | Exact count | MAE (nt) | Local interval coverage | Mean local width | Topology RF | Median time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| GARD low-diversity regime (~5% target) | Legacy greedy fixed partition | 0.267 | 0.222 | 0.242 | 0.444 | 26.3 | 0.375 | 126.5 | 0.053 | 3.92 s |
| GARD low-diversity regime (~5% target) | Consensus-family HMM + refit | 0.571 | 0.222 | 0.320 | 0.444 | 38.8 | 0.722 | 151.2 | 0.064 | 7.28 s |
| GARD low-diversity regime (~5% target) | Oracle candidates + AICc | 1.000 | 0.556 | 0.714 | 0.556 | 0.0 | — | — | 0.051 | 1.79 s |
| GARD high-diversity regime (~25% target) | Legacy greedy fixed partition | 0.550 | 0.611 | 0.579 | 0.556 | 25.4 | 0.278 | 28.1 | 0.018 | 10.50 s |
| GARD high-diversity regime (~25% target) | Consensus-family HMM + refit | 0.750 | 0.500 | 0.600 | 0.444 | 21.9 | 0.792 | 112.7 | 0.036 | 9.82 s |
| GARD high-diversity regime (~25% target) | Oracle candidates + AICc | 1.000 | 0.778 | 0.875 | 0.778 | 0.0 | — | — | 0.014 | 2.14 s |

## Accuracy by recombination complexity

| Diversity | Scenario | Legacy fixed-partition F1 | Consensus-family HMM F1 | Oracle+AICc F1 |
|---|---|---:|---:|---:|
| GARD low-diversity regime (~5% target) | 1 breakpoint · 1 NNI | 0.500 | 0.667 | 1.000 |
| GARD low-diversity regime (~5% target) | 2 breakpoints · 1 NNI each | 0.308 | 0.222 | 0.909 |
| GARD low-diversity regime (~5% target) | 3 breakpoints · 1 NNI each | 0.000 | 0.200 | 0.364 |
| GARD high-diversity regime (~25% target) | 1 breakpoint · 1 NNI | 0.667 | 1.000 | 1.000 |
| GARD high-diversity regime (~25% target) | 2 breakpoints · 1 NNI each | 0.833 | 0.800 | 1.000 |
| GARD high-diversity regime (~25% target) | 3 breakpoints · 1 NNI each | 0.353 | 0.286 | 0.714 |

For the no-recombination scenario, precision/recall/F1 are undefined; false positives per alignment are more informative:

| Diversity | Approach | FP/alignment | Exact zero-count rate | Median time |
|---|---|---:|---:|---:|
| GARD low-diversity regime (~5% target) | Legacy greedy fixed partition | 0.00 | 1.000 | 3.96 s |
| GARD low-diversity regime (~5% target) | Consensus-family HMM + refit | 0.00 | 1.000 | 4.83 s |
| GARD low-diversity regime (~5% target) | Oracle candidates + AICc | 0.00 | 1.000 | 0.0 ms |
| GARD high-diversity regime (~25% target) | Legacy greedy fixed partition | 0.33 | 0.667 | 7.20 s |
| GARD high-diversity regime (~25% target) | Consensus-family HMM + refit | 0.00 | 1.000 | 5.84 s |
| GARD high-diversity regime (~25% target) | Oracle candidates + AICc | 0.00 | 1.000 | 0.0 ms |

## Interpretation controls

- **Ranked window candidates** isolate the optimized informative-triplet G-test and spatial non-maximum suppression without a significance gate.
- **Consensus triplet proposals** combine rate-marginalized candidate-local modes by corroborating-triplet count and compressed evidence strength, then apply the information-aware hard-spacing guard. They are still proposals, not final discoveries.
- **Legacy greedy fixed partition** is retained only as a comparator for the previous implementation; it commits to one breakpoint at a time.
- **Consensus-family HMM + refit** hard-spaces count/strength consensus proposals (150 nt by default, raised until a window is expected to contain at least max(30, 2 × taxa) variable sites), fits every atomic segment plus adjacent pairs/triplets and the global tree, caches every unique topology's site likelihoods, searches subsets with a beam plus reversible add/drop/swap moves, then alternates a minimum-run Viterbi path with tree refits. Its switch-mode intervals do not assume the proposal boundaries are final.
- **Oracle candidates + AICc** supplies the true breakpoints to the same FastTree rule. Its gap from FSART+AICc separates candidate-generation failures from model-selection failures.
- **Single FastTree** is a topology-only baseline. It cannot detect breakpoints.

## Important limitations

This simulator is intentionally rough rather than an ecological truth generator. NNI changes approximate local genealogy changes but do not explicitly simulate a recombinant lineage, ancestral recombination graph, gene conversion tract, selection, indel evolution, or population structure. GTR+Gamma is favorable to the FastTree scoring model. The uncorrected triplet ranking is candidate generation, not a calibrated hypothesis test; null control belongs to the whole-model IC stages. Use the included CLI to expand taxa, length, replicates, topology contrast, diversity scales, and rate settings.

## Published GARD calibration target

The original GARD study's broad suite used 8 taxa × 3,000 nt at roughly 5% and 25% divergence with 0, 1, 2, 4, or 8 recombination events. Its reported probability of detecting any recombination was 56%/76% for one event, 74%/88% for two, 84%/99% for four, and 97%/98% for eight in low/high-diversity strata; the corresponding no-event false-positive rates were 10% and 6%. Separate 9-sequence fixed scenarios with two or three breakpoints had much stronger signal. See the [GARD method paper](https://academic.oup.com/mbe/article/23/10/1891/1096946) and [software paper](https://academic.oup.com/bioinformatics/article/22/24/3096/208339). Those published simulations are a calibration target, not a directly interchangeable control for this simulator; parity requires replicated same-data GARD runs.

Files: `summary.csv`, `replicates.csv`, `results.json`, and `accuracy-timing.svg`.
