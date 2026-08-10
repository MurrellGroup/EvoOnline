#!/usr/bin/env julia

using CodonMolecularEvolution
using MolecularEvolution
using FASTX
using DelimitedFiles

length(ARGS) >= 3 || error("usage: generate-julia-reference.jl alignment.fasta tree.nex output-prefix [foreground-grid] [background-grid]")
fasta_path, tree_path, prefix = ARGS[1:3]
foreground_grid = length(ARGS) >= 4 ? parse(Int, ARGS[4]) : 6
background_grid = length(ARGS) >= 5 ? parse(Int, ARGS[5]) : 4

seqnames, seqs = read_fasta(fasta_path)
if endswith(lowercase(tree_path), ".nex") || endswith(lowercase(tree_path), ".nexus")
    treestring, tags, _ = import_colored_figtree_nexus_as_tagged_tree(tree_path)
else
    treestring, tags = CodonMolecularEvolution.import_labeled_phylotree_newick(tree_path)
end

tree, tags, _, _ = CodonMolecularEvolution.difFUBAR_init(
    "", treestring, tags; exports=false, verbosity=0,
)
code = MolecularEvolution.universal_code
tree, LL, alpha, beta, GTRmat, F3x4, equilibrium = CodonMolecularEvolution.difFUBAR_global_fit_2steps(
    seqnames,
    seqs,
    tree,
    CodonMolecularEvolution.generate_tag_stripper(tags),
    code;
    verbosity=0,
)

log_matrix, categories, alpha_grid, omega_grid, background_omega_grid, parameter_names, has_background, group_count, site_count =
    CodonMolecularEvolution.gridprep(
        tree,
        tags;
        verbosity=0,
        foreground_grid=foreground_grid,
        background_grid=background_grid,
    )

conditionals, log_matrix, categories, _, _, _ = CodonMolecularEvolution.difFUBAR_grid(
    CodonMolecularEvolution.difFUBARBaseline(),
    tree,
    tags,
    GTRmat,
    F3x4,
    code,
    log_matrix,
    categories,
    alpha_grid,
    omega_grid,
    background_omega_grid,
    parameter_names,
    has_background,
    group_count,
    site_count,
    1;
    verbosity=0,
    foreground_grid=foreground_grid,
    background_grid=background_grid,
)

mkpath(dirname(abspath(prefix)))
gtr_rates = [GTRmat[i, j] for i in 1:4 for j in (i + 1):4]
f3x4_row_major = [F3x4[i, j] for i in 1:3 for j in 1:4]
model = vcat([alpha, beta, LL], gtr_rates, f3x4_row_major, equilibrium)
writedlm(prefix * ".model.tsv", permutedims(model), '\t')
writedlm(prefix * ".categories.tsv", reduce(hcat, categories)', '\t')
writedlm(prefix * ".log-likelihoods.tsv", log_matrix, '\t')
writedlm(prefix * ".conditionals.tsv", conditionals, '\t')
println("Wrote Julia reference files with $(length(categories)) categories and $(site_count) sites to $(prefix).*.tsv")
