# MosaicSPR: fast reconstruction of mosaic phylogenies as explicit subtree-prune-and-regraft histories

**Methods manuscript draft**

**Authors and affiliations:** to be supplied

**Software implementation:** EvoOnline, MosaicSPR v0.1.0

## Abstract

Recombining alignments are commonly summarized as a partition of the genome and an independently inferred phylogeny for each partition. That representation identifies topological discordance but does not explain how adjacent local trees are related. MosaicSPR is an exploratory, browser-executable method that reconstructs an unknown unrooted master topology, a piecewise-constant path of local topologies along an alignment, and explicit subtree-prune-and-regraft (SPR) scripts relating the inferred trees. The method separates topology proposal from final reconstruction. An optional, highly optimized scan of phylogenetically informative taxon triplets proposes regions in which distinct topologies may occur. These proposals, a global window, and a constant-size bank of overlapping windows are used only to fit a diverse set of FastTree seed topologies; they never fix the final breakpoints. Starting independently from several seed topologies, MosaicSPR constructs a connected graph in which every edge is a verified unrooted SPR operation. New topology columns are generated from complete one-SPR neighborhoods, screened by seed proximity, and priced by their best possible parsimony improvement over a contiguous interval. For each finite graph and candidate master, an exact minimum-duration semi-Markov dynamic program jointly selects genomic runs and local trees under penalties for breakpoint coordinates, SPR distance, and history complexity. A robust graph-medoid update allows the master to move away from its initialization. The final output includes local trees, breakpoint coordinates, shortest executable SPR scripts, alternative-script counts, and an explicit search certificate. The fixed-graph decoder is exact, whereas topology generation, master updates, and stopping are budgeted heuristics. MosaicSPR is therefore intended as a fast and interpretable reconstruction tool, not as a globally optimal likelihood method or a calibrated test of recombination.

## 1. Motivation and scope

Phylogenetic recombination methods typically ask whether one tree adequately describes an alignment or whether different genomic regions support different trees. GARD, for example, searches breakpoint partitions and fits a separate phylogeny to each segment [1,2]. MosaicSPR asks a complementary question: if the genome is described by a sequence of local trees, can those trees be represented compactly as explicit rearrangements from a jointly inferred master topology?

An unrooted SPR operation cuts one edge, detaches one connected subtree, suppresses the resulting degree-two attachment vertex, subdivides another edge of the retained tree, and reconnects the pruned subtree. SPR operations induce a connected graph over binary leaf-labelled phylogenies and provide an interpretable edit language for recombination and horizontal transfer [3]. MosaicSPR searches this graph directly. It permits any discovered local topology to be an arbitrary composition of SPR operations; it does not require every local tree to be one SPR from the master, and a single genomic boundary may contain a multi-step SPR script.

MosaicSPR currently analyzes aligned nucleotide sequences. It treats trees as unrooted topologies, uses FastTree only to propose starting topologies [4], and scores the final reconstruction with exact per-site Fitch parsimony [5]. Branch lengths and substitution-model likelihoods do not enter the final objective. The output is an explicit, inspectable reconstruction rather than a p-value or posterior distribution over ancestral recombination graphs.

## 2. Overview

The production pipeline has five stages:

1. Parse the alignment into byte and bit-plane representations and identify variable nucleotide sites.
2. Optionally scan informative taxon triplets to obtain a spatially diverse list of non-binding breakpoint proposals and local uncertainty intervals.
3. Fit FastTree topologies to the whole alignment, proposal-defined segments, adjacent segment pairs and triplets, and a constant-size overlapping-window safety net.
4. From several seed topologies, grow a connected unrooted-SPR graph by budgeted column generation.
5. Repeatedly solve an exact minimum-duration segmentation problem on the current graph, update the latent master, and export the selected local trees and shortest executable SPR scripts.

The key separation is between **proposal coordinates** and **reconstructed breakpoints**. Proposal coordinates determine which windows receive a fast preliminary tree fit. The final dynamic program operates at every aligned nucleotide and may place a breakpoint anywhere that satisfies the minimum-run constraint.

