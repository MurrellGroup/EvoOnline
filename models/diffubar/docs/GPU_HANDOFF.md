# GPU handoff checklist

## First run on GPU hardware

```bash
npm ci
npm run typecheck
npm test
npm run parity:webgpu
npm run build
```

The parity script uses Dawn in Node. A browser smoke test should then run the same small fixture through the UI with explicit `WASM f64` and `WebGPU` selections and compare the exported CSVs.

Record:

- adapter name, backend, driver, browser/Dawn version;
- maximum absolute raw log-likelihood error;
- maximum absolute site-normalized conditional error;
- grid kernel time excluding global fit and readback;
- readback time and peak GPU buffer sizes;
- whether device loss or validation messages occurred.

## Expected debugging order

If WGSL compilation fails, preserve the first validation message and line number. If compilation passes but values differ:

1. Test zero-length edges.
2. Test one nonzero edge and one category.
3. Test one binary combine.
4. Test scaling on a deeper tree.
5. Test site chunking with more sites than one output chunk.
6. Test the full Cartesian grid.

The most likely portability boundaries are f32 `exp`/`log` accuracy and driver-specific shader optimization, not category packing.

## Performance experiments after parity

Measure before retaining any of these changes:

- specialize shaders for 2 versus 3 branch classes;
- specialize fixed 61-state loops and Poisson term count as WGSL overrides;
- evaluate two or four sites per workgroup if workgroup memory permits;
- add a GPU cache-DAG prepass for high-purity trees;
- overlap site-chunk dispatch/readback with the next chunk;
- retain conditionals in f32 through a GPU sampler, with a separate statistical-parity gate;
- add timestamp queries where supported.

Do not introduce f16 likelihood state or a collapsed sampler under the parity backend name; expose either as a distinct fast mode with its own validation.
