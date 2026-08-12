# CladeShift

CladeShift is an **exploratory, unvalidated EvoOnline model** for a question that
ordinary site and branch tests do not directly answer:

> At which codon did selective stringency change persistently in one previously
> unknown descendant clade, and which branch initiated that change?

It needs an untagged codon tree. The null at a site is the ordinary FUBAR
alpha-beta process on every edge. For candidate initiating edge `e`, that edge
and every edge below it instead use

```text
omega_shifted = omega^K
```

with a fixed log-symmetric grid of `K` values. `K < 1` contracts purifying and
positive omega values toward one (relaxation); `K > 1` pushes them away from one
(intensification). Expansion is saturated at omega 50 for numerical and
identifiability reasons; baseline categories already beyond that boundary are
left unchanged rather than moved in the wrong direction.

## Evidence model

CladeShift does not maximize independently over a large collection of branches
and K values. Its alternative prior mass is split equally between relaxation
and intensification, then uniformly over the eligible initiating branches and
the fixed K states within that direction. The no-shift and shift models receive
prior mass `1 - p_shift` and `p_shift`. Reported probabilities are therefore
fixed-prior empirical-Bayes posteriors, not calibrated p-values.

The baseline FUBAR posterior `q_s(alpha, beta)` supplies the nuisance-rate
integration through the exact identity

```text
BF_s(e, K) = E_q_s [ L_s(e, K, alpha, beta) / L_s(null, alpha, beta) ].
```

For speed, baseline categories are retained in descending posterior order until
the requested mass target is reached or the hard component cap is exhausted,
then renormalized. The retained count and mass are reported, including the
minimum and mean over the alignment. Raising `posteriorComponents` or
`posteriorMassTarget` reduces this only approximation.

## All-clade likelihood trick

A naive scan reprunes the tree for every candidate branch. CladeShift instead
does, for each retained baseline category:

1. one ordinary upward/downward pass under the null, producing the exact
   outside context at every edge;
2. one all-shifted upward pass for each K, producing the shifted inside message
   for every descendant subtree at once;
3. one dot product between the null outside context and shifted inside message
   at each candidate edge.

Thus every candidate clade is scored exactly for the retained category with
`O((1 + number_of_K_states) * tree_size)` message work, rather than
`O(number_of_candidates * number_of_K_states * tree_size)`. Codon sites are
distributed across the persistent parallel-WASM worker pool. The kernel is
tested against a complete two-class tree reprune for both internal and terminal
candidate edges at f64 precision.

## Outputs

- per-codon posterior probability of any shift, relaxation, and intensification;
- integrated and direction-specific log Bayes factors;
- posterior over initiating branches and K states;
- branch summaries of expected shifted, relaxed, and intensified codon counts;
- linked editable SVG codon and phylogeny views;
- site and branch CSVs;
- optional reference/profile and PDB/mmCIF structure mapping.

## Scientific status

This implementation is deliberately labelled exploratory throughout the UI and
result diagnostics. It has numerical identity tests, but it has **not** been
simulation-calibrated for power, false positives, prior sensitivity, tree error,
recombination, or posterior-compression error. It should be treated as a method
prototype until those studies are complete. RELAX inspired the `omega^K`
parameterization, but unlike RELAX and Contrast-FEL this scan does not require a
predefined test branch set; unlike sequence-wide amino-acid fitness shift scans,
its target is a codon-specific change in dN/dS stringency.
