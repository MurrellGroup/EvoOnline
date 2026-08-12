import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WasmBackend } from "../src/backends/wasm.js";
import { parseFasta } from "../src/io/fasta.js";
import { parseTaggedNewick } from "../src/io/newick.js";
import {
  CONTEXT_DEPENDENT_GENETIC_CODE_IDS,
  GENETIC_CODES,
  MISSING_CODON,
  buildModelBank,
  codonEquilibriumFromF3x4,
  countF3x4,
  encodeCodonTips,
  getGeneticCode,
  translateCodon,
} from "../src/model/genetic-code.js";
import { createDifFUBARGrid } from "../src/model/grid.js";
import { compileTree } from "../src/tree/compiler.js";

function synonymousEdge(codeId: 1 | 12, fromCodon: string, toCodon: string): number {
  const code = getGeneticCode(codeId);
  const from = code.stateByCodon.get(fromCodon)!;
  const to = code.stateByCodon.get(toCodon)!;
  for (let neighbor = 0; neighbor < code.topology.count[from]!; neighbor += 1) {
    const offset = from * code.topology.maxNeighbors + neighbor;
    if (code.topology.index[offset] === to) return code.topology.synonymous[offset]!;
  }
  throw new Error(`${fromCodon} -> ${toCodon} is not a single-nucleotide edge.`);
}

describe("NCBI genetic-code registry", () => {
  it("defines every DNA codon exactly once for 24 unambiguous current tables", () => {
    assert.equal(GENETIC_CODES.length, 24);
    assert.deepEqual(CONTEXT_DEPENDENT_GENETIC_CODE_IDS, [27, 28, 31]);
    assert.equal(new Set(GENETIC_CODES.map((code) => code.id)).size, GENETIC_CODES.length);
    for (const code of GENETIC_CODES) {
      assert.equal(Object.keys(code.aminoAcids).length, 64, `table ${code.id}`);
      assert.equal(code.senseCodons.length + code.stopCodons.length, 64, `table ${code.id}`);
      assert.equal(code.stateByCodon.size, code.senseCodons.length, `table ${code.id}`);
      assert.ok(code.senseCodons.length >= 60 && code.senseCodons.length <= 63, `table ${code.id}`);
    }
  });

  it("implements representative mitochondrial, ciliate, and yeast reassignments", () => {
    assert.equal(translateCodon("TGA", 1), "*");
    assert.equal(translateCodon("TGA", 2), "W");
    assert.equal(translateCodon("AGA", 2), "*");
    assert.equal(translateCodon("ATA", 2), "M");
    assert.equal(translateCodon("TAA", 6), "Q");
    assert.equal(translateCodon("TAG", 6), "Q");
    assert.equal(translateCodon("CTG", 12), "S");
    assert.equal(synonymousEdge(1, "CTA", "CTG"), 1);
    assert.equal(synonymousEdge(12, "CTA", "CTG"), 0);
  });

  it("rejects context-dependent termination tables instead of silently mis-modelling them", () => {
    for (const id of CONTEXT_DEPENDENT_GENETIC_CODE_IDS) {
      assert.throws(() => getGeneticCode(id), /sense or STOP depending on context/);
    }
  });

  it("uses each table's dynamic state order for tips, equilibrium, and WASM likelihoods", async () => {
    const tree = parseTaggedNewick("(a{G1}:0,b{G2}:0);");
    const grid = createDifFUBARGrid(false, 1, 1);
    for (const [codeId, codon, expectedStates] of [[2, "TGA", 60], [6, "TAA", 63]] as const) {
      const alignment = parseFasta(`>a\n${codon}\n>b\n${codon}\n`);
      const f3x4 = countF3x4(alignment);
      const tips = encodeCodonTips(alignment, tree, codeId);
      const equilibrium = codonEquilibriumFromF3x4(f3x4, codeId);
      const models = buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4, codeId);
      assert.notEqual(tips[0], MISSING_CODON);
      assert.equal(equilibrium.length, expectedStates);
      assert.equal(models.stateCount, expectedStates);
      const likelihood = await new WasmBackend().evaluate({
        tree: compileTree(tree),
        tipStates: tips,
        siteCount: 1,
        grid,
        models,
        equilibrium,
      });
      for (const value of likelihood.logLikelihoods) assert.ok(Math.abs(value) < 1e-12);
    }

    const vertebrate = parseFasta(">a\nAGA\n>b\nTGA\n");
    const encoded = encodeCodonTips(vertebrate, tree, 2);
    assert.equal(encoded[0], MISSING_CODON);
    assert.notEqual(encoded[1], MISSING_CODON);
  });
});
