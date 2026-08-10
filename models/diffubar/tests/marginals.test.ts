import assert from "node:assert/strict";
import test from "node:test";
import { createDifFUBARGrid } from "../src/model/grid.js";
import { collapsePosteriorMarginals } from "../src/posterior/marginals.js";

test("posterior category counts collapse into normalized site marginals", () => {
  const grid = createDifFUBARGrid(false, 1, 1);
  const siteCount = 2;
  const allocations = new Uint32Array(grid.categoryCount * siteCount);
  allocations[0] = 3;
  allocations[1] = 1;
  allocations[(grid.categoryCount - 1) * siteCount] = 1;
  allocations[(grid.categoryCount - 1) * siteCount + 1] = 3;

  const marginals = collapsePosteriorMarginals(allocations, 4, grid, siteCount);
  assert.equal(marginals.alpha.length, siteCount * grid.alpha.length);
  assert.equal(marginals.omega1.length, siteCount * grid.omega.length);
  for (let site = 0; site < siteCount; site += 1) {
    const alphaTotal = marginals.alpha
      .slice(site * grid.alpha.length, (site + 1) * grid.alpha.length)
      .reduce((sum, value) => sum + value, 0);
    const omega1Total = marginals.omega1
      .slice(site * grid.omega.length, (site + 1) * grid.omega.length)
      .reduce((sum, value) => sum + value, 0);
    const omega2Total = marginals.omega2
      .slice(site * grid.omega.length, (site + 1) * grid.omega.length)
      .reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(alphaTotal - 1) < 1e-7);
    assert.ok(Math.abs(omega1Total - 1) < 1e-7);
    assert.ok(Math.abs(omega2Total - 1) < 1e-7);
  }
  assert.equal(marginals.alpha[0], 0.75);
  assert.equal(marginals.alpha[grid.alpha.length - 1], 0.25);
  assert.equal(marginals.alpha[grid.alpha.length], 0.25);
  assert.equal(marginals.alpha[marginals.alpha.length - 1], 0.75);
});
