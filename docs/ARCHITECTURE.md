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
