# EvoOnline

An extensible phylogenetic analysis workbench with a static browser application, a shared artifact/model SDK, an optional job API, and independently packaged model runners. DifFUBAR, regular FUBAR, fixed-complexity BS-REL, and the experimental FAME and FLAVOR branch-mixture models are currently registered.

The browser workflow currently supports:

1. Uploading an aligned FASTA file.
2. Inspecting, editing, realigning, or frame-cleaning it in **alivibe**.
3. Uploading a Newick/NEXUS tree or inferring one with bioWASM FastTree directly from the main workflow.
4. Viewing a tree, and tagging G1/G2 foreground branches when DifFUBAR requires them, in **phylotagger**.
5. Validating each method's alignment/tree/tip-name/tag requirements.
6. Running DifFUBAR, FUBAR, fixed three-rate BS-REL, FAME, or FLAVOR in a dedicated browser worker. Exact parallel WASM is the default; DifFUBAR and regular FUBAR also retain selectable WebGPU.
7. Choosing deterministic Dirichlet-EM or exact Gibbs inference for FUBAR, FAME, and FLAVOR.
8. Optionally deriving separate approximate-FEL likelihood-ratio tests from the already-computed FUBAR grid.
9. Exploring model-owned, linked interactive SVG figures, editing publication labels, and exporting lossless SVG or CSV.
10. Profile-aligning the translated codon alignment to an uploaded PDB/mmCIF structure or an RCSB PDB entry, then exploring residue-level selection calls in a simplified Mol* view.

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
  fubar/                Regular FUBAR grid, inference and model plugin
  bsrel/                Fixed three-rate branch-wise test and message optimizer
  bame/                 Experimental FAME/FLAVOR branch-mixture models
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

The DifFUBAR package retains its Julia/SciPy parity scripts, benchmark, WGSL validation, and exact WASM tests under `models/diffubar`. Regular FUBAR adds exact grid-transform, analytical Dirichlet-EM, Gibbs-allocation, posterior-product, ordinary-tree, exact-spline, known-optimum, and directional-LRT tests under `models/fubar`. BS-REL tests the all-to-all message identity directly: a local edge replacement must match a complete tree re-prune in f64, including in the site-parallel worker pool. FAME/FLAVOR tests pin the development-branch grid dimensions, extreme Gamma quantiles, quadrature moments, sparse/dense kernel equivalence, the exact latent branch-state expansion of a mixed transition operator, and FLAVOR interpolation parity at every lookup-table node.

## DifFUBAR figure studio

The result renderer reproduces the upstream Julia plotting encodings: the transformed site-wise ω overview, collapsed α/ω grid posteriors for detected codons, and the four-test posterior evidence matrix. In the grid-posterior view, every codon gets a green α mass lane above the site center and overlapping red/blue G1/G2 ω mass lanes below it; each grid-bin rectangle's thickness is the corresponding marginal posterior probability, using the Julia `±0.1` lane offsets and `0.35` mass scale. This panel deliberately retains a narrow portrait canvas with 80%-width categorical bars, because stretching it across the result card makes the marginal shapes unreadable. The posterior threshold, codon window, and row limit are interactive; clicking a codon links selection across figures. Titles, axes, α, G1, and G2 labels are editable, and every view serializes directly from its live SVG without rasterization.

Long computations report real inner-loop telemetry where it exists: optimizer pass/iteration counts, current log likelihood, and completed likelihood sites. Runtime setup is a separate visible stage: EvoOnline says when it is fetching/compiling/instantiating WASM, starting the worker pool, or compiling WGSL. Fused WebGPU/WASM kernels that cannot yield safely mid-call retain a moving activity indicator and an updating elapsed-time counter with the exact work dimensions instead of displaying a frozen pseudo-percentage. Percentages are explicitly phase-local.

For memory efficiency, the model collapses the sampler's temporary category-by-site allocation counts into three site-major `Float32Array` marginals before the result crosses the worker boundary. The full likelihood or allocation grid is never cloned into React.

## FUBAR figure studio

Regular FUBAR shares DifFUBAR's fitted MG94 model and optimized likelihood kernels, but evaluates the exact CodonMolecularEvolution.jl 20 × 20 α–β grid on a single untagged branch class. Dirichlet-EM is deterministic and remains the default. The optional exact uncollapsed Gibbs sampler uses fused WASM rejection draws, a reproducible seed and configurable burn-in; retained category allocations are collapsed into the same site posterior surfaces and marginals.

The result renderer highlights both positive selection, P(β > α), and purifying selection, P(α > β). Positive and purifying visibility checkboxes are enabled by default and jointly filter the table, overview, marginal rows, posterior-surface choices, and structural detection calls. The studio provides the codon overview, paper-style α/β posterior-mass lanes at detected sites, an interactive posterior surface for any linked site, editable labels, and direct SVG/CSV export.

