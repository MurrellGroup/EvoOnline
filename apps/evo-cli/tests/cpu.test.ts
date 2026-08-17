import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configureAnalysisWorkers, runSelectionMethodIsolated } from "../src/analysis-worker.js";
import { allocateCpuBudget, mapWithConcurrency, normalizeMaxCpus } from "../src/cpu.js";
import { createFastTreeEvaluator } from "../src/fasttree.js";

test("CPU budgets divide nested work without oversubscribing", () => {
  assert.deepEqual(allocateCpuBudget(8, 3), { parallelism: 3, cpusPerTask: 2 });
  assert.deepEqual(allocateCpuBudget(2, 7), { parallelism: 2, cpusPerTask: 1 });
  assert.equal(normalizeMaxCpus(99, 6), 6);
  assert.equal(normalizeMaxCpus(0, 6), 1);
});

test("bounded task scheduling reaches the requested concurrency", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  assert.equal(peak, 3);
});

test("independent FastTree fits run concurrently and reduce wall time", async () => {
  const binary = fileURLToPath(new URL("./fixtures/mock-fasttree.mjs", import.meta.url));
  const alignment = [
    ">A", "ACGTACGTACGTACGTACGTACGT",
    ">B", "ACGTACGTACGTACGTACGTACGA",
    ">C", "ACGTACGTACGTACGTACGTTCGA",
  ].join("\n");
  const ranges = [[1, 6], [7, 12], [13, 18], [19, 24]] as const;
  const previousDelay = process.env.MOCK_FASTTREE_DELAY_MS;
  process.env.MOCK_FASTTREE_DELAY_MS = "100";
  try {
    const measure = async (concurrency: number): Promise<{ readonly elapsed: number; readonly peak: number }> => {
      const evaluator = createFastTreeEvaluator({ binary, label: "mock" }, alignment, true, concurrency, 1);
      const started = performance.now();
      await Promise.all(ranges.map(([start, end]) => evaluator.evaluate(start, end)));
      return { elapsed: performance.now() - started, peak: evaluator.diagnostics().peakConcurrentFits };
    };
    const serial = await measure(1);
    const parallel = await measure(2);
    assert.equal(serial.peak, 1);
    assert.equal(parallel.peak, 2);
    assert.ok(parallel.elapsed < serial.elapsed * 0.8, `expected a speedup; serial=${serial.elapsed.toFixed(1)}ms parallel=${parallel.elapsed.toFixed(1)}ms`);
  } finally {
    if (previousDelay === undefined) delete process.env.MOCK_FASTTREE_DELAY_MS;
    else process.env.MOCK_FASTTREE_DELAY_MS = previousDelay;
  }
});

test("external analysis worker sidecar loads its explicitly packaged WASM binary", async () => {
  configureAnalysisWorkers(
    fileURLToPath(new URL("../src/analysis-node.worker.ts", import.meta.url)),
    fileURLToPath(new URL("../../../models/diffubar/dist/backends/wasm-node.worker.js", import.meta.url)),
    fileURLToPath(new URL("../../../models/diffubar/src/wasm/diffubar.wasm", import.meta.url)),
  );
  const alignment = await readFile(new URL("./fixtures/smoke.fasta", import.meta.url), "utf8");
  const result = await runSelectionMethodIsolated(
    "fubar",
    alignment,
    "((A:0.1,B:0.1):0.1,(C:0.1,(D:0.1,E:0.1):0.1):0.1);",
    { gridPoints: 2, iterations: 4, burnin: 1, posteriorThreshold: 0.95 },
    () => undefined,
    undefined,
    2,
  ) as { readonly csv?: string };
  assert.match(result.csv ?? "", /site/i);
});
