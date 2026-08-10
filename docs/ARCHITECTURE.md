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

DifFUBAR runs in a dedicated worker. Its worker chooses WebGPU or a persistent WASM worker pool and reports stages. When figure data is requested, the sampler's temporary category-by-site allocation counts are collapsed once into site-major α, ω1, and ω2 `Float32Array` marginals; the allocation table is then discarded. Only those compact marginals and the eight site summary columns cross into the UI, never the likelihood grid.

The DifFUBAR renderer is model-owned and emits native SVG. Its three views share threshold, codon-window, label, and selected-site state, but consume the immutable result artifact. SVG export serializes the live edited vector tree and strips transient hover targets/tooltips.

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
