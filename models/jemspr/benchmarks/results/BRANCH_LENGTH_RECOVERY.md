# JEMSPR linked branch-length recovery

A genuine compiled one-SPR switching DAG with six taxa and two equally long genomic regions was simulated under known shared network-edge lengths and a nonuniform GTR matrix. The same fixed GTR matrix was supplied to the fit, isolating branch-length/linkage recovery from uncertainty in FastTree's matrix estimate. Horizontal parent-choice edges were zero-time.

Recovery is evaluated with every pairwise patristic distance in both displayed trees. This is the appropriate identifiable target: it is invariant to the arbitrary reversible root split and to network-edge subdivisions that only enter the likelihood through a sum. RRMSE is RMSE divided by the mean true patristic distance.

| Sites | Replicates | Patristic MAE | Relative RMSE | Correlation | Zero-intercept slope | Mean bias | Linked-fit time |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2,000 | 5 | 0.00988 | 6.01% | 0.9892 | 1.0125 | 0.00226 | 20.3 ms |
| 10,000 | 5 | 0.00458 | 2.68% | 0.9979 | 1.0057 | 0.00131 | 24.4 ms |
| 50,000 | 5 | 0.00221 | 1.31% | 0.9994 | 1.0044 | 0.00086 | 70.3 ms |

The test is conditional on the correct fixed GTR matrix and topology/event structure; it is not a test of FastTree's GTR estimation or JEMSPR topology search. Raw replicate results are in `BRANCH_LENGTH_RECOVERY.json`.