## 3. Alignment representation

Let the alignment contain \(N\) taxa and \(L\) nucleotide columns. Canonical A, C, G and T/U characters are encoded as integers 0–3. Ambiguous characters and gaps are retained in the alignment matrix but are ignored by the triplet scan; in Fitch scoring they are treated as the full nucleotide state set and therefore contribute no unsupported change by themselves.

For fast triplet scanning, the implementation stores one bit plane per taxon and nucleotide and a canonical-state bit plane. If the complete cache fits within 8 MiB, it additionally stores bitwise equality masks for every pair of taxa. Larger jobs omit the quadratic pair cache and compute equality from the four base planes. Only sites that are variable somewhere in the alignment enter byte-wise fallback scans.

## 4. Optional informative-triplet proposal scan

### 4.1 Pair-covered triplet sampling

Inspired by triplet/pair scanning in RDP [7], a site for triplet \((a,b,c)\) is informative when exactly two canonical nucleotides agree and the third differs. The observation is one of three states: \(ab|c\), \(ac|b\), or \(bc|a\). Constant sites, three-way differences, ambiguity and gaps are excluded.

When all \({N \choose 3}\) triplets fit within the requested budget (default 250,000), all are scanned. Otherwise, the first deterministic sampling layer guarantees that every taxon pair occurs in at least one triplet by assigning each pair a hashed third taxon. A systematic alignment-wide sample of lexicographic triplet ranks fills the remaining budget. Pair coverage takes precedence over the nominal budget, so a small requested budget cannot silently omit a taxon pair.

### 4.2 Sliding informative-event scan

Triplets are scanned in informative-event coordinates rather than raw nucleotide coordinates. With the default flank width \(w=24\), a boundary is evaluated only when at least \(w\) informative events occur on each side. The two flanks form a \(2\times3\) contingency table of topology-state counts. A candidate is admitted when the dominant left and right states differ and the log-likelihood-ratio statistic

\[
G^2 = 2\sum_{r=1}^{2}\sum_{k=1}^{3} n_{rk}\log\!\left(\frac{n_{rk}n_{\cdot\cdot}}{n_{r\cdot}n_{\cdot k}}\right)
\]

is at least 4. For two degrees of freedom, the implementation records \(\log p=-G^2/2\). This quantity ranks proposals; it is not used as a family-wise admission test. Up to four spatially separated peaks are retained per triplet, and a bounded global min-heap retains at most 1,024 peaks. Count updates are constant-time as the window slides, and \(x\log x\) values are tabled for all possible counts.

### 4.3 HMM refinement without Baum–Welch fitting

The strongest spatially diverse raw peaks (default 256) are refined with a three-state continuous-time hidden Markov model on the informative-event stream of each represented triplet. The symmetric transition model over the physical distance \(d\) between consecutive informative sites is

\[
P(S_{i+1}=S_i)=\frac13+\frac23e^{-3rd/2},\qquad
P(S_{i+1}=k\ne S_i)=\frac13-\frac13e^{-3rd/2}
\]

The emission probability is \(q\) for the observed topology state and \((1-q)/2\) for either alternative. To avoid a costly and unstable Baum–Welch loop, \(q\) is initialized once from the modal purity of raw-candidate-defined regions, stabilized by a symmetric Dirichlet(1/2) adjustment, and clipped to [0.55, 0.995].

The switching rate is marginalized rather than optimized. Nine default slices correspond to expected switch counts centered on the number of raw candidates for the triplet and multiplied by \(2^x\), with \(x\) evenly spanning -3 to 3. A scaled forward algorithm supplies the evidence weight of each slice; forward–backward posteriors are then averaged with those weights. A candidate is associated with the connected local mode of the marginal switch-posterior curve nearest its scan boundary. Its default 95% interval is computed from that mode’s local basin, not from global quantiles of the entire curve, because the sum of edge-wise switch probabilities is an expected switch count rather than a normalized one-breakpoint distribution.

### 4.4 Consensus proposals

