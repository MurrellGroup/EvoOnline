# Genetic codes

Every EvoOnline codon model exposes the same **Genetic code** selector. The choice is recorded in the fitted model and result diagnostics and is used consistently for:

- sense/stop classification and the 60–63-state likelihood space;
- synonymous/nonsynonymous MG94 edges and F3x4 equilibrium normalization;
- DifFUBAR, FUBAR/approximate FEL, BS-REL, FAME, FLAVOR, Glamma, and CladeShift;
- browser WebGPU, serial/parallel WASM, and API execution; and
- amino-acid profiles, optional coding references, and PDB/mmCIF structure mapping.

The registry follows the [NCBI genetic-code tables](https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi) (updated 23 September 2024). EvoOnline supports every current table whose codons have one unambiguous translation:

| NCBI table | Name |
|---:|---|
| 1 | Standard |
| 2 | Vertebrate mitochondrial |
| 3 | Yeast mitochondrial |
| 4 | Mold/protozoan/coelenterate mitochondrial and Mycoplasma/Spiroplasma |
| 5 | Invertebrate mitochondrial |
| 6 | Ciliate, Dasycladacean and Hexamita nuclear |
| 9 | Echinoderm and flatworm mitochondrial |
| 10 | Euplotid nuclear |
| 11 | Bacterial, archaeal and plant plastid |
| 12 | Alternative yeast nuclear |
| 13 | Ascidian mitochondrial |
| 14 | Alternative flatworm mitochondrial |
| 15 | Blepharisma nuclear |
| 16 | Chlorophycean mitochondrial |
| 21 | Trematode mitochondrial |
| 22 | Scenedesmus obliquus mitochondrial |
| 23 | Thraustochytrium mitochondrial |
| 24 | Rhabdopleuridae mitochondrial |
| 25 | Candidate Division SR1 and Gracilibacteria |
| 26 | Pachysolen tannophilus nuclear |
| 29 | Mesodinium nuclear |
| 30 | Peritrich nuclear |
| 32 | Balanophoraceae plastid |
| 33 | Cephalodiscidae mitochondrial UAA-Tyr |

Tables 27, 28, and 31 are intentionally rejected. In those tables, at least one codon can be either an amino acid or termination signal depending on context. A stationary MG94 CTMC requires a single fixed state meaning for each codon, so silently treating those tables as ordinary translation maps would be scientifically incorrect. Initiation-only differences do not affect the codon substitution process and therefore do not create separate state spaces.

Table 1 remains the default and retains the original lexically sorted 61-state ordering, preserving existing saved data and numerical parity. A saved fitted model cannot be reused under a different code: EvoOnline checks the code ID and equilibrium-vector dimension before likelihood evaluation.
