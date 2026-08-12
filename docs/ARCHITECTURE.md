# Architecture

## Central rule

The workspace owns scientific artifacts. Viewers edit artifacts, models consume immutable artifact snapshots, and executors run jobs. No model reads mutable UI state directly.

```text
alignment/tree files
        │
        ▼
domain artifacts ─────► viewer adapters ─────► revised artifacts
        │
        ▼
model registry ───────► validation + parameter schema
        │
        ▼
immutable job spec ───► browser executor OR jobs API
        │
        ▼
versioned result artifact ─────► model result renderer
```

## Browser application

`apps/web` is a static application. It holds the current alignment and tree as immutable, SHA-256-addressed artifacts. The selected model validates that workspace and supplies its parameter form from a manifest.

alivibe and phylotagger run in same-origin iframes because they are substantial standalone tools with their own state and rendering. `packages/viewer-bridge` provides request/response correlation; the host never reaches into iframe globals. The bridge supports replacing either widget later without changing the workspace or model contract.

DifFUBAR, FUBAR, BS-REL, CladeShift, and the shared FAME/FLAVOR/Glamma package each run in a dedicated worker. DifFUBAR/FUBAR can choose WebGPU or a persistent WASM worker pool; FAME uses direct f64 WASM and FLAVOR defaults to its source-compatible f64 transition interpolation; BS-REL, Glamma, and CladeShift use site-parallel all-message WASM paths. All report stages plus optional progress telemetry. Backend preparation is explicit: the pipeline awaits WASM fetch/compile/instantiation and worker readiness, or GPU adapter acquisition and asynchronous WGSL compilation, under a dedicated runtime-initialization stage. Global fitting emits optimizer pass/iteration and log-likelihood updates; likelihood progress reports completed category or site blocks. A fused kernel reports an animated indeterminate activity state because it cannot yield a truthful mid-kernel counter without compromising the optimized execution path; the main UI independently updates elapsed time every 250 ms.

The site methods share the MG94 model bank, pruning kernels, fitted-model code, Newick/FASTA parsers and backend selection. The fitted model carries its NCBI genetic-code ID; that selection dynamically controls the 60–63 sense states, stop masking, synonymous topology, equilibrium vector, and buffer dimensions across every backend. DifFUBAR then uses its three-parameter Gibbs grid. Regular FUBAR uses the exact 20 × 20 CodonMolecularEvolution α–β grid and offers deterministic Dirichlet-EM by default or an exact uncollapsed Gibbs allocation sampler. FAME and FLAVOR add a generic branch-mixture operator ABI: each operator is a weighted list of atomic MG94 matrices plus a branch-time scale, and several operators can collapse directly into one category likelihood without allocating an expanded grid. FAME and FLAVOR's selectable direct-reference path use category-parallel sparse/dense uniformization. FLAVOR's default instead reproduces Julia's 50-node `matrix_sequence` recurrence: one small-time exponential per atomic ω, SIMD semigroup products, and element-wise interpolation. A mixed table is constructed once per capped/μ/shape distribution and reused across the contiguous α block, every branch, and every site. DifFUBAR allocation counts collapse into site-major α, ω1 and ω2 marginals. FUBAR and FAME/FLAVOR retain compact site-major surfaces plus parameter marginals. Temporary likelihood/allocation tables are discarded before results cross into React.

BS-REL reuses the same dynamic-state MG94 sparse-uniformization operators but supplies a different tree program. Nodes are compiled into preorder/postorder arrays and CSR children. For each 16-site SIMD block, the kernel retains normalized node-up, mixed-edge, rate-component, outside, and edge-context messages. The root-to-tip pass uses MG94 reversibility to apply the transpose transition without storing dense matrices. A normalized complete node blanket is divided by each strictly positive child message in linear time; exact-zero cases fall back to an explicit sibling product, so large polytomies avoid the quadratic loop noted by the reference `felsenstein_down!` implementation.

The alternative optimizer uses local finite-difference probes with exact whole-tree objectives: each edge context excludes that edge, so changing its operator and contracting the two sides evaluates the complete likelihood with every other parameter fixed. Baseline transformed components are cached, reducing an ω perturbation to one propagation. Limited-memory BFGS updates all branch parameters jointly; full line-search likelihoods need only the upward pass. Under each branch null, outside/subtree messages from the optimized alternative form a fixed local Markov blanket and a batched coordinate optimizer refits the constrained branch. Null objectives never launch a whole-tree prune per branch.

