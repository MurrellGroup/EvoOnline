# JEMSPR versus MosaicSPR on the same complex mosaics

Truth: four persistent rSPR templates, five interval occurrences, 8 breakpoint coordinates, nine distinct local trees, and maximum overlap three. Three independently evolved 8-taxon, 1,200-nt GTR alignments use the same planted history.

## Mean performance

| Method | Mean runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | Breakpoint F1 ↑ | Predicted breakpoints | Runs |
|---|---:|---:|---:|---:|---:|---:|
| JEMSPR fixed web defaults | 7.17 | 0.201 | 33.8% | 0.485 | 3.00 | 4.00 |
| JEMSPR expanded search | 10.43 | 0.211 | 33.8% | 0.436 | 2.67 | 3.67 |
| MosaicSPR web defaults | 2.54 | 0.203 | 28.0% | 0.388 | 2.33 | 3.33 |

## Every run

| Replicate | Method | Runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | BP F1 | Predicted BPs | Runs | Trees | Templates | Occurrences | Boundary SPR edits |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | JEMSPR fixed web defaults | 6.42 | 0.183 | 37.0% | 0.545 | 3 | 4 | 4 | 3 | 3 | — |
| 1 | JEMSPR expanded search | 10.36 | 0.212 | 37.0% | 0.400 | 2 | 3 | 3 | 2 | 2 | — |
| 1 | MosaicSPR web defaults | 2.72 | 0.182 | 42.6% | 0.400 | 2 | 3 | 3 | — | — | 3 |
| 2 | JEMSPR fixed web defaults | 8.29 | 0.161 | 31.3% | 0.545 | 3 | 4 | 3 | 2 | 2 | — |
| 2 | JEMSPR expanded search | 10.50 | 0.161 | 31.3% | 0.545 | 3 | 4 | 3 | 2 | 2 | — |
| 2 | MosaicSPR web defaults | 2.21 | 0.230 | 8.0% | 0.400 | 2 | 3 | 3 | — | — | 3 |
| 3 | JEMSPR fixed web defaults | 6.79 | 0.260 | 32.9% | 0.364 | 3 | 4 | 3 | 3 | 4 | — |
| 3 | JEMSPR expanded search | 10.42 | 0.260 | 32.9% | 0.364 | 3 | 4 | 3 | 3 | 4 | — |
| 3 | MosaicSPR web defaults | 2.69 | 0.197 | 33.5% | 0.364 | 3 | 4 | 4 | — | — | 5 |

MosaicSPR uses the real production pipeline: default triplet proposals, the proposal/overlap window family, FastTree 2.1.11 `-fastest` seed fits, and default SPR reconstruction settings. JEMSPR fixed defaults use the repaired production search and exact parameter defaults in the web manifest. The expanded-search row changes only search budgets (48 tree-graph states, 12 expansion rounds, 96 neighbour screens, beam 10, event pool 24); it does not weaken the selected-model penalties.

Runtime caveat: MosaicSPR's seed trees were fitted with native FastTree 2.1.11; EvoOnline uses the same FastTree version through bioWASM, so browser wall time will generally be higher. Accuracy inputs and downstream algorithms are otherwise the same.
