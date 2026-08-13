# JEMSPR benchmarks

`complex-recombinant.ts` constructs an explicit rank-feasible switching DAG, simulates nucleotide alignments on its exact displayed local trees, runs paired JEMSPR variants, and writes auditable raw and summary results.

```bash
# Fast 8-taxon / 1,200-nt stress case
npm run benchmark:jemspr -- --quick --replicates 3

# No-recombination false-positive control
npm run benchmark:jemspr -- --quick --null --replicates 3 \
  --variants default,balanced,sensitive,sensitive-expanded

# Larger 10-taxon / 2,400-nt case
npm run benchmark:jemspr -- --replicates 1 \
  --variants default,balanced,sensitive
```

Options:

- `--quick`: use 8 taxa, 1,200 nt, and reduced search budgets.
- `--null`: remove all planted events while retaining the simulator and master.
- `--replicates N`: number of independently evolved alignments.
- `--variants a,b`: comma-separated variant IDs.
- `--out PATH`: explicit output directory.

The primary metric is nucleotide-weighted site-averaged normalized unrooted RF. See [results/BENCHMARK_REPORT.md](results/BENCHMARK_REPORT.md) for definitions, measured results, and interpretation caveats.

## Linked branch-length recovery

`branch-length-recovery.ts` isolates the new linked likelihood layer. It simulates two genomic regions from a genuine compiled one-SPR switching DAG under known shared atomic edge lengths and a fixed nonuniform GTR matrix, then refits the shared lengths. Recovery is scored with all pairwise patristic distances in every display, avoiding claims about reversible-root splits or atomic subdivisions that are only identifiable as a sum.

```bash
npm --workspace @phylo-workbench/model-jemspr run benchmark:branches
```

See [results/BRANCH_LENGTH_RECOVERY.md](results/BRANCH_LENGTH_RECOVERY.md) for the measured recovery table and [results/BRANCH_LENGTH_RECOVERY.json](results/BRANCH_LENGTH_RECOVERY.json) for all replicates.
