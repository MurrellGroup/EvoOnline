# FSART full-tree search and interpretation

FSART separates breakpoint evidence, full-tree proposal, tree-subset model selection, and breakpoint/tree polishing. A strong triplet signal is therefore not a command to return multiple trees. It says where changing phylogenetic support may be worth modeling; the later likelihood/criterion search may still correctly prefer one tree.

## Procedure

1. **Triplet proposal scan.** Canonical informative events are scanned for each sampled taxon triplet. Pair-covered sampling guarantees that every taxon pair is represented when exhaustive triplets are impractical. Local three-state HMM refinement supplies candidate-local breakpoint intervals. Signals are merged and hard-spaced into consensus proposals. Raw triplet p-values are audit quantities, not a model-admission test.
2. **Bounded tree family.** Consensus cuts define atomic segments. FastTree estimates one complete tree for the whole alignment first, then one complete tree for every atomic segment, adjacent pair, and adjacent triplet. The global fit supplies shared GTR frequencies/rates. Independent remaining fits run concurrently in separate bioWASM runtimes, bounded by the web CPU limit.
3. **Independent full-tree bank.** A fit is called unresolved when its labelled unrooted tree has fewer than `n - 3` distinct non-trivial splits (a polytomy rather than a fully bifurcating tree). Such fits are rejected because the frozen scorer requires a bifurcating tree. Every resolved fit is otherwise retained independently up to the configured safety cap. There is **no topology deduplication**: two trees with identical unrooted splits but different source-fitted branch lengths or Gamma shapes remain two different candidates. The whole-alignment fit is ordered first so index zero is the explicit one-tree null.
4. **Frozen comparable site emissions.** Each candidate keeps exactly the branch lengths and Gamma shape that FastTree fitted to that candidate's own source window or assigned Viterbi ranges. Source coordinates are metadata only: no other alignment sites are mixed into the fit and no source sites are duplicated for weighting. An internal likelihood engine scores every original aligned site under the complete frozen tree, the shared global GTR matrix, and a mean-one 20-category discrete-Gamma rate model. These per-site log likelihoods are cached.
5. **Rapid subset screen.** Every singleton is scored. The whole-alignment null is kept as a beam **seed** even when a regional singleton scores better, ensuring that a narrow beam evaluates null-plus-regional neighbors. It is not required to occur in any child or final hypothesis. The search expands subsets by one full tree up to the state cap, keeps a bounded beam at each size, then performs reversible add/drop/swap moves around its best subset. Each score uses an O(sites × states) scaled-forward proxy and a small expected-reset grid.
6. **Exact finalist verification.** The rapid winner plus a bounded set of the best multi-tree and neighboring candidates are fit with full forward/backward inference, switching-rate marginalization, and optimized stationary tree weights. This protects the result from a proxy-ranking error without making the entire combinatorial search exhaustive.
7. **Exact floating cleanup.** The best exact finalist tries state removals and accepts a removal only when the configured AIC, AICc, or BIC improves. The audit records the rapid winner, best initially exact-verified finalist, and final post-cleanup selection separately.
8. **Viterbi reconstruction.** A sticky/reset HMM is decoded, and runs shorter than the minimum tree span are coalesced to a neighboring state using their emission support.
9. **Tree/breakpoint polishing.** Each occupied state is independently re-estimated on all Viterbi ranges assigned to it, including discontiguous ranges. The resulting complete trees are not deduplicated; their new branch lengths and Gamma shapes are frozen, every site is rescored in parallel, and the HMM is run again. This alternates for the configured number of iterations or until the complete fitted-tree set and boundaries stabilize.

The results view retains the initial searched-subset graph even after polishing renames or changes trees. A node is one subset that was actually scored; an edge is an actual add/drop/swap request touching the selected node. Rings identify every subset that received an exact fit. The null, rapid winner, best initial exact finalist, and final post-cleanup selection are independently labelled. Users can select any cached full-tree subset and run its exact fit plus independent tree/breakpoint polishing without rerunning the triplet scan. The hypothesis table and figure export as CSV and SVG.

## Numerical behavior

The forward/backward calculation subtracts each site's maximum log emission and rescales every site. The zero-switch slice is evaluated separately in log space. This matters when full-tree profiles differ by hundreds or thousands of log-likelihood units: exponentiating those differences can otherwise underflow and contaminate stationary weights with `NaN`. Non-finite site emissions are rejected with the tree ID and aligned-site number instead of being silently treated as zero support.

An infinite AICc is different from numerical underflow. AICc is defined only when `n - k - 1 > 0`, where `n` is the aligned-site count and `k` includes shared GTR parameters, every full tree's branch lengths/Gamma shape, tree weights, and the switch rate. With many taxa or a short alignment, every multi-tree AICc can be mathematically infinite. The UI reports the largest finite AICc state count.

## Main weaknesses

- The triplet scan proposes source windows; it does not enumerate all possible regional partitions.
- FastTree is heuristic, and low-information windows may return the same topology, a poor branch-length/Gamma fit, or an unresolved tree even when triplet evidence is strong.
- Retaining same-topology full trees prevents incorrect likelihood-profile collapse but can consume the finite bank cap with very similar candidates.
- The bank cap can remove alternatives before subset search.
- Beam search is not an exhaustive subset optimizer. Exact finalist verification reduces proxy mis-ranking, but a synergistic subset outside the retained beam can still be missed.
- Information-criterion parameter counting can heavily penalize extra full trees. AICc can be undefined; AIC and BIC answer different model-selection questions and should not be chosen merely to obtain recombination.
- The shared GTR matrix assumes substitution-process homogeneity across regions, although each full tree retains its own branch lengths and Gamma shape.
- The internal frozen-tree scorer and FastTree should implement the same intended GTR+Gamma model, but they are independent numerical implementations and need continuing cross-validation.
- Minimum-run Viterbi coalescing intentionally suppresses short tracts.
- Alternating Viterbi assignment and independent tree re-estimation can converge to a local solution or stop at the iteration cap.
- A one-tree result can be correct. The audit distinguishes that outcome from a collapsed/failed candidate bank, unresolved fits, an AICc feasibility limit, and close alternative subsets.
