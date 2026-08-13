# JEMSPR

JEMSPR is EvoOnline's independent implementation of joint latent-master and coherent overlapping recombination-event inference.

It consumes only an aligned nucleotide FASTA. It does **not** call FastTree, FSART, MosaicSPR, an uploaded tree, or a precomputed breakpoint proposal set.

The numerical workflow is:

1. ambiguity-aware nucleotide masks and exact Fitch or Sankoff emissions;
2. internal whole-alignment and data-independent dyadic-window neighbor joining;
3. multiple inferred root placements;
4. a verified sparse rooted-SPR graph with exact joint master/path dynamic programming;
5. linear-genome single-interval pricing of omitted rooted topologies;
6. a joint beam seeded by the top distinct masters across every root start;
7. compilation of residual rooted-SPR moves into binary switching DAG reticulations;
8. exact active-mask decoding up to a selected overlap cap;
9. donor–recipient equality plus strict-ancestry hard lazy cuts.

The path graph and outer network beam are budgeted searches. Fixed-graph master/path inference and fixed-network overlap-mask inference are exact within their finite candidate universes. Result metadata states this distinction explicitly.
