# EvoOnline simulators

The `simulator` model is a browser-worker implementation of three composable
simulation layers. It has no server dependency and records every stochastic
draw from one 32-bit seed.

## 1. Sampled coalescent trees

At backwards time `t`, with `k` active ancestral lineages, EvoOnline uses the
competing hazards

```text
lambda_coal(t)   = choose(k, 2) / (ploidy * Ne(t))
lambda_sample(t) = s(t).
```

`ploidy=1` treats `Ne` as a haploid gene-copy effective size; `ploidy=2`
treats it as a diploid-individual effective size. The next event is sampled by
drawing one unit exponential variate and inverting the *sum of the integrated
hazards*. Event identity is then drawn from the instantaneous coalescent and
sampling hazards at that time. Population and sampling curves are evaluated by
shape-preserving cubic Hermite interpolation (PCHIP), either on their natural
or log scale, and integrated on a dense Simpson grid.

This deliberately replaces the current `MolecularEvolution.jl`
`inhomo_poisson_next_sample` stepping formula. That routine carries a residual
unit-rate integrated-hazard clock but compares it directly with a time width,
and advances by `unit_wait * delta`; the dimensionally consistent expressions
are `unit_wait > rate * delta` and `unit_wait / rate`. EvoOnline instead avoids
that bookkeeping entirely through integrated-hazard inversion.

The implementation follows the varying-population coalescent of Griffiths and
Tavaré and the standard inhomogeneous-Poisson preferential-sampling setup. A
requested exact tip count is obtained by stopping the sampling point process
after its Nth sample.

## 2. Codon evolution

The standard engine is an exact Gillespie MG94 process. Its default is **not a
uniform nucleotide model**: the six GTR exchangeabilities and three F3x4 rows
are the empirical influenza demonstration values in
`CodonMolecularEvolution.jl`. The neutral generator is scaled to one expected
substitution per codon-time unit. Synonymous rate `alpha` and nonsynonymous
multiplier `omega` may be fixed or independent Gamma draws across sites.

SCUFF follows the piecewise-OU Halpern–Bruno construction in the attached
manuscript and upstream Julia implementation. At Poisson fitness-jump rate
`lambda`,

```text
rho = exp(-theta / lambda)
f'  = rho f + sigma sqrt(1-rho^2) epsilon,
```

and mutation fixation is multiplied by `Delta f / (1-exp(-Delta f))`, with a
stable local series near zero. Fitness jumps and substitutions are sampled
from one joint Gillespie clock. The results UI also propagates the complete
codon probability vector along a sampled fitness trajectory and shows fitness,
amino-acid occupancy, and expected dN/dS diagnostics.

## 3. Branch-interior recombination

Recombination events are Poisson points over total carrier-tree lineage time.
Both recipient and donor edges must exist at the same continuous event age.
Each event applies a time-preserving rooted SPR to the genomic intervals drawn
for that event. Available breakpoint processes are one crossover, one imported
tract, a few alternating switches, and many template switches. Breakpoint
intensity may be uniform or a baseline plus Gaussian hotspots.

Multiple active events are composed on a persistent mutable carrier genealogy;
node identities are never compacted between edits. An optional larger carrier
tree is simulated first and then pruned to observed tips. Consequently, a
lineage absent from the final sample can still be the donor of ancestry retained
by an observed sequence.

## Outputs

Each replicate contains the observed master time tree, optional hidden carrier
tree, complete local-tree partition, event/tract truth, realized site
parameters, FASTA alignment, and diversity diagnostics. The web UI exports
individual artifacts or one dependency-free STORE-format ZIP, can load any
replicate into the ordinary EvoOnline workspace, and can batch FUBAR, FAME, or
FLAVOR over selected replicates. Known local trees use the same generic
fixed-relative regional-tree contract as inferred recombination analyses.

## Primary references

- Griffiths RC, Tavaré S. *Sampling theory for neutral alleles in a varying environment*. Phil Trans R Soc B (1994).
- Drummond AJ et al. *Estimating mutation parameters, population history and genealogy simultaneously from temporally spaced sequence data*. Mol Biol Evol (2000).
- Karcher MD et al. *Quantifying and mitigating the effect of preferential sampling on phylodynamic inference*. PLoS Comput Biol (2016).
- Hudson RR. *Properties of a neutral allele model with intragenic recombination*. Theor Popul Biol (1983).
- Wiuf C. *Recombination hotspots in a population genetic model*. Genetics (2003).
- Sadiq H et al. SCUFF manuscript and `CodonMolecularEvolution.jl` implementation supplied with this task.
