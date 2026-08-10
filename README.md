# EvoOnline

An extensible phylogenetic analysis workbench with a static browser application, a shared artifact/model SDK, an optional job API, and independently packaged model runners. DifFUBAR is the first registered model.

The browser workflow currently supports:

1. Uploading an aligned FASTA file.
2. Inspecting, editing, realigning, or frame-cleaning it in **alivibe**.
3. Uploading a Newick/NEXUS tree or inferring one with bioWASM FastTree directly from the main workflow.
4. Viewing and tagging G1/G2 foreground branches in **phylotagger**.
5. Validating alignment/tree/tip-name/tag compatibility.
6. Running DifFUBAR in a dedicated browser worker with WebGPU or exact parallel WASM.
7. Exploring all three paper figures as linked interactive SVGs, editing publication labels, and exporting lossless SVG or CSV.

Sequence and tree data remain device-local when using the browser executor.

## Repository layout

```text
apps/
  web/                  Static Vite/React workbench
  api/                  Optional model-agnostic jobs API
packages/
  domain/               Immutable alignment/tree artifacts
  model-sdk/            Model manifests, validation and job contracts
  viewer-bridge/        Typed postMessage adapter for embedded tools
models/
  diffubar/             Numerical core, WASM, WebGPU and model plugin
docs/
  ARCHITECTURE.md
  ADDING_A_MODEL.md
  WEBWIDGETS.md
```

Repository boundaries are deliberately independent of deployment boundaries. Each model can publish its own native container and browser bundle while sharing the monorepo, SDK, validation, and CI.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

The web application is served by Vite. The two WebWidgets are vendored under `apps/web/public/widgets`; alivibe loads Aioli from bioWASM when Kalign or FastTree is initialized.

Run the optional API in another terminal:

```bash
npm run build
npm run dev:api
```

## Validation

```bash
npm run typecheck
npm test
npm run build
```

The DifFUBAR package retains its Julia/SciPy parity scripts, benchmark, WGSL validation, and exact WASM tests under `models/diffubar`.

## DifFUBAR figure studio

The result renderer reproduces the upstream Julia plotting encodings: the transformed site-wise ω overview, collapsed α/ω grid posteriors for detected codons, and the four-test posterior evidence matrix. In the grid-posterior view, every codon gets a green α mass lane above the site center and overlapping red/blue G1/G2 ω mass lanes below it; each grid-bin rectangle's thickness is the corresponding marginal posterior probability, using the Julia `±0.1` lane offsets and `0.35` mass scale. The posterior threshold, codon window, and row limit are interactive; clicking a codon links selection across figures. Titles, axes, α, G1, and G2 labels are editable, and every view serializes directly from its live SVG without rasterization.

Long computations report real inner-loop telemetry where it exists: optimizer pass/iteration counts, current log likelihood, and completed likelihood sites. Fused WebGPU/WASM kernels that cannot yield safely mid-call use an animated indeterminate state with the exact work dimensions instead of displaying a frozen pseudo-percentage.

For memory efficiency, the model collapses the sampler's temporary category-by-site allocation counts into three site-major `Float32Array` marginals before the result crosses the worker boundary. The full likelihood or allocation grid is never cloned into React.

## Static deployment

`npm run build` writes the static site to `apps/web/dist`. Upload that directory to any HTTPS static host. A GitHub Pages workflow is included at `.github/workflows/pages.yml`; Vite uses relative asset URLs so repository subpaths work without editing the repository name.

## Add another analysis method

Create `models/<id>`, export a `ModelPlugin`, and register it in the web and server registries. The manifest declares input slots, parameter controls, supported runtimes, and output kinds. See [Adding a model](docs/ADDING_A_MODEL.md).

## Third-party code

The embedded alivibe and phylotagger tools are derived from MurrellGroup/WebWidgets under the MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
