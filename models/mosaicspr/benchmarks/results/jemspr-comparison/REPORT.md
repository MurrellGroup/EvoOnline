# JEMSPR versus MosaicSPR on the same complex mosaics

Truth: four persistent rSPR templates, five interval occurrences, 8 breakpoint coordinates, nine distinct local trees, and maximum overlap three. Three independently evolved 8-taxon, 1,200-nt GTR alignments use the same planted history.

## Mean performance

| Method | Mean runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | Breakpoint F1 ↑ | Predicted breakpoints | Runs |
|---|---:|---:|---:|---:|---:|---:|
| JEMSPR web defaults | 1.91 | 0.291 | 15.7% | 0.207 | 1.33 | 2.33 |
| JEMSPR balanced | 5.85 | 0.213 | 34.4% | 0.388 | 2.33 | 3.33 |
| MosaicSPR web defaults | 2.65 | 0.203 | 28.0% | 0.388 | 2.33 | 3.33 |

## Every run

| Replicate | Method | Runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | BP F1 | Predicted BPs | Runs | Trees | Templates | Occurrences | Boundary SPR edits |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | JEMSPR web defaults | 1.76 | 0.235 | 37.0% | 0.222 | 1 | 2 | 2 | 1 | 1 | — |
| 1 | JEMSPR balanced | 4.92 | 0.212 | 37.0% | 0.400 | 2 | 3 | 3 | 2 | 2 | — |
| 1 | MosaicSPR web defaults | 2.75 | 0.182 | 42.6% | 0.400 | 2 | 3 | 3 | — | — | 3 |
| 2 | JEMSPR web defaults | 1.29 | 0.300 | 0.0% | 0.400 | 2 | 3 | 2 | 1 | 1 | — |
| 2 | JEMSPR balanced | 4.33 | 0.168 | 33.0% | 0.400 | 2 | 3 | 3 | 2 | 2 | — |
| 2 | MosaicSPR web defaults | 2.20 | 0.230 | 8.0% | 0.400 | 2 | 3 | 3 | — | — | 3 |
| 3 | JEMSPR web defaults | 2.68 | 0.337 | 10.0% | 0.000 | 1 | 2 | 2 | 1 | 1 | — |
| 3 | JEMSPR balanced | 8.29 | 0.259 | 33.3% | 0.364 | 3 | 4 | 3 | 2 | 2 | — |
| 3 | MosaicSPR web defaults | 3.01 | 0.197 | 33.5% | 0.364 | 3 | 4 | 4 | — | — | 5 |

MosaicSPR uses the real production pipeline: default triplet proposals, the proposal/overlap window family, FastTree 2.1.11 `-fastest` seed fits, and default SPR reconstruction settings. JEMSPR uses the exact parameter defaults in the web manifest. The balanced JEMSPR row is a labelled penalty-profile ablation, not the web default.

Runtime caveat: MosaicSPR's seed trees were fitted with native FastTree 2.1.11; EvoOnline uses the same FastTree version through bioWASM, so browser wall time will generally be higher. Accuracy inputs and downstream algorithms are otherwise the same.