**Also calculate approximate FEL** is an opt-in FUBAR checkbox and is off by default. It reuses each site's raw conditional likelihood grid before the Bayesian prior or mixture weights are applied; disabling it executes no FEL interpolation or optimization. Max-shifted log likelihoods are interpolated in the uniform FUBAR grid-index coordinate by a nodal-exact local bicubic surface; a deterministic local-curvature audit reduces cubic tension only when needed. Multi-start optimization finds the unrestricted surface maximum and the maximum on α=β, then reports the χ²(1) LRT plus separate signed-root positive and purifying p-values. Its controls, table, CSV, thresholds, conditional-likelihood SVG, and measured compute time are contained in a visibly separate result panel, so enabling it does not add columns to or alter the FUBAR posterior result.

## Fixed-complexity BS-REL

BS-REL is the original fixed three-rate branch-site random-effects construction, not aBS-REL: every branch always has ordered `ω− ≤ ωN ≤ 1 ≤ ω+` classes and three fitted weights. There is no AIC/AICc model-complexity selection. EvoOnline performs one joint L-BFGS optimization over all branch mixtures and branch-length multipliers. A custom SIMD WASM kernel marginalizes each three-class branch into one mixed Markov operator and evaluates codon sites across persistent workers.

Each gradient pass performs one Felsenstein up-pass and one reversible down-pass to retain the two directed messages around every edge. A one-parameter branch perturbation then recomputes only the changed component and contracts it with that local blanket; unchanged rate components are reused. Whole-tree line-search calls omit the down-pass. After the universal alternative is fitted, every requested null fixes that branch's `ω+ = 1` and all nulls are re-optimized concurrently against their fixed two-sided boundary messages. The test uses the calibrated fixed three-rate mixture `0.50 χ²₀ + 0.05 χ²₁ + 0.45 χ²₂`, followed by Holm–Bonferroni across the requested branches.

Results include the three ω values and weights, mean ω, fitted branch length, LRT, raw p-value, and Holm p-value. The linked phylogram uses fitted branch lengths for geometry and can color edges by Holm evidence, LRT, positive ω, positive-class fraction, mean ω, or fitted length. Tip/internal labels, branch annotations, line widths, dimensions, and title are adjustable; selecting an edge links to the table and the complete live tree exports as SVG.

## Experimental FAME and FLAVOR

