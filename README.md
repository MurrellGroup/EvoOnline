# EvoOnline

An extensible phylogenetic analysis workbench with a static browser application, a shared artifact/model SDK, an optional job API, and independently packaged model runners. DifFUBAR, regular FUBAR, fixed-complexity BS-REL, the experimental FAME/FLAVOR models, the exploratory Glamma and CladeShift scans, and three separate recombination methods—FSART, MosaicSPR, and JEMSPR—are currently registered.

The browser workflow currently supports:

1. Uploading an aligned FASTA file.
2. Inspecting, editing, realigning, or frame-cleaning it in **alivibe**.
3. Uploading a Newick/NEXUS tree or inferring one with bioWASM FastTree directly from the main workflow.
4. Viewing a tree, and tagging G1/G2 foreground branches when DifFUBAR requires them, in **phylotagger**.
5. Validating each method's alignment/tree/tip-name/tag requirements.
6. Selecting one of 24 unambiguous current NCBI genetic codes for any analysis.
7. Running DifFUBAR, FUBAR, fixed three-rate BS-REL, FAME, FLAVOR, Glamma, CladeShift, FSART, MosaicSPR, or JEMSPR in dedicated browser workers. Exact parallel WASM is the default for selection models; DifFUBAR and regular FUBAR also retain selectable WebGPU. FSART and MosaicSPR reuse the existing FastTree bioWASM runtime. JEMSPR is independently alignment-only and internally infers its neighbor-joining guides, rooted master, local trees, breakpoints, and coherent event network.
8. Choosing deterministic Dirichlet-EM or exact Gibbs inference for FUBAR, FAME, and FLAVOR.
9. Optionally deriving separate approximate-FEL likelihood-ratio tests from the already-computed FUBAR grid.
10. Exploring model-owned, linked interactive SVG figures, editing publication labels, and exporting lossless SVG or CSV.
11. Profile-aligning the translated codon alignment to an uploaded PDB/mmCIF structure or an RCSB PDB entry, then exploring residue-level selection calls in a simplified Mol* view.

Sequence and tree data remain device-local when using the browser executor.

The selected NCBI translation table is part of the fitted model, not merely a display preference: it controls stop/sense states, synonymous versus nonsynonymous edges, equilibrium normalization, likelihood dimensions, and every downstream amino-acid translation. See [supported genetic codes](docs/GENETIC_CODES.md).

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
  bame/                 FAME/FLAVOR plus the exploratory Glamma scan
  cladeshift/           Exploratory untagged persistent clade-shift scan
  fsart/                Informative-triplet recombination scan and topology HMM
  mosaicspr/            Unknown-master explicit multi-SPR mosaic reconstruction
  jemspr/               Joint rooted-master and overlapping switching-network inference
docs/
  ARCHITECTURE.md
  ADDING_A_MODEL.md
  GENETIC_CODES.md
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

The DifFUBAR package retains its Julia/SciPy parity scripts, benchmark, WGSL validation, and exact WASM tests under `models/diffubar`. Regular FUBAR adds exact grid-transform, analytical Dirichlet-EM, Gibbs-allocation, posterior-product, ordinary-tree, exact-spline, known-optimum, and directional-LRT tests under `models/fubar`. BS-REL tests the all-to-all message identity directly: a local edge replacement must match a complete tree re-prune in f64, including in the site-parallel worker pool. FAME/FLAVOR tests pin the development-branch grid dimensions, extreme Gamma quantiles, quadrature moments, sparse/dense kernel equivalence, the exact latent branch-state expansion of a mixed transition operator, and FLAVOR interpolation parity at every lookup-table node. Glamma tests additionally enumerate all branchwise ω assignments inside each site-level α category and require the optimized message kernel to match the explicit alternative, capped-edge likelihood, and positive-tail numerator. CladeShift tests its fixed-prior integration and requires each all-clade message contraction to equal a complete two-class reprune for both internal and terminal change points at f64 precision. FSART tests pair-covered triplet sampling, canonical informative-event classification, planted topology-switch recovery, forward–backward interval/rate normalization, hard-spaced consensus aggregation, segment/pair/triplet/global tree-family construction, cached rapid subset search, Viterbi decoding, unresolved-tree rejection, and adjacent-tree split differences. MosaicSPR separately tests complete one-SPR neighborhood enumeration, executable forward/inverse edits, a planted two-SPR breakpoint script, free master-tree revision, and Newick root-label invariance. JEMSPR tests ambiguity-aware genomic cells, exact rooted-SPR compilation, preservation of all taxa under every switch mask, hierarchical two-event overlap, and end-to-end recovery of a planted mosaic without any external tree or breakpoint input.

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

