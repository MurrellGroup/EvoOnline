# JEMSPR

JEMSPR is EvoOnline's independent implementation of joint latent-master and coherent overlapping recombination-event inference.

It consumes only an aligned nucleotide FASTA. It does **not** consume a FastTree topology or branch length, FSART/MosaicSPR result, uploaded tree, or precomputed breakpoint proposal set. By default, FastTree is called once in an independent preliminary calibration solely to estimate a fixed whole-alignment GTR matrix; the matrix is consumed only after network search, and every other likelihood operation is implemented here.

The numerical workflow is:

1. ambiguity-aware nucleotide masks and exact Fitch or Sankoff emissions;
2. internal whole-alignment and data-independent dyadic-window neighbor joining;
3. multiple inferred root placements;
4. a verified sparse rooted-SPR graph with exact joint master/path dynamic programming;
5. linear-genome single-interval pricing of omitted rooted topologies;
6. a joint beam seeded by the top distinct masters across every root start;
7. compilation of residual rooted-SPR moves into binary switching DAG reticulations;
8. exact active-mask decoding up to a selected overlap cap;
9. donor–recipient equality plus strict-ancestry hard lazy cuts;
10. compilation of displayed branches into shared atomic switching-DAG edge paths;
11. custom fixed-GTR/discrete-Gamma pruning with analytic all-edge gradients;
12. coherent linked branch-length L-BFGS and optional likelihood/Viterbi path refinement.

The path graph and outer network beam are budgeted searches. Fixed-graph master/path inference and fixed-network overlap-mask inference are exact within their finite candidate universes. Result metadata states this distinction explicitly.

## Linked branch lengths

FastTree returns only four equilibrium frequencies and six GTR exchangeabilities from its global alignment fit. Its topology, lengths, CAT/Gamma parameters, likelihood, and support values are discarded. EvoOnline builds and exponentiates the fixed reversible generator, profiles its own discrete-Gamma shape, performs every Felsenstein inside/outside pass, and optimizes the linked edge parameters itself.

Every non-horizontal switching-network edge has one length. A displayed-tree branch is the sum of the atomic edges in the unary path produced when that display is contracted. The alternate-parent recombination edge is fixed at zero, while the source and donor edge subdivisions remain explicit, allowing the attachment/break positions to be estimated without independently fitting each daughter tree. Exact duplicate incidence columns are reported as sums, and the arbitrary reversible degree-two root uses an explicit zero/sum gauge.

The numerical code lives in [`packages/phylo-likelihood`](../../packages/phylo-likelihood). Its linked-tree compiler, HMM, and branch optimizer are model-independent; the optimizer accepts a generic differentiable likelihood contract so a future codon/FUBAR engine can use the same SPR structure and length constraints.

## Benchmark

The seeded benchmark constructs a rank-feasible four-reticulation switching DAG with crossing, nested, recurrent, simultaneous, and edge-censored events; simulates exact GTR sequence evolution with realistic rate heterogeneity; and reports nucleotide-weighted site-averaged unrooted RF, exact-tree span, ordered breakpoint matching, event complexity, fixed-planted-network diagnostics, runtime, and null false calls.

```bash
npm run benchmark:jemspr -- --quick --replicates 3
```

The measured report and raw outputs are under [`benchmarks/results`](benchmarks/results/BENCHMARK_REPORT.md). The current defaults remain unchanged: the tested balanced penalty profile was promising, but three null replicates are insufficient to calibrate a production default.