FAME and FLAVOR are pinned ports of the early-development [`MixtureModels`](https://github.com/MurrellGroup/CodonMolecularEvolution.jl/tree/MixtureModels) branch at commit `4c65c984b2e7ad121f5e28298de69bdc0dd427b7`. FAME assigns every branch a convex mixture of two MG94 transition operators, with ω₁ constrained to the purifying/neutral grid and ω₂ allowed above one. The recommended mode integrates the shared mixture weight in the likelihood domain with Gauss–Legendre quadrature. A separate **Julia draft compatibility** option exactly reproduces the source's arithmetic average of site log likelihoods over 20 weights; that formula is a geometric likelihood average, not ordinary likelihood marginalization.

FLAVOR gives every branch an ω drawn from a mid-quantile discrete Gamma distribution and contrasts uncapped categories against distributions capped at ω=1. The browser default uses 12 Gamma slices. It preserves the source model's repeated capped outer categories, because removing them would change its learned category prior, while combining repeated ω=1 components exactly inside each transition operator. FLAVOR now defaults to Julia's 50-node, `t=0.001`, cap-35 `matrix_sequence` recurrence and element-wise interpolation. Each capped/μ/shape transition table is built once and reused over its complete α block, all branches, and all sites; direct uniformization remains an advanced accuracy-reference option. FAME remains on direct uniformization because its pinned Julia implementation does not use this interpolation scheme. Both methods use Dirichlet-EM by default and offer exact Gibbs allocation sampling.

The interactive defaults use transformed 512-category FAME and 896-category FLAVOR grids; the exact 3,375/6,720-category development grids remain selectable for source reproduction and are substantially slower. Category-parallel f64 WASM keeps complete FLAVOR α blocks together and never materializes an operator-by-site expansion. On the bundled demo, the committed transition benchmark measures about a 15.5× FLAVOR likelihood-stage speedup over direct uniformization in this environment. Result studios provide linked site evidence, empirical Bayes factors, paper-style parameter probability-mass lanes, editable/exportable posterior projections, and for FLAVOR a posterior-predictive branch-ω CDF. These methods remain explicitly labelled experimental.

## Selection-on-profile result maps

The site-model results include an optional selection-on-profile studio after the main posterior table. It works immediately with no reference: the translated raw-frequency amino-acid profile, selected hypothesis lanes, detection labels, controls, and SVG export use the original alignment codon numbers. A reference is genuinely optional. If supplied, one protein FASTA/plain sequence or coding-nucleotide reference is translated when necessary and globally aligned to the complete profile with expected BLOSUM62 scores and affine gaps in a dedicated worker. Removing it returns the same figure to alignment-numbering mode. Unlike the local structure-chain mapper, the global traceback retains profile-only and reference-only insertions, including terminal overhangs.

When present, the pure reference row is drawn above the raw-frequency amino-acid profile with the same normalized vector glyphs and all annotations switch to reference coordinates. DifFUBAR exposes independent lanes for P(ω·G1>ω·G2), P(ω·G2>ω·G1), P(ω·G1>1), and P(ω·G2>1); FUBAR exposes P(β>α) and P(α>β). Any combination can be shown. Every detection is labeled in a separate collision-free lane. In reference mode, profile insertions do not advance the reference number and instead receive spreadsheet-style suffixes (`76A`, `76B`, `76C`, …); reference-only residues remain visible as profile gaps. Threshold, codon window, reference start, horizontal scale, row heights, number size, ticks, guide lines, match highlighting, labels, and colors are editable, and the complete live figure exports directly to SVG.

## Structure mapping

The site-model result renderers expose an optional, isolated structure-mapping panel. It translates every sequence at each aligned codon, builds an amino-acid frequency profile, and runs a BLOSUM62-scored affine-gap local profile alignment against every coordinate-bearing protein chain in a PDB or mmCIF file. Sequence-identical chains reuse one dynamic-programming pass. Every credible match is mapped by default—so distinct polyprotein segments and sequence-identical oligomer chains all receive results—while short spurious local hits remain hidden. Credibility combines mapped span, BLOSUM score, exact/positive match content, coverage of either the input profile or the structure chain, gap burden, and longest contiguous positive-scoring run. Auto-mapped chains default to surface-only at 100% opacity. Every chain still has independent **Show** and **Map results** checkboxes: mapped chains receive site colors, context chains remain visible but neutral, and hidden chains are omitted. Identity, both coverage directions, clean-run length, score, full traceback alignments, and all alternatives remain visible for validation. Parsing and alignment run in a dedicated worker.

Every mapped chain also gets a compact profile-to-chain sequence view directly above Mol*. Its WebLogo-like stacks use raw amino-acid frequency across all input sequences—not information content or entropy normalization—so stack height equals non-gap, unambiguous occupancy and empty height represents missing sequence mass. The PDB chain is rendered with the same glyph grammar as a pure one-residue alignment. Normalized vector outlines make mixed and pure stacks occupy exactly the same vertical envelope; the optional difference highlighter fades profile residues matching the structure chain. Each complete local alignment uses native horizontal scrolling, while a horizontal-scale slider changes only residue width. Explicit traceback indices preserve chain insertions and profile gaps.

Every structure chain independently selects cartoon, atoms, and surface representations, regardless of whether the chain is mapped or retained as neutral context. Surface opacity is stored per chain; moving the compact global opacity slider explicitly overrides every chain until **Use per-chain** is selected, without discarding the individual values. Structure-source, summary, coloring, chain-selector, alignment, text-alignment, and 3D-view panels are collapsible and expanded by default. Model-appropriate coloring includes categorical detection/direction, signed posterior evidence, posterior-mean rate ratios, or individual inferred rates. Every color mode follows the live analysis posterior threshold by default: sites below it are neutral. A compact **Color detected sites only** checkbox can be switched off when the user wants continuous posterior/Bayes-factor/effect values across every mapped codon. Mol* 5.11.0 is pinned and lazy-loaded from jsDelivr only after at least one chain is shown, so it adds no bytes to EvoOnline's initial application bundle. Uploaded coordinates and all sequence/profile computations stay local; entering a PDB ID fetches that public mmCIF directly from RCSB.

## Static deployment

`npm run build` writes the static site to `apps/web/dist`. Upload that directory to any HTTPS static host. A GitHub Pages workflow is included at `.github/workflows/pages.yml`; Vite uses relative asset URLs so repository subpaths work without editing the repository name.

## Add another analysis method

Create `models/<id>`, export a `ModelPlugin`, and register it in the web and server registries. The manifest declares input slots, parameter controls, supported runtimes, and output kinds. See [Adding a model](docs/ADDING_A_MODEL.md).

## Third-party code

The embedded alivibe and phylotagger tools are derived from MurrellGroup/WebWidgets under the MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
