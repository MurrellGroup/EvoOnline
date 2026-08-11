# BS-REL

EvoOnline's fixed-complexity, three-rate branch-site random-effects likelihood test. Every branch receives purifying, near-neutral, and positive omega classes and mixing weights. The implementation deliberately does not perform the AIC/AICc complexity selection used by aBS-REL.

The alternative is optimized jointly across all branches. A SIMD WASM upward/downward pass then supplies both directed messages around every edge. Each branch null fixes its positive omega to one and is re-optimized against that local blanket without re-pruning the rest of the phylogeny. Raw p-values use the calibrated fixed three-rate mixture `0.50 χ²₀ + 0.05 χ²₁ + 0.45 χ²₂`; Holm-Bonferroni controls family-wise error across the requested branches.
