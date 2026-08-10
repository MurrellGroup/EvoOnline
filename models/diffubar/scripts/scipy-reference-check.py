"""Independent SciPy check of the f64 WASM likelihood fixture.

This is intentionally outside the default npm test suite because SciPy is not
a JavaScript dependency. It checks sparse uniformization against dense expm.
"""

from itertools import product
from math import log

import numpy as np
from scipy.linalg import expm


AA = {
    "TTT": "F", "TTC": "F", "TTA": "L", "TTG": "L", "TCT": "S", "TCC": "S", "TCA": "S", "TCG": "S",
    "TAT": "Y", "TAC": "Y", "TAA": "*", "TAG": "*", "TGT": "C", "TGC": "C", "TGA": "*", "TGG": "W",
    "CTT": "L", "CTC": "L", "CTA": "L", "CTG": "L", "CCT": "P", "CCC": "P", "CCA": "P", "CCG": "P",
    "CAT": "H", "CAC": "H", "CAA": "Q", "CAG": "Q", "CGT": "R", "CGC": "R", "CGA": "R", "CGG": "R",
    "ATT": "I", "ATC": "I", "ATA": "I", "ATG": "M", "ACT": "T", "ACC": "T", "ACA": "T", "ACG": "T",
    "AAT": "N", "AAC": "N", "AAA": "K", "AAG": "K", "AGT": "S", "AGC": "S", "AGA": "R", "AGG": "R",
    "GTT": "V", "GTC": "V", "GTA": "V", "GTG": "V", "GCT": "A", "GCC": "A", "GCA": "A", "GCG": "A",
    "GAT": "D", "GAC": "D", "GAA": "E", "GAG": "E", "GGT": "G", "GGC": "G", "GGA": "G", "GGG": "G",
}
BASE_INDEX = {base: index for index, base in enumerate("ACGT")}
CODONS = sorted("".join(chars) for chars in product("ACGT", repeat=3) if AA["".join(chars)] != "*")
STATE = {codon: index for index, codon in enumerate(CODONS)}


def q_matrix(alpha: float, omega: float) -> np.ndarray:
    q = np.zeros((61, 61), dtype=np.float64)
    for i, source in enumerate(CODONS):
        for j, destination in enumerate(CODONS):
            differences = [p for p in range(3) if source[p] != destination[p]]
            if len(differences) != 1:
                continue
            position = differences[0]
            rate = alpha if AA[source] == AA[destination] else alpha * omega
            q[i, j] = rate * 0.25  # GTR exchangeability=1 and F3x4 destination frequency=.25
        q[i, i] = -np.sum(q[i])
    return q


categories = [
    (0.01, 0.01, 0.01), (0.01, 0.01, 1.0), (0.01, 1.0, 0.01), (0.01, 1.0, 1.0),
    (1.0, 0.01, 0.01), (1.0, 0.01, 1.0), (1.0, 1.0, 0.01), (1.0, 1.0, 1.0),
]
branches = [("AAA", 0.1, 0), ("CCC", 0.2, 0), ("GGG", 0.15, 1), ("TTT", 0.05, 1)]
expected = np.array([
    -101.25145623236678, -85.40632525546066, -84.42243432906899, -73.6126859693708,
    -60.05609652391976, -44.3999213370479, -43.49931944716555, -32.94870278607026,
])

observed = []
for alpha, omega1, omega2 in categories:
    root = np.ones(61)
    for codon, length, group in branches:
        omega = omega1 if group == 0 else omega2
        root *= expm(q_matrix(alpha, omega) * length)[:, STATE[codon]]
    observed.append(log(np.dot(np.full(61, 1 / 61), root)))
observed = np.asarray(observed)
np.testing.assert_allclose(observed, expected, rtol=0, atol=2e-12)
print(f"SciPy dense-expm parity passed; max |Δ|={np.max(np.abs(observed - expected)):.3g}")
