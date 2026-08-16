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
  --output ./evo-results
```

Repeat `--input` for multiple files or directories. Simulator-first pipelines require no `--input`:

```sh
evo-cli run --config simulation-pipeline.json --output ./simulation-results
```

Use `--overwrite` only when intentionally writing into a non-empty output directory. `--fasttree /path/to/FastTree` overrides the bundled sibling executable for development or reproducibility checks.

## Commands

```text
evo-cli run --config PIPELINE.json --input PATH --output DIRECTORY
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
datasets/<dataset>/analyses/<method>-via-<source>/
datasets/<dataset>/truth/
comparisons/signals-long.csv
comparisons/signal-catalog.csv
comparisons/mega-table-sites.csv
comparisons/mega-table-branches.csv
comparisons/plots/<dataset>/*.svg
run-log.csv
run-manifest.json
```

Each method directory includes the lossless `result.json`, method-reported CSV/TSV/JSON strings, additional CSV tables recovered from structured result arrays, every detected Newick tree with a SHA-256 index, and the exact input tree. FSART, MosaicSPR, JEMSPR, and simulator truth also export regional Newick files, coordinate indexes, and a portable recombination-tree bundle needed by downstream methods.

The comparison export includes reported site/branch quantities plus derived rate summaries such as posterior mean dN, posterior mean dS, rate ratios, `log(dN)-log(dS)`, and its exponential whenever the method exposes enough posterior information. SVG output includes sites-by-results, correlation and threshold-agreement matrices, a cross-method scatter, and FUBAR selection/rate profiles. `signal-catalog.csv` records the selected default threshold and call direction for every metric.

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
