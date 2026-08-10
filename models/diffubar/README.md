# difFUBAR WebGPU

Browser-native difFUBAR with a custom 61-state WebGPU pruning kernel and an optimized f64 WebAssembly fallback. FASTA and tagged Newick/NEXUS data stay in the browser.

This is an independent TypeScript/AssemblyScript implementation of the model in the [difFUBAR preprint](https://www.biorxiv.org/content/10.1101/2025.05.19.654647v1) and the reference [CodonMolecularEvolution.jl implementation](https://github.com/MurrellGroup/CodonMolecularEvolution.jl). It does not embed Julia.

## Current status

- The default foreground/background grids, category ordering, MG94-F3x4 construction, tree-tag semantics, conditional likelihood scaling, uncollapsed Gibbs transition, and eight-column CSV output match the Julia design.
- The WebGPU likelihood path is a purpose-built WGSL compute kernel. One 64-lane workgroup evaluates one `(site, grid category)` pair; lanes 0–60 own codon states.
- The WASM path uses f64 SIMD, adaptive sparse uniformization, 16-site cache blocks, Sethi–Ullman tree registers, and a hierarchical dependency cache that reuses subtrees across omitted grid axes.
- A persistent worker pool partitions sites across CPU cores. The WASM module is compiled once and shared with the workers.
- The default `fast-exact` Gibbs kernel uses exact rejection sampling instead of scanning all grid categories. `reference` retains the dense Julia-style transition for auditing, and `collapsed` is an optional alternative kernel targeting the same posterior.
- Browser work runs in a dedicated worker, so the UI remains responsive and cancellation terminates CPU work immediately.

WGSL compilation has been validated with Dawn. The supplied real-adapter parity runner skips cleanly when no adapter exists; this development environment had no Vulkan/Metal/D3D adapter, so end-to-end GPU execution still needs to be run on GPU hardware.

See [Parity and validation](docs/PARITY.md) before treating results as interchangeable with a particular Julia run.

## Monorepo usage

This engine is a model package in EvoOnline. From the repository root:

```bash
npm install
npm run dev
```

The workbench accepts an aligned codon FASTA and a tree containing exactly two foreground branch tags. NEXUS trees containing FigTree `&!color` annotations are converted to explicit G1/G2 tags before opening the branch tagger.

Build the model library, WASM module, API, and static workbench together with `npm run build`. To build only this package:

```bash
npm run build --workspace @phylo-workbench/model-diffubar
```

The ESM library and CLI-compatible model files are written to this package's `dist/`; the deployable browser application is written to `apps/web/dist/`.

## CLI

```bash
node dist/cli.js \
  --fasta alignment.fasta \
  --tree tagged-tree.nex \
  --output posteriors.csv \
  --backend auto \
  --iterations 2500
```

Useful switches:

- `--backend auto|wasm-parallel|wasm|webgpu`
- `--foreground-grid 6 --background-grid 4`
- `--reference-fit` for the slower optimizer-compatible global fit
- `--strict-sampler` to disable conditional-likelihood pruning
- `--reference-sampler` to force the dense Julia-style categorical scan
- `--save-fitted-model fit.json` and `--fitted-model fit.json` to reuse the exact downstream model
- `--seed`, `--burnin`, and `--threshold`

The Node CLI normally uses WASM because Node does not expose browser WebGPU. `scripts/webgpu-parity.ts` shows how to install Dawn's `navigator.gpu` implementation for hardware testing.

## Library API

```ts
import { analyzeDifFUBAR, resultsToCsv } from "@phylo-workbench/model-diffubar";

const result = await analyzeDifFUBAR(fastaText, taggedTreeText, {
  backend: "auto",
  foregroundGrid: 6,
  backgroundGrid: 4,
  iterations: 2_500,
  samplerMode: "fast-exact", // exact uncollapsed kernel, faster transition
  likelihoodCutoff: 0,       // do not prune any conditional likelihood
  collectPosteriorMarginals: true, // compact data for the paper figures
  seed: 1234,
});

console.log(result.detectedSites);
console.log(resultsToCsv(result));
```

Pass `fittedModel` to bypass optimizer differences and compare the likelihood grid/sampler against an externally fitted model. The CLI can save and reload this object as JSON.

`collectPosteriorMarginals` temporarily records the same category-by-site allocation counts used by the Julia postprocessor, collapses them to α/ω grid masses, and returns compact `Float32Array` marginals. It does not retain or return the full allocation grid.

## Input conventions

- FASTA sequences must be aligned and their nucleotide length must be divisible by three.
- Tree tip names must match FASTA names after `{tag}` text is removed.
- Exactly two tags are compared. Untagged non-root edges form an optional background class.
- Tags are sorted before class assignment, matching the reference implementation's group ordering.
- Universal-code stop or ambiguous codons are treated as missing states, matching the reference `CodonPartition` behavior used by difFUBAR.
- The current build supports the universal genetic code only.

Example tagged Newick:

```text
((a{G1}:0.05,b{G1}:0.06){G1}:0.04,
 (c{G2}:0.05,d{G2}:0.06){G2}:0.04,
 background_taxon:0.1);
```

## Performance

`npm run bench` runs a deterministic 8-taxon, 48-codon, 1,296-category single-worker f64 benchmark. In this container it measured:

| Stage | Time |
|---|---:|
| Conditional grid | 0.611 s |
| 250 Gibbs iterations | 0.023 s |
| Total | 0.649 s |

For the upstream `Ace2_reallytiny` data (8 taxa, 74 codons, background class, 12,096 categories), using the exact same Julia-fitted model and excluding compilation/startup:

| Implementation | Grid | 2,500-iteration sampler | Grid + sampler |
|---|---:|---:|---:|
| Julia default heuristic | 9.306 s | 3.554 s | 12.860 s |
| Julia forced tree-surgery + 9 threads | 1.380 s | 3.554 s | 4.934 s |
| This implementation, adaptive f64 + 9 workers | 2.405 s | 1.724 s | 4.129 s |

The current warmed downstream path is therefore about 3.11× faster than Julia's default and about 1.20× faster than the fastest manually forced Julia combination on this case. A complete cold run that also performed the local empirical fit took 4.448 s (0.390 s fit, 2.347 s grid, 1.677 s sampler); the Julia-compatible fitted-model comparison above is the cleaner parity benchmark. Timings vary with host scheduling; they are measurements, not universal device claims.

The normalized f64 likelihood matrix matched Julia with RMS absolute error `9.46e-14` and maximum absolute error `3.10e-12`. The previous single-worker fixed-truncation build took 43.82 s on the same grid; the current warmed single-worker adaptive/SIMD build takes 8.52 s.

Use `npm run bench -- --full` for the default grid and 2,500 iterations. Use `npm run parity:webgpu` on a machine with a Dawn-compatible adapter to measure GPU numerical parity; add device-specific timing after parity passes.

## Validation commands

```bash
npm run typecheck
npm test
python3 scripts/scipy-reference-check.py
npm run validate:wgsl
npm run parity:webgpu
npm run bench
```

To compare directly with Julia, generate TSV fixtures in an environment containing the reference package, then run the TypeScript comparator:

```bash
julia --project=/path/to/CodonMolecularEvolution.jl \
  scripts/generate-julia-reference.jl alignment.fasta tree.nex /tmp/diffubar-ref 2 2

npm run parity:julia -- \
  --fasta alignment.fasta --tree tree.nex --prefix /tmp/diffubar-ref \
  --foreground-grid 2 --background-grid 2
```

## Design documents

- [Architecture and memory model](docs/ARCHITECTURE.md)
- [Parity, validation, and known differences](docs/PARITY.md)
- [GPU handoff checklist](docs/GPU_HANDOFF.md)

## License

MIT. See [LICENSE](LICENSE).