Refined peaks are aggregated across triplets with a compact kernel. Within a kernel, a triplet contributes only its strongest peak, preventing repeated peaks from one triplet from voting multiple times. The contribution of signal \(i\) at center \(x\) is

\[
u_i(x)=\log(1+[\min(12,E_i)-0.75]_+)\,
(0.4+0.6\sqrt{\pi_i})\,
\left[1-\left(\frac{|b_i-x|}{h+1}\right)^2\right]_+
\]

where \(E_i=-\log_{10}p_i\), \(\pi_i\) is the local HMM switch posterior, \(b_i\) is the refined coordinate, and the bandwidth \(h\) is the larger of 12 nt and one fifth of the minimum estimable tree span. Log compression prevents one extreme triplet from overwhelming broad corroboration. The consensus score is \(\sum_i u_i+1.5\log(1+m)\), where \(m\) is the number of contributing triplets; the consensus coordinate is their contribution-weighted median.

Finally, weighted interval scheduling selects up to 14 candidates, subtracting a proposal cost of 2.5 and requiring adjacent candidates, and both alignment ends, to be separated by the minimum estimable tree span. This is proposal regularization only. No multiple-comparison correction discards candidates before topology fitting.

## 5. Topology seed family

### 5.1 Diversity-aware minimum tree span

The user’s minimum segment length is a lower bound. MosaicSPR raises it when the alignment-wide variable-site density is too low to support a local tree. With variable fraction \(v\), the effective minimum span is

\[
h=\lfloor L/2\rfloor,\qquad q=\lceil\max(30,2N)/v\rceil,
\qquad m=\min(h,\max(60,m_{user},q))
\]

Thus a topology-training window is expected to contain at least 30 or twice the number of taxa variable sites, whichever is larger.

### 5.2 Proposal-derived and safety-net windows

Sorted consensus breakpoints define atomic segments. MosaicSPR fits a preliminary tree to every valid atomic segment, every contiguous pair of segments, every contiguous triplet of segments, and the full alignment. No longer proposal-derived combinations are generated. In parallel, a breakpoint-independent safety bank covers the alignment with approximately quarter-length windows at half-window overlap, typically seven windows. Duplicate coordinate ranges are removed.

The safety bank is a deliberate practical hack: an internal mosaic topology can enter the SPR search even when the triplet scan misses or mislocalizes its boundary. Conversely, pair and triplet windows reduce the instability of fitting a tree to a short or weakly variable atomic segment.

### 5.3 FastTree fitting

Each window is fitted with FastTree 2.1.11, by default using its fastest topology-search option [4]. In EvoOnline this runs through the shared browser WebAssembly runtime. The whole-alignment fit is evaluated first; when FastTree exposes fitted GTR frequencies and exchangeabilities, those parameters are reused for subsequent window fits to reduce both runtime and nuisance variation among seeds. Only fully resolved, exactly taxon-matched trees are retained. Internal Newick labels and the artificial degree-two Newick root are discarded when computing unrooted topology identity.

FastTree log likelihoods and branch lengths are retained for diagnostics but do not enter the MosaicSPR reconstruction objective. Duplicate unrooted topologies are collapsed. The distinct seeds are ranked by whole-alignment Fitch parsimony, and the best three by default initialize independent SPR searches. All seed signatures, including those not used as starts, guide structural screening.

## 6. Explicit unrooted-SPR graph

Each search maintains a graph \(G=(V,E)\). A vertex is a resolved unrooted topology on the alignment’s taxon set. An undirected edge joins two vertices only when one has been generated from the other by a verified single unrooted SPR operation. The implementation records the pruned taxon set, source cut split, attachment edge created after suppressing the source degree-two vertex, and destination split. Applying the stored edit to the source is checked to reproduce the declared destination topology.

For every expanded vertex, MosaicSPR enumerates its complete distinct one-SPR neighborhood. Several directed cuts and regrafts may produce the same neighboring topology; these descriptions are deduplicated by canonical split signature while retaining the available edit descriptions. Existing neighbors add graph edges immediately. New topologies become candidate columns.

## 7. Scoring and exact fixed-graph decoding

### 7.1 Per-site emission cost