Glamma uses a different hierarchy on the same topology. Its outer α category is shared across every edge of one site; inside that α-specific tree prune, each edge independently applies the globally weighted ω transition mixture. Alpha categories are collapsed only after the complete site likelihood is available. The final all-message kernel retains low-ω and positive-tail pieces around every edge. Replacing the tail by its ω=1 transform gives the exact one-edge capped likelihood, while contracting only the retained tail gives P(ω>1 | data) for each branch/site cell. Alpha-weighted local likelihoods are integrated before either value leaves WASM. A separate all-capped prune supplies the site contrast. The branch activation integral consumes the same local capped/uncapped ratios, so exact branch truncation is always available without an additional per-branch prune.

CladeShift reuses FUBAR's fitted MG94 model and adaptively compresses each site's null α–β posterior in descending mass order until a requested coverage target or hard component cap is reached. For one retained category, a baseline upward/downward pass supplies every edge's outside context. For each fixed selection-intensity K, one fully shifted upward pass supplies the inside message for every possible descendant subtree. Contracting the baseline outside and shifted inside at edge `e` is exactly the likelihood in which `e` and all of its descendant edges use `ω^K`; all candidate change points therefore cost one tree pass per K, not one tree pass per candidate and K. The kernel integrates `L_shift/L_null` against the compressed null posterior before returning site-major log Bayes factors. Direction, K, and initiating edge are combined later with explicit fixed priors; each site's retained count and captured null mass are preserved for auditing.

FSART is the first alignment-only recombination plugin: its manifest has no tree input slot, and the generic workflow consequently omits tree upload/validation. Exhaustive lexicographic triplets are used when practical; otherwise a deterministic rank plan guarantees that every taxon pair occurs in at least one sampled triplet before filling the remaining budget systematically. Ranks are divided among up to eight workers. Each worker constructs a site-major byte matrix plus taxon/base bit planes, classifies 32 sites per bitwise step, reuses event buffers, maintains rolling topology counts, and retains a bounded peak heap. Pairwise equality planes are cached only below an 8 MiB per-worker ceiling; larger inputs derive them from base planes to avoid quadratic memory growth. One worker performs the BURT-style forward–backward refinement. The coordinator builds a local consensus field from support count and compressed evidence strength, then uses weighted-interval scheduling to impose a hard tree-inference spacing constraint. That span defaults to 150 nt and rises on shallow data until it is expected to contain at least `max(30, 2 × taxa)` variable sites. Worker count is additionally constrained by a conservative replicated-memory estimate because GitHub Pages cannot set the isolation headers needed for `SharedArrayBuffer`.

After scanning, the FSART executor calls private likelihood actions on the already-mounted alivibe iframe. Consensus cuts define atomic segments, and the executor requests a de novo tree for the global alignment, each atomic segment, each contiguous pair, and each contiguous triplet. Aioli is configured for separated stdout/stderr so the runner can pair Newick stdout with FastTree's Gamma20 likelihood from stderr. Equivalent unrooted topologies are deduplicated; the global fit supplies shared GTR rates/frequencies, and every retained fixed topology is scored at every alignment site. FastTree's existing module/worker is reused, so no duplicate WASM payload is introduced.

The resulting site-by-topology matrix is immutable during model selection. A sticky/reset HMM evaluates candidate topology subsets in O(LK), using a bounded beam over subset size followed by floating add/drop/swap moves under AIC, AICc, or BIC. The search pass estimates proxy stationary weights from averaged sitewise likelihood responsibilities, avoiding the artificial penalty that uniform resets impose on a topology used by a short tract. Exact forward–backward stationary-weight fitting and Viterbi decoding then run on the selected subset. Viterbi-assigned ranges belonging to one state are concatenated through `score-fasttree-ranges`, the topology is refitted, and all-site emissions plus subset search are repeated for a bounded number of rounds. The run records topology-set and boundary stability but returns the best bounded result even without convergence. Adjacent final Viterbi-run trees are compared by canonical non-trivial bipartitions to expose exploratory participating-clade candidates, without claiming a unique SPR path or local-only branch-length optimization.

When approximate FEL is requested, FUBAR consumes the raw category-major log-likelihood table before its in-place conversion to Bayesian conditional masses. Each site is max-shifted in log space and converted to a nodal-exact tensioned bicubic interpolant on the uniform grid-index coordinate. Analysis uses `Float64`; only the optional visualization surface crosses the worker boundary as site-major `Float32`. The FEL result owns its LRTs, directional p-values, threshold, CSV, and conditional-likelihood SVG. No FEL value is appended to the ordinary posterior site type or CSV.

