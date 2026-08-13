# Linked phylogenetic likelihood primitives

This MIT package contains the reusable numerical layer for fixed-topology tree families whose branch lengths are sparse sums of shared atomic parameters.

It currently provides:

- validated reversible four-state GTR construction and a symmetric eigensystem transition/derivative evaluator;
- binary displayed-tree compilation with an arbitrary list of atomic edge ids above every node;
- IUPAC-aware site-pattern compression;
- scaled Felsenstein pruning plus outside messages and analytic gradients for all atomic lengths in one pass;
- a model-agnostic `DifferentiableLinkedLikelihood` contract and log-length L-BFGS optimizer;
- exact dense forward/backward, posterior, switching-posterior, and Viterbi recursions; and
- custom equal-mass conditional-mean discrete-Gamma categories.

JEMSPR maps each displayed branch to the switching-DAG edge path that produced it. The package therefore sees only a generic sparse incidence problem: a displayed length is the sum of its atomic parameters, and its derivative is scattered back to those parameters. A future codon/FUBAR likelihood can implement `DifferentiableLinkedLikelihood` while reusing the tree structure, branch optimizer, and HMM without importing JEMSPR's topology search.

FastTree source is not included or adapted here.
