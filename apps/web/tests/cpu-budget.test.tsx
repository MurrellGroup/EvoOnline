import assert from "node:assert/strict";
import test from "node:test";
import { allocateCpuBudget, clampMaxCpus, mapWithConcurrency } from "../src/lib/cpu-budget.js";

test("browser CPU budgets stay within the selected machine cap", async () => {
  assert.equal(clampMaxCpus(20, 8), 8);
  assert.equal(clampMaxCpus(0, 8), 1);
  assert.deepEqual(allocateCpuBudget(8, 3), { parallelism: 3, cpusPerTask: 2 });

  let active = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  });
  assert.equal(peak, 2);
});