Each renderer is model-owned and emits native SVG. DifFUBAR views share threshold, codon-window, label and selected-site state; its tagged phylogram adds independent label and size controls. FUBAR links its positive/purifying overview, α/β posterior-mass lanes and per-site posterior surface. Its optional approximate-FEL renderer separately links the null and unrestricted optima over the raw conditional-likelihood surface. SVG export serializes the live edited vector tree and strips transient hover targets/tooltips.

`apps/web/src/features/reference-map` is a generic post-result visualization layer shared by the site models. Model adapters reduce their site results to named posterior-hypothesis vectors. The base mode synchronously translates with the analysis's fitted genetic code, builds the raw amino-acid profile, and renders all selected hypotheses using alignment codon coordinates, so no reference is required. If a reference is supplied, a lazy worker parses the protein or coding-nucleotide sequence, translates coding input with the same code, and performs an exact global affine-gap alignment using expected BLOSUM62 profile scores. The dynamic program retains six score rows plus a packed one-byte-per-cell traceback, keeping score memory linear while preserving every insertion on both sides. The browser rejects matrices above 100 million traceback cells rather than risking unbounded allocation.

Selection-map columns always carry explicit profile indices. In alignment mode they form an identity coordinate map over codons. Reference mode additionally carries reference indices: coordinates advance only on a consumed reference residue, and consecutive profile-only columns derive stable alphabetic insertion suffixes from the preceding coordinate. Detection marks are produced independently for every enabled hypothesis and rendered in separate SVG lanes, so coincident hypotheses and adjacent sites cannot collide vertically or horizontally at the supported scale range. The optional reference row and reference-only gaps exist only in reference mode. The SVG contains all glyph paths, labels, colors, coordinates, and styles needed for lossless export; no canvas or `foreignObject` is used.

`apps/web/src/features/structure-mapping` is a deliberately removable result-view layer. Its dedicated worker translates the immutable alignment with the result's genetic code into an amino-acid frequency profile, streams PDB/mmCIF coordinate records into compact chain/residue arrays, and performs BLOSUM62-scored local profile alignment. The traceback retains explicit profile-column and chain-residue indices, including either-sided gaps. The UI passes only model-specific site annotations and color-mode descriptors into this generic layer.

Each chain has a small state machine derived from two checkboxes: `mapped` (shown and colored), `context` (shown neutrally), or `hidden`. Cartoon, ball-and-stick, molecular-surface, and surface-opacity settings are stored orthogonally per chain. An optional global opacity is an effective-value override rather than a destructive write, so clearing it restores every saved chain value. MolViewSpec union selectors are built independently for those representations, prevent hidden chains from entering any component, and apply result layers only to mapped-chain residue selectors. Surface chains are grouped by effective opacity so equal-opacity chains share one MolViewSpec representation while genuinely different opacities remain independent.

Mapped chains receive independent, collapsible SVG profile-alignment panels. Their glyph mass is `within-valid-column frequency × valid codons / total sequences`; stacks therefore encode raw occupancy rather than sequence-logo information content. All 20 amino-acid outlines are normalized to the same vector box, so stacked visual height is independent of browser font metrics. The complete traceback is rendered at fixed vertical dimensions inside a native horizontal scroller; the user-controlled horizontal scale changes column width only. Mol* is pinned but loaded from a CDN only on demand. Deleting the feature directory and the one panel import from each result renderer removes the capability without touching either numerical model.

## Control and compute planes

`apps/api` is the initial control plane. It exposes one model catalog and one jobs API rather than an HTTP service per method:

```text
GET  /v1/models
POST /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/jobs/:id/cancel
```

The included process-local queue is suitable for development. Production should replace it with a durable queue, store input/result artifacts in object storage, and launch one version-pinned OCI runner per job. The job contract remains the same.

## Artifact boundaries

- Control data: JSON job specifications, manifests, progress and provenance.
- Scientific tables: Arrow IPC is the intended binary interchange once results become large.
- Alignment/tree source: retain the user's original text and a normalized content hash.
- Large arrays: keep them in worker memory or object storage; do not put them in the API metadata database.

## Reproducibility

Every job identifies:

- model ID and semantic version;
- alignment and tree SHA-256 hashes;
- all parameter values;
- random seed;
- requested runtime;
- eventually the runner image digest and numerical-kernel revision.

Result artifacts should be append-only. A changed input, tag assignment, parameter, model version, or precision mode produces another job identity.
