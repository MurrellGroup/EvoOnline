import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("bounded browser job fan-out starts independent work concurrently", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  let started = 0;
  const pending = mapWithConcurrency([1, 2, 3, 4], 3, async () => {
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, 3);
  assert.equal(peak, 3);
  release();
  await pending;
  assert.equal(started, 4);
});

test("alignment widget uses an independent Aioli runtime pool instead of a serial FastTree promise chain", async () => {
  const html = await readFile(new URL("../public/widgets/alivibe.html", import.meta.url), "utf8");
  assert.match(html, /Each Aioli instance owns an independent worker and virtual filesystem/);
  assert.match(html, /queueFastTreeJob\(payload, cli => scoreFastTreeSegment\(payload, cli\)\)/);
  assert.doesNotMatch(html, /fastTreeQueue\.then/);
});