For topology \(k\) and alignment column \(s\), \(c_{ks}\) is the exact Fitch minimum-change score on the unrooted tree [5]. A postorder pass intersects child state sets where possible and unions them, adding one change, when the intersection is empty. The complete vector \((c_{k1},\ldots,c_{kL})\) is cached for every admitted graph state.

### 7.2 Penalized path objective

Let the alignment be partitioned into \(R\) consecutive runs \([a_r,b_r]\), each of length at least \(m\). Let \(z_r\in V\) be the topology assigned to run \(r\), \(M\in V\) the latent master, and \(d_G\) unweighted shortest-path distance in the explicit SPR graph. MosaicSPR minimizes

\[
J(M,z)=
\sum_{r=1}^{R}\sum_{s=a_r}^{b_r}c_{z_rs}
+\sum_{r=2}^{R}\left(\lambda_B+\lambda_S d_G(z_{r-1},z_r)\right)
+\lambda_M\sum_{r=1}^{R}d_G(M,z_r)
\]

The first term is data parsimony. \(\lambda_B\) penalizes each breakpoint coordinate, \(\lambda_S\) charges every SPR edit in a boundary script, and \(\lambda_M\) favors a compact description around one master without requiring the master to occur as a local tree. Recurrent use of the same local topology is allowed. A transition can traverse any finite graph distance at one coordinate and therefore may represent a multi-SPR event.

For a fixed graph and fixed master, a minimum-duration semi-Markov dynamic program solves this objective exactly. Per-state prefix sums make any run emission constant-time. The recurrence retains, for each endpoint and state, the best admissible start and previous state; its time complexity is \(O(L|V|^2)\) and memory complexity is \(O(L|V|)\). If \(L<2m\), the implementation deliberately forces a single run because two estimable local trees cannot fit.

### 7.3 Master update

After decoding, the master is updated to a robust graph medoid

\[
M\leftarrow\arg\min_{u\in V}\sum_{k:n_k>0}\sqrt{n_k}\,d_G(u,k)
\]

where \(n_k\) is the number of sites assigned to topology \(k\). The square-root occupancy is a practical robustness choice: it prevents one long region from completely determining the master while giving more support to persistent topologies than to very short regions. The new master and path are alternated for at most six updates or until the master is unchanged.

This medoid step is intentionally heuristic. It is not the exact coordinate minimizer of the run-level \(\lambda_M\) term in \(J\). Conditional on each proposed master, however, the reported path objective is computed by the exact decoder. Independent seed starts provide an additional safeguard against a poor master basin.

## 8. Budgeted topology column generation

At each round, the source frontier is the union of currently occupied states and states added in the previous round, truncated to at most twice the expansion beam (minimum four). Complete one-SPR neighborhoods are enumerated for those sources and cached.

When more new neighbors exist than can be fully scored, a structural screen of 96 candidates is used by default. Seventy percent are the candidates closest, by unrooted split symmetric difference, to any FastTree seed. The remaining capacity is filled at evenly spaced ranks through the sorted candidate list. This mixed screen favors empirically observed topologies but preserves deterministic structural diversity.

Every screened candidate receives a full per-site Fitch vector. Its pricing heuristic is

\[
P(u)=\max_{b-a+1\ge m}\sum_{s=a}^{b}\left(c_{z(s),s}-c_{u,s}\right)
-2(\lambda_B+\lambda_S)-0.05d_{guide}(u)
\]

where \(z(s)\) is the current decoded state and \(d_{guide}\) is the minimum split distance to a seed. The interval maximum is obtained in one pass using prefix minima. The subtraction approximates the cost of inserting a one-SPR internal run. It is deliberately a proposal score: it omits the master penalty, uses a conservative two-boundary charge even for an edge-censored run, and does not alter the final objective.

The four highest-priced columns are added by default, including negative-priced columns when capacity remains. Retaining such near-improvers is another deliberate hack: a topology two or more SPR moves away may be strongly supported even when every intermediate topology is unused. After adding columns, all-pairs graph distances, the master, and the exact segmentation are recomputed. A search stops at 48 states, 12 rounds, five consecutive rounds without objective improvement, or an exhausted neighborhood. Thus there is no one-SPR-from-master restriction; the patience budget merely limits how many unprofitable graph layers are crossed.

