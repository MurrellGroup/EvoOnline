import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDifFUBARGrid } from "../src/model/grid.js";

describe("difFUBAR grid", () => {
  it("matches the Julia default dimensions and ordering", () => {
    const withoutBackground = createDifFUBARGrid(false);
    assert.equal(withoutBackground.alpha.length, 12);
    assert.equal(withoutBackground.omega.length, 12);
    assert.equal(withoutBackground.categoryCount, 1_728);
    for (const value of withoutBackground.categories.slice(0, 3)) assert.ok(Math.abs(value - 0.01) < 1e-14);
    assert.ok(withoutBackground.categories[5]! > withoutBackground.categories[2]!);

    const withBackground = createDifFUBARGrid(true);
    assert.equal(withBackground.backgroundOmega.length, 7);
    assert.equal(withBackground.categoryCount, 12_096);
    for (const value of withBackground.categories.slice(0, 3)) assert.ok(Math.abs(value - 0.01) < 1e-14);
    assert.ok(Math.abs(withBackground.categories[3]! - 0.05) < 1e-14);
    assert.ok(withBackground.categories[7]! > withBackground.categories[3]!);
  });
});
