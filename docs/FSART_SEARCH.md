# FSART topology search and interpretation

FSART separates breakpoint evidence, topology proposal, topology-subset model selection, and breakpoint/tree polishing. A strong triplet signal is therefore not a command to return multiple trees. It says where topology support changes may be worth modeling; the later likelihood/criterion search may still prefer one tree.

## Procedure

1. **Triplet proposal scan.** Canonical informative events are scanned for each sampled taxon triplet. Pair-covered sampling guarantees that every taxon pair is represented when exhaustive triplets are impractical. Local three-state HMM refinement supplies candidate-local breakpoint intervals. Signals are merged and hard-spaced into consensus proposals. Raw triplet p-values are audit quantities, not a model-admission test.
2. **Bounded tree family.** Consensus cuts define atomic segments. FastTree fits the whole alignment first, then every atomic segment, adjacent pair, and adjacent triplet. The global fit fixes the shared GTR frequencies/rates. Independent remaining fits run concurrently in separate BioWASM runtimes, bounded by the web CPU limit.
3. **Topology bank.** Unresolved exploratory trees are rejected because fixed-topology FastTree scoring requires a bifurcating input. Resolved trees are deduplicated by unrooted topology. The whole-alignment tree is retained as the explicit null; recurring, broadly supported regional topologies rank next. The configured bank limit can truncate the tail.
4. **Comparable site emissions.** Each retained topology is held fixed, its branch lengths/Gamma shape are trained with extra weight on its source range, and it is scored at every original aligned site under the shared GTR matrix. These per-site log likelihoods are cached.
5. **Rapid subset screen.** Every singleton is scored. The whole-alignment null is forced into the beam even when a regional singleton scores better. The search expands subsets by one topology up to the state cap, keeps a bounded beam at each size, then performs reversible add/drop/swap moves around its best subset. Each score uses an O(sites × states) scaled-forward proxy and a small expected-reset grid.
6. **Exact finalist verification.** The rapid winner plus a bounded set of the best multi-tree and neighboring candidates are refit with full forward/backward inference, an exact switching-rate grid, and optimized stationary topology weights. This protects the result from a proxy-ranking error without making the whole combinatorial search exhaustive.
7. **Exact floating cleanup.** The selected exact fit tries state removals and accepts a removal only when the configured AIC, AICc, or BIC improves.
8. **Viterbi reconstruction.** A sticky/reset HMM is decoded, and runs shorter than the minimum tree span are coalesced to a neighboring state using their emission support.
9. **Tree/breakpoint polishing.** Each occupied topology is re-estimated on all Viterbi ranges assigned to it. The resulting topologies are deduplicated, rescored at every site in parallel, and passed through the HMM again. This alternates for the configured number of iterations or until the topology set and boundaries stabilize.

The results view retains the initial searched subset graph even after polishing renames or changes topologies. A node is one subset that was actually scored; an edge is an actual add/drop/swap request touching the selected node. Rings identify finalists that received exact verification. Users can select any cached topology subset and explicitly run the exact fit plus tree/breakpoint polishing without rerunning the triplet scan.

## Numerical behavior

The forward/backward calculation subtracts each site's maximum log emission and rescales every site. The zero-switch slice is evaluated separately in log space. This matters when different topology profiles differ by hundreds or thousands of log-likelihood units: exponentiating those differences previously allowed a subnormal zero-switch path to contaminate stationary weights with `NaN`. Non-finite FastTree site emissions are now rejected with the topology ID and site instead of being silently treated as zero support.

An infinite AICc is different from numerical underflow. AICc is defined only when `n - k - 1 > 0`, where `n` is the aligned-site count and `k` includes shared GTR parameters, every topology's branch lengths/Gamma shape, topology weights, and the switch rate. With many taxa or a short alignment, every multi-tree AICc can be mathematically infinite. The UI reports the largest finite AICc state count.

## Main weaknesses

- The triplet scan proposes where to train trees; it does not enumerate all possible regional partitions.
- FastTree is heuristic, and low-information windows may return the same topology or an unresolved tree even when triplet evidence is strong.
- Topology deduplication and the bank cap can remove alternatives before subset search.
- Beam search is not an exhaustive subset optimizer. Exact finalist verification reduces proxy mis-ranking, but a synergistic subset outside the retained beam can still be missed.
- Information-criterion parameter counting can heavily penalize extra topologies. AICc can be undefined; AIC and BIC answer different model-selection questions and should not be chosen merely to obtain recombination.
- Source-weighted branch training is an approximation. It improves regional topology characterization but is not a joint maximum-likelihood fit of every branch, breakpoint, and substitution parameter.
- The shared GTR matrix assumes substitution-process homogeneity across regions.
- Minimum-run Viterbi coalescing intentionally suppresses short tracts.
- Alternating Viterbi assignment and tree re-estimation can converge to a local solution, merge two refitted states into one topology, or stop at the iteration cap.
- A one-tree result can be correct. The audit distinguishes that outcome from a collapsed candidate bank, failed/unresolved profile scoring, an AICc feasibility limit, and close alternative subsets.
