# EvoOnline recombination-tree bundles

EvoOnline uses one versioned, portable JSON container for both families of recombination result:

- **Independent regional trees** (`representation: "independent-regional-trees"`): the FSART-style case. Each interval has an independently estimated phylogeny and there is deliberately no claimed master tree or SPR relation between intervals.
- **SPR histories** (`representation: "spr-history"`): one master topology plus the event structure that implies the regional displays. JEMSPR stores its rooted switching network and linked-ML edge parameterization; MosaicSPR stores its unrooted executable edit tape.

Files use the extension `.evo-recomb.json`, the format identifier `evoonline-recombination-tree-bundle`, and `schemaVersion: 1`. They can be downloaded from a recombination result or an active codon-analysis tree card, persisted with a saved browser analysis, and imported after loading the matching codon alignment.

The machine-readable schema is [`schemas/evoonline-recombination-tree-bundle-v1.schema.json`](schemas/evoonline-recombination-tree-bundle-v1.schema.json).

## Stable top-level contract

```json
{
  "format": "evoonline-recombination-tree-bundle",
  "schemaVersion": 1,
  "representation": "independent-regional-trees",
  "sourceMethod": "fsart",
  "alignment": {
    "nucleotideSites": 3000,
    "codonSites": 1000,
    "taxa": 40,
    "coordinates": "one-based-inclusive",
    "breakpointConvention": "after-site"
  },
  "downstreamLikelihood": {
    "codonAssignment": "middle-nucleotide",
    "branchScalePolicy": "fixed-relative",
    "branchLengthSource": "segment-ml"
  },
  "codonTreeSet": { "...": "complete detector-agnostic likelihood input" },
  "regionalTrees": [
    {
      "id": "R1",
      "startCodon": 1,
      "endCodon": 400,
      "startNucleotide": 1,
      "endNucleotide": 1200,
      "tree": "((A:0.1,B:0.1):0.1,C:0.2);"
    }
  ],
  "breakpoints": [{ "afterCodon": 400, "afterNucleotide": 1200 }],
  "history": {
    "kind": "independent-regional-trees",
    "interpretation": "each-region-tree-is-an-independent-estimate"
  }
}
```

The duplicated `regionalTrees` array is for human/tool convenience. `codonTreeSet` is the canonical, complete input consumed by FUBAR, FAME, and FLAVOR. On import EvoOnline validates the latter, reconstructs the convenient regional index from it, and rejects gaps, overlaps, alignment-length mismatches, unknown branch-length policies, or unpolished JEMSPR trees.

## Independent-tree history

`history.kind` is `independent-regional-trees`. Optional `criterion` and `criterionValue` record the information criterion used to choose the FSART tree-HMM or stepwise partition. The Newicks contain the final regional branch lengths. No operation should infer an SPR history merely by measuring distances between these trees.

## SPR history

`history.kind` is `spr-history`, `interpretation` is `master-tree-plus-spr-events`, and `sprModel` identifies the retained structure:

| `sprModel` | Meaning | Retained method-specific structure |
| --- | --- | --- |
| `rooted-switching-network` | JEMSPR | Master, persistent event templates and occurrences, regional masks, switching network, temporal audit, and shared linked-ML network edges |
| `unrooted-edit-tape` | MosaicSPR | Master, regional states, derivations, and executable breakpoint edit sequences |
| `flattened-regional-projection` | Legacy fallback | Regional trees remain usable, but the original SPR event structure was not stored |

JEMSPR's `branchLinkage` is important: displayed regional branches are not independently fitted. It records the shared atomic network edges, zero-length recombination parent-choice edges, non-identifiable summed-length groups, fixed GTR matrix, rate variation, and joint log likelihood used to produce the exported regional Newicks.

## Coordinates and downstream use

All stored ranges are one-based and inclusive. A breakpoint coordinate means “after this site.” A codon crossing a nucleotide breakpoint follows the region containing its middle nucleotide. Therefore every codon is assigned once, in original order.

For downstream selection analysis:

1. the regional topology and branch lengths are fixed inputs;
2. no region may be rescaled relative to another;
3. F3×4, GTR, global codon-rate, and method-specific mixture parameters are estimated jointly across all regions; and
4. the history layer explains provenance and enables later SPR-aware operations, while the flattened `codonTreeSet` keeps the likelihood engine detector-agnostic.

The bundle deliberately does **not** contain the alignment itself. Keeping sequences separate avoids duplicating large or sensitive data and makes alignment/bundle length validation explicit on import.
