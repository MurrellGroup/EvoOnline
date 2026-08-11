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

DifFUBAR and FUBAR each run in a dedicated worker. Their workers choose WebGPU or a persistent WASM worker pool and report stages plus optional progress telemetry. Global fitting emits optimizer pass/iteration and log-likelihood updates; likelihood progress reports completed category-site work units while noting that the execution boundary is a site block containing every category. A fused kernel reports an indeterminate activity state because it cannot yield a truthful mid-kernel counter without compromising the optimized execution path.

Both models share the MG94 model bank, pruning kernels, fitted-model code, Newick/FASTA parsers and backend selection. DifFUBAR then uses its three-parameter Gibbs grid. Regular FUBAR uses the exact 20 × 20 CodonMolecularEvolution α–β grid and offers deterministic Dirichlet-EM by default or an exact uncollapsed Gibbs allocation sampler. DifFUBAR allocation counts collapse into site-major α, ω1 and ω2 marginals. FUBAR retains compact site-major α–β surfaces plus α and β marginals. Temporary likelihood/allocation tables are discarded before results cross into React.

Each renderer is model-owned and emits native SVG. DifFUBAR views share threshold, codon-window, label and selected-site state; its tagged phylogram adds independent label and size controls. FUBAR links its positive/purifying overview, α/β posterior-mass lanes and per-site posterior surface. SVG export serializes the live edited vector tree and strips transient hover targets/tooltips.

`apps/web/src/features/reference-map` is a generic post-result visualization layer shared by both models. Model adapters reduce their site results to named posterior-hypothesis vectors. A lazy worker builds the same raw amino-acid profile used for structures, parses a single protein or coding-nucleotide reference, and performs an exact global affine-gap alignment using expected BLOSUM62 profile scores. The dynamic program retains six score rows plus a packed one-byte-per-cell traceback, keeping score memory linear while preserving every insertion on both sides. The browser rejects matrices above 100 million traceback cells rather than risking unbounded allocation.

Reference-map columns carry explicit profile and reference indices. Reference coordinates advance only on a consumed reference residue; consecutive profile-only columns derive stable alphabetic insertion suffixes from the preceding coordinate. Detection marks are produced independently for every enabled hypothesis and rendered in separate SVG lanes, so coincident hypotheses and adjacent sites cannot collide vertically or horizontally at the supported scale range. The SVG contains all glyph paths, labels, colors, coordinates, and styles needed for lossless export; no canvas or `foreignObject` is used.

`apps/web/src/features/structure-mapping` is a deliberately removable result-view layer. Its dedicated worker translates the immutable alignment into an amino-acid frequency profile, streams PDB/mmCIF coordinate records into compact chain/residue arrays, and performs BLOSUM62-scored local profile alignment. The traceback retains explicit profile-column and chain-residue indices, including either-sided gaps. The UI passes only model-specific site annotations and color-mode descriptors into this generic layer.

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
