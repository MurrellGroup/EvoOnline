# EvoOnline simulator → selection-method benchmark

This is an executable end-to-end test using EvoOnline's own simulator, Newick/FASTA outputs, global codon fitting, WASM likelihood engines, posterior inference, and result tabulation. Random seeds and complete configurations are saved beside the outputs.

## Design

- 48 heterochronous tips from the logistic sampled-coalescent preset.
- 480 codons under the nonuniform flu-demo GTR/F3×4 process.
- Branch scale 0.0045 for the main controls; Gamma(α) has mean 1 and shape 2.5.
- Neutral control: ω=1. Heterogeneous control: Gamma(ω) with mean 0.8 and shape 1.
- FUBAR uses the production 20×20 grid, Dirichlet-EM, posterior threshold 0.95, and the optional approximate-FEL calculation.
- FAME/FLAVOR use their production fast grids and Dirichlet-EM; FLAVOR uses Julia-style transition interpolation. Their positive event is not identical to constant-across-branch MG94 truth, so their scores are deliberately treated as a model-mismatch stress test.

## Realized datasets

| Dataset | Tree height | Mean nt distance | Mean AA distance | Segregating nt | Visible recomb. events | Local trees |
|---|---:|---:|---:|---:|---:|---:|
| neutral-mg94 | 68.7 | 0.120 | 0.232 | 873 | 0 | 1 |
| heterogeneous-mg94 | 68.7 | 0.101 | 0.176 | 725 | 0 | 1 |
| recombinant-mg94 | 66.8 | 0.097 | 0.170 | 753 | 2 | 5 |
| scuff-block-contrast | 77.2 | 0.124 | 0.237 | 860 | 0 | 1 |

The main tree's sampled-tip ages span 0.00–17.37 demographic-time units. Its scaled root depth is 0.309 and total scaled tree length is 3.307.

## Recovery

| Dataset | Method | Target | Calls | Sensitivity | Precision | ROC AUC | Average precision | Strong-site sensitivity | Runtime |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| neutral-mg94 | FUBAR | positive | 1 | — | 0.0% | — | — | — | 80.1 |
| neutral-mg94 | FUBAR | purifying | 2 | — | 0.0% | — | — | — | 80.1 |
| neutral-mg94 | approx-FEL | positive | 25 | — | 0.0% | — | — | — | 80.1 |
| neutral-mg94 | approx-FEL | purifying | 30 | — | 0.0% | — | — | — | 80.1 |
| heterogeneous-mg94 | FUBAR | positive | 13 | 9.4% | 100.0% | 0.801 | 0.670 | 15.3% | 76.4 |
| heterogeneous-mg94 | FUBAR | purifying | 29 | 8.2% | 96.6% | 0.819 | 0.909 | 9.5% | 76.4 |
| heterogeneous-mg94 | approx-FEL | positive | 33 | 21.0% | 87.9% | 0.756 | 0.617 | 27.1% | 76.4 |
| heterogeneous-mg94 | approx-FEL | purifying | 58 | 16.1% | 94.8% | 0.671 | 0.852 | 18.6% | 76.4 |
| heterogeneous-mg94 | FAME | positive | 18 | 12.3% | 94.4% | 0.834 | 0.702 | 20.0% | 202.4 |
| heterogeneous-mg94 | FLAVOR | positive | 11 | 8.0% | 100.0% | 0.829 | 0.689 | 12.9% | 84.2 |
| recombinant-true-regional | FUBAR | positive | 9 | 6.4% | 100.0% | 0.770 | 0.648 | 12.5% | 113.7 |
| recombinant-true-regional | FUBAR | purifying | 39 | 11.2% | 97.4% | 0.794 | 0.891 | 12.4% | 113.7 |
| recombinant-master-only | FUBAR | positive | 10 | 6.4% | 90.0% | 0.767 | 0.639 | 12.5% | 75.0 |
| recombinant-master-only | FUBAR | purifying | 41 | 11.8% | 97.6% | 0.790 | 0.890 | 13.1% | 75.0 |
| scuff-calm-vs-adaptive | FLAVOR | adaptive SCUFF block | 0 | 0.0% | — | 0.537 | 0.556 | — | 97.5 |

"Strong" means ω≥1.5 for positive selection or ω≤0.67 for purifying selection. ROC/average precision use the complete continuous posterior and therefore separate ranking quality from the deliberately stringent reporting threshold.

## Checks that matter

- **Neutral calibration:** FUBAR made 1 positive and 2 purifying calls at posterior ≥0.95 across 480 truly neutral sites. Approximate FEL made 25 directional-positive and 30 directional-purifying calls at p≤0.05.
- **Recombination handoff:** using the exact regional genealogies gave positive-selection ROC AUC 0.770 versus 0.767 with only the master tree. This comparison uses the same fitted global codon model for the master-only rerun, isolating the local-tree assignment.
- **SCUFF stress test:** the calm block has diagnostic mean expected dN/dS 0.985 and theoretical maximum-mean reference 1.025; the adaptive/high-jump block has 1.283 and 1.729. FLAVOR's adaptive-block ROC AUC is 0.537. This is a block-discrimination stress test, not a claim that SCUFF's time-varying fitness process has a single binary site truth.

## Interpretation

- The 9.7–12.4% mean nucleotide divergences are informative without looking saturated in the tree/alignment audits. This is a useful moderate-information default.
- At posterior 0.95, FUBAR is intentionally conservative here: its positive calls have 100% precision and purifying calls 96.6% precision, but strong-site sensitivity is only 15.3% and 9.5%. For a power-testing preset, increase to roughly 64–80 tips and 600–900 codons while keeping realized mean nucleotide divergence around 12–18%.
- Approximate FEL gains thresholded sensitivity but loses ranking and precision relative to FUBAR. Its neutral directional-positive and directional-purifying rates are 5.2% and 6.3%; these are two separate one-sided 5% tests and should not be pooled and compared with a single 5% null rate.
- FAME has the strongest positive-site ranking in the MG94 stress test (ROC AUC 0.834), narrowly followed by FLAVOR (0.829), but FAME is much slower. Because constant-across-branch MG94 is not their native episodic event, this is not a claim that either supersedes FUBAR.
- The exact regional trees only slightly improve this mild two-event recombination case. That is the correct qualitative outcome: a small recombinant history should not manufacture a dramatic selection result.
- Most importantly, FLAVOR does **not** automatically recover the adaptive SCUFF block despite its diagnostic expected dN/dS exceeding one. The posterior shifts only weakly (ROC AUC 0.537) and makes no 0.9 calls. Treat FLAVOR-on-SCUFF recovery as unvalidated until a larger replicate study identifies which aspects of continuously changing fitness are—or are not—represented by FLAVOR's across-branch Gamma mixture.

## Visual audits

- [Main heterogeneous tree + induced AA alignment](heterogeneous-mg94.tree-alignment.svg)
- [Recombinant tree + induced AA alignment](recombinant-mg94.tree-alignment.svg)
- [SCUFF block tree + induced AA alignment](scuff-block-contrast.tree-alignment.svg)
- [FUBAR posterior against true ω](heterogeneous-mg94.posterior-vs-truth.svg)
- [Measured runtimes](runtimes.svg)

Consensus matches are intentionally faded in the alignment audits, making repeated homoplasy and divergent columns visible without expanding vertical spacing.

## Files

Each dataset has FASTA, substitution-length Newick, time Newick, JSON configuration, and TSV truth. Method CSVs are direct EvoOnline exports. The recombination case additionally includes every branch-interior event and every true local genealogy.
