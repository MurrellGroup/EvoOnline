# Browser FUBAR

An exact fixed-grid implementation of `CodonMolecularEvolution.jl`'s `DirichletFUBAR` workflow for WebAssembly and WebGPU. It shares the optimized MG94 pruning and global-fit kernels with the DifFUBAR package, then retains per-site alpha-beta posterior surfaces and marginals.

The reference default is a 20 × 20 grid (400 categories), 2,500 maximum EM iterations, concentration 0.5, and posterior threshold 0.95. Deterministic finite-Dirichlet EM is the inference default. An exact uncollapsed Gibbs option uses the same fused WASM rejection-draw strategy as DifFUBAR, with configurable burn-in and seed; its retained allocation counts feed the same visualization and CSV products. Parallel WASM is the browser default, and WebGPU is explicitly selectable.
