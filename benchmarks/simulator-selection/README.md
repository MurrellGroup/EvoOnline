# Simulator → selection benchmark

Run the complete reproducible benchmark from the repository root:

```bash
npm run benchmark:simulator-selection
```

The harness uses EvoOnline's production simulator and selection-analysis APIs.
It writes seeded FASTA/Newick datasets, complete simulator truth, method CSVs,
SVG visual audits, runtime measurements, machine-readable summaries, and a
human-readable report to `benchmarks/simulator-selection/results/`.

The benchmark contains:

1. an exactly neutral MG94 calibration control;
2. a continuously heterogeneous MG94 recovery experiment;
3. a branch-interior recombination experiment comparing exact regional trees
   with a deliberately misspecified single master tree; and
4. a calm-versus-rapid SCUFF block stress test for FLAVOR.

FAME and FLAVOR are tested on constant-across-branch MG94 truth as a deliberate
model-mismatch test. Their episodic-positive event is not relabeled as ordinary
FUBAR truth in the report.
