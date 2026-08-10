# Architecture and memory model

## Pipeline

1. Parse aligned FASTA and tagged Newick/NEXUS.
2. Fit or load the global nucleotide/MG94 model.
3. Rescale branch lengths by the fitted global alpha.
4. Construct the Julia-compatible Cartesian grid and deduplicated `(alpha, omega)` model bank.
5. Evaluate category-by-site conditional log likelihoods on WebGPU or f64 WASM.
6. Normalize each site by its maximum log likelihood.
7. Run the uncollapsed Gibbs allocation sampler in WASM.
8. Tabulate the four posterior tests and three posterior means per codon site.
9. When visualization data is requested, collapse transient category counts to site-major α/ω grid marginals and release the full table.

The compute boundary is deliberately narrow. Parsers and model construction are TypeScript; the two sustained numerical loops are WGSL and AssemblyScript.

## Tree program

The parser builds a multifurcating tree. `compileTree` sorts child evaluation by Sethi–Ullman register need and emits four-word operations:

| Opcode | Meaning |
|---|---|
| `LoadTip` | Load a 61-state compatible-tip vector |
| `Transform` | Apply `exp(Qt)` over one edge |
| `MultiplyNormalize` | Combine two child messages and accumulate `log(sum)` |
| `LoadCache` | Load a dependency-cache entry in the WASM program |

Only `registerNumber × 61` states are live in the flat evaluator, rather than `nodeCount × 61`. The GPU limit is 24 registers; ordinary binary and modest multifurcating trees require far fewer.

## MG94 model bank

Sense codons use lexical order, identical to the reference genetic-code constructor. Each MG94 row contains at most nine one-nucleotide neighbors. For a change from nucleotide `i` to `j` at codon position `p`:

\[
q_{xy} = r_{ij} F_{p,j}
\begin{cases}
\alpha & \text{synonymous} \\
\alpha\omega & \text{nonsynonymous}
\end{cases}
\]

The diagonal is the negative row sum. Models are deduplicated by `(alpha, omega)`, then stored as a sparse uniformized operator `R = I + Q / μ` plus `μ`.

`exp(Qt)v` is evaluated as an adaptive Poisson series. The f64 kernel follows the Poisson mass until the remaining tail is at most `1e-14`; short branches therefore use far fewer terms than a fixed truncation. Large rates are handled in stable chunks with `μt ≤ 64`, avoiding the repeated copying and over-truncation of the previous `μt ≤ 2`, 18-term scheme. A positive `poissonTerms` request still selects fixed truncation for controlled fixtures.

## WebGPU kernel

Dispatch dimensions are `(site chunk, grid category, 1)`. A workgroup has 64 invocations:

- lanes 0–60 own codon states;
- lanes 61–63 contribute zero and complete barriers/reductions;
- sparse row propagation is parallel across states;
- the tree register file lives in workgroup memory;
- likelihood normalization uses a 64-lane workgroup reduction;
- output is category-major f32 log likelihood.

Maximum workgroup memory is about 7.3 KiB at the 24-slot limit. Static tree/model buffers are uploaded once. Tips and outputs are site-chunked to remain below adapter storage-binding limits, and each output chunk is read back once.

Standard WebGPU does not provide portable f64 shader arithmetic. The GPU result is therefore an approximate f32 path; f64 strict validation belongs to WASM.

## WASM kernel

The WASM backend keeps sites contiguous inside a 16-site cache block. Explicit `f64x2` SIMD handles the uniformization recurrence, while the sparse neighbor topology avoids 61-by-61 zero work. Large jobs are split by site across a persistent worker pool; small jobs stay in the calling worker to avoid startup overhead. A compiled `WebAssembly.Module` is structured-cloned into the pool so workers do not compile the same binary independently.

### Hierarchical dependency cache

For every edge-subtree, the compiler computes a branch-class dependency bitmask. If a contribution omits an axis present in its enclosing context, it becomes a cache node. Cache nodes form a postorder DAG:

- pure clades are evaluated once per `(alpha, omega_class)`;
- mixed two-class clades are evaluated once per unique two-class model tuple;
- their results are reused across omitted Cartesian axes;
- nested caches eliminate repeated pure work inside mixed caches.

The cache is evaluated one 16-site block at a time, so memory is independent of total alignment length. Its f64 working memory is

\[
8 \times 16 \times (61 + 1) \times \sum_c N_c \text{ bytes},
\]

where `N_c` is the number of distinct model tuples for cache node `c`. A 192 MiB safety cap selects the flat register program when a topology would require too much cache memory.

## Sampler

All production sampler modes preserve the same finite Dirichlet-mixture posterior. `reference` implements the original uncollapsed loop:

1. sample each site allocation from `theta[k] × L[k,site]`;
2. add allocation counts to a symmetric Dirichlet concentration vector;
3. draw the next theta with gamma variates;
4. retain allocations and theta only after burn-in.

The default `fast-exact` mode replaces the K-wide allocation scan with rejection sampling. It proposes `k ~ theta` from a cumulative table and accepts with `L[k,site] / max_k L[k,site]`; the accepted category therefore has exactly the target mass `theta[k] L[k,site]`. A 128-attempt cap falls back to the dense draw, keeping pathological inputs bounded without changing the target distribution. This reduces the full-data allocation step from billions of products to a small number of binary searches.

Gamma draws with shape exactly 0.1—the vast majority under the default sparse allocation prior—use a specialized Ahrens–Dieter GS kernel with an integer `p^10` path. Other shapes retain Marsaglia–Tsang sampling. `collapsed` integrates theta out and Rao–Blackwellizes its returned mean; it is available as an explicitly different Markov kernel.

A positive likelihood cutoff prunes values before either fast or reference sampling and is an explicit approximation. The API default cutoff is zero; the UI/CLI default is `1e-12`.

Site summaries are accumulated online. The full category-by-site allocation matrix is allocated only when `trackAllocations` or `collectPosteriorMarginals` is requested. The latter immediately collapses it to three compact `Float32Array` marginals, so the category table remains a short-lived sampler/postprocessing buffer rather than part of the result.

## Browser execution

The UI starts the complete analysis in a module worker, which may create nested likelihood workers. This has three effects:

- WASM cannot block rendering/input;
- cancellation can terminate a monolithic f64 call immediately;
- compact result typed-array buffers are transferred back without copying.

The application performs no uploads or network requests for analysis data.