Each gradient pass performs one Felsenstein up-pass and one reversible down-pass to retain the two directed messages around every edge. A one-parameter branch perturbation then recomputes only the changed component and contracts it with that local blanket; unchanged rate components are reused. Whole-tree line-search calls omit the down-pass. After the global alternative is fitted, every requested null fixes that branch's `ω+ = 1` and all nulls are re-optimized concurrently against their fixed two-sided boundary messages. The test uses the calibrated fixed three-rate mixture `0.50 χ²₀ + 0.05 χ²₁ + 0.45 χ²₂`, followed by Holm–Bonferroni across the requested branches.

Results include the three ω values and weights, mean ω, fitted branch length, LRT, raw p-value, and Holm p-value. The linked phylogram uses fitted branch lengths for geometry and can color edges by Holm evidence, LRT, positive ω, positive-class fraction, mean ω, or fitted length. Tip/internal labels, branch annotations, line widths, dimensions, and title are adjustable; selecting an edge links to the table and the complete live tree exports as SVG.

## Experimental FAME and FLAVOR

FAME and FLAVOR are pinned ports of the early-development [`MixtureModels`](https://github.com/MurrellGroup/CodonMolecularEvolution.jl/tree/MixtureModels) branch at commit `4c65c984b2e7ad121f5e28298de69bdc0dd427b7`. FAME assigns every branch a convex mixture of two MG94 transition operators, with ω₁ constrained to the purifying/neutral grid and ω₂ allowed above one. The recommended mode integrates the shared mixture weight in the likelihood domain with Gauss–Legendre quadrature. A separate **Julia draft compatibility** option exactly reproduces the source's arithmetic average of site log likelihoods over 20 weights; that formula is a geometric likelihood average, not ordinary likelihood marginalization.

FLAVOR gives every branch an ω drawn from a mid-quantile discrete Gamma distribution and contrasts uncapped categories against distributions capped at ω=1. The browser default uses 12 Gamma slices. It preserves the source model's repeated capped outer categories, because removing them would change its learned category prior, while combining repeated ω=1 components exactly inside each transition operator. FLAVOR now defaults to Julia's 50-node, `t=0.001`, cap-35 `matrix_sequence` recurrence and element-wise interpolation. Each capped/μ/shape transition table is built once and reused over its complete α block, all branches, and all sites; direct uniformization remains an advanced accuracy-reference option. FAME remains on direct uniformization because its pinned Julia implementation does not use this interpolation scheme. Both methods use Dirichlet-EM by default and offer exact Gibbs allocation sampling.

The interactive defaults use transformed 512-category FAME and 896-category FLAVOR grids; the exact 3,375/6,720-category development grids remain selectable for source reproduction and are substantially slower. Category-parallel f64 WASM keeps complete FLAVOR α blocks together and never materializes an operator-by-site expansion. On the bundled demo, the committed transition benchmark measures about a 15.5× FLAVOR likelihood-stage speedup over direct uniformization in this environment. Result studios provide linked site evidence, empirical Bayes factors, paper-style parameter probability-mass lanes, editable/exportable posterior projections, and for FLAVOR a posterior-predictive branch-ω CDF. These methods remain explicitly labelled experimental.

## Glamma

This model fits one Gamma distribution for ω globally across branch–site cells and an independent mean-one Gamma distribution for synonymous rate α across sites. The likelihood hierarchy is deliberate: for a fixed α category, the same α applies to every branch at that site while every branch independently marginalizes the weighted ω categories; only complete-tree site likelihoods are then averaged over α. A threshold-aware ω quadrature preserves the continuous Gamma mass above and below ω=1, while conditional-mean α categories have an exact discrete mean of one. The interactive fit uses a 64-point logarithmic parameter design followed by two local refinements; the thorough preset retains a dense 1,100-point starting scan. Julia-style transition interpolation is used during fitting, while final evidence uses direct f64 uniformization with branch lengths and nucleotide parameters fixed after the global codon fit.

The site contrast caps all ω>1 categories on every branch without re-optimization. One upward/downward message pass exposes every edge blanket, so the exact branch contrast—every site on just that branch capped—requires only a local contraction and is always reported. The same per-site capped-edge ratios feed a Beta-integrated branch activation empirical Bayes factor. Per branch/site positive-tail responsibilities color the phylogeny when a codon is selected and form an alignment track when a branch is selected. Results include linked editable SVG tree/site figures, two CSVs, branch and site tables, and the optional amino-acid profile/reference map. Literal branch-level P(any positive site) and its empirical-Bayes odds are reported alongside expected positive-site burden; the interface warns through its method description that “any” can saturate on long alignments.

## Exploratory CladeShift

CladeShift asks whether one unknown branch initiated a persistent codon-specific change in selective stringency across its descendant clade. It needs no foreground tags. The null is the ordinary whole-tree FUBAR α–β process; under a candidate change point, that edge and every descendant edge use `ω′ = ω^K`. Fixed `K < 1` states represent relaxation toward neutrality and fixed `K > 1` states represent intensification away from neutrality. Direction, K, and every eligible initiating branch are integrated under explicit priors rather than selected by an unpenalized maximum.

The computational trick turns an apparently branch-by-branch scan into two reusable message families. One null upward/downward pass supplies the outside context of every edge. For each K, one all-shifted upward pass supplies the shifted inside likelihood of every descendant subtree. Their local contractions score all candidate clades exactly for each retained baseline category. Baseline α–β uncertainty is integrated through `BF = E_q_null[L_shift/L_null]`; categories are retained adaptively in descending FUBAR posterior order until the requested mass target or hard cap is reached, and every site's actual captured mass is exposed as an approximation audit. Sites parallelize across the persistent f64 WASM pool.

The linked result studio separates relaxation and intensification, links codons to initiating-branch posterior colors on the tree, exposes the K posterior and branch burdens, exports two CSVs and editable SVGs, and connects to the optional reference/profile and structure mappers. This is a numerically tested but **not simulation-validated** method prototype: its posteriors are empirical-Bayes quantities, not calibrated p-values, and the interface labels that status prominently. The package is isolated under `models/cladeshift` so it can be removed without altering another model's contracts or results.

## FSART recombination screen

FSART—the Fast Stepwise Approximate Recombination Test—is alignment-only and remains isolated from every selection result. It uses canonical sites at which exactly one pair in a taxa triplet matches. A rolling 2 × 3 G statistic scans fixed informative-event windows with no logarithms in the hot loop. Thirty-two sites are classified at once from taxon/base bit planes; a bounded pair-equality cache accelerates ordinary inputs without allowing worker memory to grow quadratically on large ones, and a bounded peak heap prevents candidate memory from scaling with the number of triplet boundaries. Small taxa sets are exhaustive; large sets use a deterministic bounded triplet design that guarantees every taxon pair occurs at least once. Large inputs automatically use fewer workers to bound replicated matrix memory.

Strong triplets enter a fixed-emission three-state topology HMM. Event-run purity initializes emission fidelity once; a coarse log switching-rate grid is marginalized with scaled forward–backward passes and posterior switch filtering. There is no Baum–Welch. Because marginal switch probabilities can describe several changes, each candidate's interval is conditioned on the connected local HMM mode inside the scan window rather than normalized over the full alignment. A local consensus field combines the number of supporting triplets with compressed evidence strength, then weighted-interval optimization chooses a deliberately generous proposal list under a hard minimum segment length. The 150-nt default rises automatically on shallow alignments until a window is expected to contain at least `max(30, 2 × taxa)` variable sites. The Bonferroni value is retained only as an audit column and never gates candidate admission.

The browser reuses alivibe's existing FastTree 2.1.11 bioWASM runtime. Consensus cuts define atomic segments; EvoOnline fits a tree to each segment, every adjacent segment pair, every adjacent triplet, and the full alignment. Equivalent unrooted trees are deduplicated, a shared global GTR model is retained, and fixed-topology Gamma20 likelihoods are computed for all sites under the complete tree family. This moves the combinatorial part into cached emission space. An O(L×trees) reset-HMM uses a beam plus floating add/drop/swap search for the AIC, AICc (default), or BIC topology subset, then performs exact forward–backward and Viterbi inference. Viterbi-assigned ranges are concatenated to refit trees and the HMM is rerun for a few bounded rounds; topology/boundary convergence is recorded but not required.

The result studio provides linked consensus-proposal/interval, triplet topology/HMM, tree-family, topology-loading, Viterbi-run, convergence-audit, and split-discordance views. It preserves the conservative IC reconstruction and adds two instant post-analysis alternatives over the complete cached tree bank: a user-controlled low-switch/Viterbi-retention mode and a sparse symmetric-Dirichlet variational EM. Posterior curves and the Viterbi path update together without rerunning FastTree. Final runs can be selected individually, as a rerooted mirrored two-tree tanglegram, or all at once as jointly ordered same-direction trees with matching-taxon track changes; every view exports as SVG. This is an independent RDP-inspired, BURT-style, GARD-like approximation—not exact parity with any of those programs. Raw triplet p-values rank hypotheses but are not final tests; the two more sensitive alternatives are explicitly conditional on their data-derived draft tree family. See [`models/fsart`](models/fsart/README.md).

## MosaicSPR event reconstruction

MosaicSPR is a separate alignment-only method, not an FSART result layer. Its optional proposal stage deliberately reuses FSART's audited pair-covered triplet scanner and hard-spaced consensus code, while a constant-size bank of overlapping local windows protects against missed proposal peaks. These regions generate FastTree seed topologies only. They never fix the master, final breakpoints, number of events, or local-tree set.

The reconstruction searches a connected graph whose edges are executable unrooted SPR edits. Several data-ranked seed topologies launch independent searches; each successive graph layer can compose another edit, so a local tree can be arbitrarily many SPR moves from the inferred master and one breakpoint can carry a multi-edit script. Exact Fitch costs are retained by site. For a fixed explored graph, all-pairs shortest edit distances feed an exact minimum-duration semi-Markov decoder, and the genomic path alternates with an occupancy-weighted graph-medoid master update. The model therefore permits overlapping derived histories and multiple active edits in one region rather than restricting every alternative tree to one SPR from a fixed reference. Global topology-space optimality remains computationally intractable, so state, screen, round, start, and look-ahead budgets are exposed and the result reports its local/budgeted search certificate.

The result studio shows the genomic region strip and the actual implied trees from the recovered edit paths. Any two regions form a mirrored tanglegram; selecting all shows jointly rerooted/ordered trees under the region strip with matching taxa connected and track changes highlighted. The display optimization does not alter topology, branch lengths, breakpoints, or event scripts. The master, every local Newick tree, breakpoint-indexed edit tape, master-to-local derivations, shortest-script ambiguity, search rounds, JSON, CSV, and live SVG are exportable. See [`models/mosaicspr`](models/mosaicspr/README.md).

## JEMSPR coherent switching networks

JEMSPR is a third, independent alignment-only recombination method. It imports neither FSART nor MosaicSPR and does not invoke FastTree, the alivibe bridge, an uploaded tree, a triplet scanner, or a pre-identified breakpoint list. Ambiguity-aware Fitch or weighted Sankoff costs are computed on internally inferred rooted topologies. A whole-alignment NJ tree, data-independent dyadic-window NJ trees, and several root placements initialize an adaptive verified rooted-SPR graph. For every candidate master, an exact genomic dynamic program permits a multi-rSPR graph path at one boundary and charges master-distance span explicitly. Omitted one-rSPR trees are priced over every possible contiguous genomic interval rather than only against the current segmentation; strict and near improvers expand the graph through a bounded column-generation search. Small trees enumerate complete rooted-SPR neighborhoods; larger searches stream a structurally distributed finite set of genuine executable rooted-SPR moves so rejected candidates are never materialized as an unbounded browser-memory spike.

The top distinct master candidates across every inferred root search seed the explicit joint stage; the relaxed-path winner is not fixed as the master. Rooted-SPR moves are compiled into actual binary switching DAGs. Each reticulation has ordered background and alternate parents; compilation must preserve every old display, realize its target rooted-SPR alternate, and retain the complete taxon set under every switch mask. For each candidate network, an exact mask DP permits crossing and nested event intervals up to the selected overlap cap, charges openings, closures, breakpoint coordinates, active span, censoring, and retained reticulations, and returns persistent event identities rather than independent boundary scripts. A difference-constraint pass contracts each donor attachment with its recipient reticulation; strict-ancestry rank cycles are hard lazy cuts during the beam, so an impossible ARG is never selected and merely relabelled as valid afterward.

The result studio separates the coherent network from its tree-path relaxation. It provides an editable genomic tree/event-lane SVG, linked regional trees and two-tree tanglegrams, the compiled switching-DAG SVG, event and endpoint tables, exact fixed-network min-marginal boundary gaps, regularization/search audits, event CSV, local-tree and breakpoint TSVs, master Newick, and complete network/result JSON. Fixed-graph and fixed-network inference are exact; rooted-tree column generation and the outer network beam are budgeted and are never labelled globally optimal. See [`models/jemspr`](models/jemspr/README.md).

JEMSPR also ships with a seeded complex-recombinant benchmark and null control. Its primary accuracy measure is nucleotide-weighted site-averaged unrooted RF, supplemented by exact-tree span, one-to-one breakpoint F1/localization, event complexity, planted-network oracle decoding, and heavy-tail runtime. The repaired-search diagnosis and paired post-fix results are in [`models/jemspr/benchmarks/results`](models/jemspr/benchmarks/results/JEMSPR_FIXED_REPORT.md); the earlier exploratory report remains alongside it for auditability.

FSART also ships with a seeded piecewise-GTR simulation/benchmark harness. Its primary 3 kb design crosses zero through three topology-changing breakpoints with GARD-inspired low/high diversity under continuous Gamma + invariant + regionally correlated rate variation. It reports variable/parsimony-informative site fractions, usable events per taxa triplet, one-to-one breakpoint precision/recall/F1 and localization, conditional interval calibration, segment/topology-HMM RF, and stage-specific wall time, while preserving raw per-replicate outputs. Run it with `npm run simulate:fsart`; native FastTree partition tests are enabled by `FSART_FASTTREE=/absolute/path/to/FastTree`. Direct GARD timing is intentionally deferred. The pinned exploratory report is in [`models/fsart/simulations/results`](models/fsart/simulations/results/REPORT.md).

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