## 9. Initialization, defaults, and practical safeguards

### 9.1 Proposal construction and topology seeding

| Component | Default | Practical purpose |
|---|---:|---|
| Triplet flank | 24 informative events | Stable local 2×3 counts without tying resolution to raw site density |
| Triplet budget | 250,000 plus mandatory pair cover | Bounded scan with every taxon pair represented |
| Raw/refined peaks | 1,024 / 256 | Strict memory and HMM-refinement bounds |
| Consensus proposals | 14 | Controls only the FastTree window family |
| User minimum run | 150 nt | Raised automatically when diversity is sparse |
| Overlap safety windows | quarter alignment, 50% overlap | Recovers seed topologies missed by triplet proposals |
| FastTree starts | 3 | Independent unknown-master basins |

### 9.2 SPR graph search

| Component | Default | Practical purpose |
|---|---:|---|
| Graph states / rounds | 48 / 12 | Primary memory and runtime bounds |
| Expansion beam | 4 | Columns added per round |
| Fitch screen | 96 | Full per-site scores per round |
| Non-improving patience | 5 rounds | Crosses multi-SPR valleys |

### 9.3 Reconstruction penalties

| Component | Default | Practical purpose |
|---|---:|---|
| \(\lambda_B\) | \(0.5\ln L\) | Alignment-size breakpoint description cost |
| \(\lambda_S\) | \(0.35\ln Q_N\) | Taxon-scaled edit description cost |
| \(\lambda_M\) | \(0.25\lambda_S\) | Mild compact-master preference |

Here \(Q_N=\max[4,(2N-3)\max(2,2N-6)]\). The penalty formulas are MDL-inspired engineering defaults rather than a formally derived code length or calibrated prior. All three may be overridden. A robust analysis should rerun near the selected settings, particularly with a larger state budget and different minimum-run length, and check whether the same occupied topologies and boundaries recur.

## 10. Output and search certificate

For every selected genomic run, MosaicSPR reports its coordinates, topology, state identifier and parsimony. For every boundary it computes a breadth-first shortest path between the adjacent states in \(G\), exports each executable SPR edit, and counts alternative shortest scripts up to a cap of 32. The same procedure derives every occupied topology from the selected master. Deterministic topology-signature ordering resolves path ties.

The result also includes the preliminary proposals, their HMM intervals, all FastTree seed fits, every retained topology state, per-round search diagnostics, and CSV/JSON exports. The search certificate distinguishes two cases:

- **Exhaustive one-SPR local:** every one-SPR neighbor of the final occupied/frontier states fit within the scoring budget and none entered the reconstruction. This is a local certificate only.
- **Budgeted column generation:** at least one screen, state, iteration or patience budget limited the explored topology graph.

Neither certificate claims a global optimum over all unrooted trees.

## 11. Computational complexity

Let \(T\) be the number of scanned triplets, \(I_t\) the number of informative events in triplet \(t\), \(K\) the retained graph-state count, and \(P\) the number of fully scored candidates per round. The hot triplet scan is \(O(\sum_t I_t)\) after bit-plane construction and uses fixed-size event buffers plus bounded peak heaps. HMM refinement is linear in the informative events times the number of rate slices and three hidden states.

FastTree fitting dominates when many proposal windows are retained; the window family is bounded by the proposal count plus a constant-size overlap bank. For each graph round, complete one-SPR enumeration is topology-dependent and grows approximately quadratically in taxon count before deduplication. Full Fitch pricing is \(O(PNL)\). Fixed-graph decoding is \(O(LK^2)\), all-pairs graph distance is negligible at the default \(K\le48\), and cached per-site costs require \(O(LK)\) memory. In the browser, the triplet and SPR stages run in dedicated workers, while FastTree uses the shared WebAssembly runtime.

## 12. Interpretation and limitations

MosaicSPR is designed for speed, explicitness and exploratory biological interpretation. Its main limitations are:

