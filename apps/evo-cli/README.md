# evo-cli

`evo-cli` runs pipeline JSON exported by EvoOnline without a browser. The web app and CLI use the same schema-v1 component settings and defaults. Every compatible selection method × tree/recombination source route is executed independently, exactly as in the pipeline canvas.

## Download and run

Tagged GitHub releases contain one archive per supported platform:

- Linux x86-64 and ARM64
- macOS Intel and Apple silicon
- Windows x86-64

Extract the archive and keep its files together. Each archive contains `evo-cli`, a separate `FastTree` executable, FastTree's GPL license and corresponding source, this README, and the project third-party notices. No separate FastTree installation is required.

```sh
evo-cli run \
  --config my-pipeline.json \
  --input ./alignments-and-trees \
  --output ./evo-results \
  --cpus 8
```

Repeat `--input` for multiple files or directories. Simulator-first pipelines require no `--input`:

```sh
evo-cli run --config simulation-pipeline.json --output ./simulation-results
```

`--cpus N` is a hard logical-CPU budget. If it is omitted, `execution.maxCpus` from the pipeline JSON is used; otherwise the runner uses the CPUs available to the process. EvoOnline divides that budget across independent datasets/routes and each method's own worker pool. FastTree itself remains single-process, so FSART/MosaicSPR tree fits are parallelized as independent jobs instead of modifying FastTree. Use `--overwrite` only when intentionally writing into a non-empty output directory. `--fasttree /path/to/FastTree` overrides the bundled sibling executable for development or reproducibility checks.

## Commands

```text
evo-cli run --config PIPELINE.json --input PATH --output DIRECTORY
evo-cli run --config PIPELINE.json --output EXISTING_DIRECTORY --replot
evo-cli validate --config PIPELINE.json
evo-cli methods
evo-cli version
evo-cli help
```

`validate` checks the schema, component contracts, and every source-to-selection route without running an analysis. `run` exits `0` when all routes succeed, `2` when usable outputs were produced but one or more routes failed or were skipped, and `1` for a fatal configuration/runtime error.

## Input matching

Alignment extensions are `.fa`, `.fas`, `.fasta`, `.fna`, `.ffn`, and `.aln`. Tree extensions are `.nwk`, `.newick`, `.tree`, `.tre`, `.nex`, and `.nexus`.

For a User trees component, matching is exact and case-insensitive after removing the final extension: `gene_1.fasta` matches `gene_1.nwk`. Before analysis begins, the CLI prints the complete match list and writes `tree-file-matches.csv`. Missing and ambiguous matches fail only the affected source route; their dependent routes are explicitly skipped.

## Outputs

`--output` is required. The directory contains:

```text
pipeline.json
input-manifest.csv
tree-file-matches.csv
datasets/<dataset>/input/alignment.fasta
datasets/<dataset>/sources/<source>/
datasets/<dataset>/analyses/<method>-via-<source>/results.csv
datasets/<dataset>/analyses/<method>-via-<source>/tables/site-results.csv
datasets/<dataset>/analyses/<method>-via-<source>/tables/branch-results.csv
datasets/<dataset>/analyses/<method>-via-<source>/plots/*.svg
datasets/<dataset>/truth/
comparisons/signals-long.csv
comparisons/signal-catalog.csv
comparisons/mega-table-sites.csv
comparisons/mega-table-branches.csv
comparisons/plots/<dataset>/*.svg
run-log.csv
run-manifest.json
replot-index.json
```

Dataset, source, and analysis directories use readable names (for example, `fubar-via-fasttree`) rather than component UUIDs. Each method directory includes a human-first `results.csv`, separate site/branch tables when relevant, a column index, the lossless `result.json`, method-reported CSV/TSV/JSON strings, every detected Newick tree with a SHA-256 index, and the exact input tree. FSART, MosaicSPR, JEMSPR, and simulator truth also export regional Newick files, coordinate indexes, and a portable recombination-tree bundle needed by downstream methods.

The standard tables retain every scalar quantity reported by a method and add threshold-dependent calls plus derived rate summaries such as posterior mean dN, posterior mean dS, rate ratios, `log(dN)-log(dS)`, its exponential, posterior expected log-rate differences, and geometric rate ratios whenever posterior information permits them. Method plot folders contain standard site/branch profiles. FUBAR additionally writes separate positive-only and positive-plus-purifying posterior violin plots; DifFUBAR writes its detected-site posterior violin plot. Comparison output includes the selected metric for every method in sites-by-results, correlation, threshold-agreement, and cross-method scatter plots. `signal-catalog.csv` records the active threshold and call direction for every metric.

## Replot without rerunning analyses

Edit only the top-level `visualization` section of a copy of the pipeline config, then point `--replot` at the existing output directory:

```sh
evo-cli run \
  --config my-pipeline-replot.json \
  --output ./evo-results \
  --replot
```

Example visualization overrides:

```json
{
  "visualization": {
    "methods": {
      "fubar": {
        "positivePosteriorThreshold": 0.99,
        "purifyingPosteriorThreshold": 0.95,
        "siteMetric": "posterior-mean-dn",
        "maxSitesPerPlot": 200
      },
      "diffubar": { "posteriorThreshold": 0.975 },
      "bsrel": { "significanceThreshold": 0.01 }
    },
    "nodes": {
      "a-specific-component-id": { "siteMetric": "posterior-mean-ds" }
    }
  }
}
```

`--replot` refuses input paths, FastTree overrides, CPU flags, overwrite mode, or any changed component/method parameter. It reloads the persisted structured results referenced by `replot-index.json`, rewrites standard tables and plots, and records `analysisMethodsRerun: 0` in `replot-manifest.json`. Thus threshold calls and plots can be changed while simulation, tree inference, recombination detection, and selection fitting remain untouched.

## FastTree licensing boundary

FastTree remains an unmodified, separately executed program. It is distributed beside, not linked into, `evo-cli`, and communication occurs through normal standard input/output and files. The release archive includes FastTree's license and exact corresponding source. FastTree remains GPL-covered; EvoOnline's separate and independent code keeps its own license. See the root `THIRD_PARTY_NOTICES.md` for the pinned revision and checksums. This is a packaging/compliance description, not legal advice.

## Development

From the repository root:

```sh
npm ci
npm run build:shared
npm run build:models
npm run typecheck --workspace @phylo-workbench/evo-cli
npm run test --workspace @phylo-workbench/evo-cli
npm run evo-cli -- help
```

Create a host-platform standalone `evo-cli` executable with Bun:

```sh
npm run build:evo-cli:standalone
```

The GitHub release workflow follows the same Bun standalone-binary pattern used by MurrellGroup/swig, then compiles the pinned FastTree source separately and packages both executables together.
