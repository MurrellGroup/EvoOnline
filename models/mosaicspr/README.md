# MosaicSPR

MosaicSPR is EvoOnline's separate exploratory reconstruction of an unknown master phylogeny plus explicit, breakpoint-indexed unrooted subtree-prune-regraft histories. It is not part of FSART and running either method does not run or display the other.

## Pipeline

1. Parse the aligned nucleotide FASTA with the same bounded bit-plane representation audited for FSART.
2. Optionally reuse FSART's pair-covered informative-triplet scan, local forward/backward uncertainty refinement, and hard-spaced consensus aggregation to propose topology-training regions. No triplet result is treated as a final event.
3. Always supplement the proposal-derived segment/pair/triplet family with a small overlapping local-window bank, plus a whole-alignment tree.
4. Fit those seed topologies with the existing alivibe FastTree 2.1.11 bioWASM runtime. Unresolved topologies are excluded safely.
5. Launch several unknown-master searches from the best distinct seed topologies by whole-alignment Fitch score.
6. Parse each tree as an unrooted labelled graph and enumerate complete distinct one-SPR neighborhoods. Every retained edge records an executable forward edit and inverse edit.
7. Repeatedly expand occupied and look-ahead frontier states. Every layer can compose another SPR move, so the model does not restrict a local tree to one edit from the master or permit only one alternative event at a site.
8. Score each topology at every aligned site with exact Fitch parsimony. A structural-diversity screen bounds candidate scoring, and a beam bounds retained graph growth.
9. For the current connected graph, compute all-pairs shortest SPR distances. An exact minimum-duration semi-Markov dynamic program finds the best genomic state path and permits any discovered multi-edit script at one breakpoint.
10. Alternate path decoding with an occupancy-weighted graph-medoid master update. The master is never fixed to the global FastTree or first seed.
11. Export every occupied local topology, genomic run, master-to-local derivation, breakpoint script, shortest-script multiplicity, and search iteration.

## Visualization

The first result figure maps inferred regions across the alignment and draws their implied trees underneath. Two selected regions produce a mirrored tip-to-tip tanglegram; three or more produce same-direction trees ordered jointly for maximum tip agreement. Matching taxa are connected and display-row changes are highlighted. These are the graph-state trees reached by the explicit SPR scripts, not independent post hoc segment labels. Display rerooting and child flips never change the inferred unrooted topology, branch lengths, region bounds, or event tape. The live figure exports as SVG.

The detailed panel exposes the master and any local tree, downloads Newick, lists the ordered edit tape and master-to-local paths, reports ambiguity among shortest discovered scripts, and provides the complete search audit plus JSON/CSV exports.

## Scope

The unrestricted statement describes the model space: the master is unknown, derived trees may contain composed SPR events, multiple events may be active in one region, and a boundary may require multiple edits. Searching all labelled unrooted topologies is combinatorial. The browser therefore uses bounded column generation and reports whether the final one-SPR neighborhood was completely screened; it does not claim a global optimum unless such a search is implemented later.