1. **Parsimony rather than likelihood.** Branch lengths, compositional variation and multiple substitutions are not modeled in the final reconstruction. Homoplasy, selection or systematic error can mimic local tree change.
2. **Heuristic topology universe.** The finite graph decoder is exact, but seed fitting, candidate screening, graph growth, master updates and stopping are not globally optimal.
3. **No calibrated evidence scale.** The objective and proposal scores are engineering criteria. They are not Bayes factors, likelihood-ratio statistics, posterior probabilities, or family-wise recombination tests.
4. **Unrooted event descriptions.** An SPR script identifies a topological rearrangement, not a unique donor, recipient, direction or time. Alternative shortest scripts may be biologically distinct.
5. **Resolution limits.** Short recombinant tracts may be excluded by the diversity-aware minimum run. Sparse variation broadens proposal intervals and weakens local-tree identifiability.
6. **Resolved-tree requirement.** Preliminary polytomies are excluded because the explicit binary SPR graph and downstream FastTree interfaces require fully resolved topologies.
7. **Penalty sensitivity.** The selected number of runs and edit complexity should be checked under nearby penalties and larger search budgets.

MosaicSPR should therefore be used to formulate and visualize candidate mosaic histories. Confirmatory analysis should include model-based tree fitting, biological plausibility checks, sensitivity analysis, and comparison with established recombination screens.

## 13. Software verification and reproducibility

The implementation contains unit tests for complete one-SPR neighborhood enumeration, canonical topology identity under Newick rerooting and internal labels, forward and inverse execution of every recorded move, recovery of a two-SPR boundary script, movement of the inferred master away from its seed, proposal-independent overlap windows, and the non-binding nature of proposal-derived segment/pair/triplet windows. Benchmark utilities report alignment-length-weighted site-averaged unrooted Robinson–Foulds distance [6], exact-local-tree fraction, breakpoint precision/recall within a declared tolerance, inferred edit complexity, and wall time.

For reproducible reporting, analyses should record the EvoOnline commit, FastTree version, all MosaicSPR parameters, whether the fastest FastTree option was used, the proposal and draft-tree tables, the search certificate, and the exported local-tree and SPR-edit files.

## References

1. Kosakovsky Pond SL, Posada D, Gravenor MB, Woelk CH, Frost SDW. Automated phylogenetic detection of recombination using a genetic algorithm. *Molecular Biology and Evolution*. 2006;23:1891–1901. doi:10.1093/molbev/msl051.
2. Kosakovsky Pond SL, Posada D, Gravenor MB, Woelk CH, Frost SDW. GARD: a genetic algorithm for recombination detection. *Bioinformatics*. 2006;22:3096–3098.
3. Allen BL, Steel M. Subtree transfer operations and their induced metrics on evolutionary trees. *Annals of Combinatorics*. 2001;5:1–15. doi:10.1007/s00026-001-8006-8.
4. Price MN, Dehal PS, Arkin AP. FastTree 2—approximately maximum-likelihood trees for large alignments. *PLoS ONE*. 2010;5:e9490. doi:10.1371/journal.pone.0009490.
5. Fitch WM. Toward defining the course of evolution: minimum change for a specific tree topology. *Systematic Zoology*. 1971;20:406–416. doi:10.1093/sysbio/20.4.406.
6. Robinson DF, Foulds LR. Comparison of phylogenetic trees. *Mathematical Biosciences*. 1981;53:131–147. doi:10.1016/0025-5564(81)90043-2.
7. Martin D, Rybicki E. RDP: detection of recombination amongst aligned sequences. *Bioinformatics*. 2000;16:562–563. doi:10.1093/bioinformatics/16.6.562.

## Implementation note

This manuscript describes the current EvoOnline implementation, not an idealized algorithm. In particular, the pair-covered triplet sample, fixed HMM emission initialization, rate-slice marginalization, overlap safety bank, mixed seed-distance screen, negative-column retention, square-root master medoid, finite patience, and capped alternative-script count are intentional production choices and should be reported rather than omitted from a methods description.
