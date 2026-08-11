import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.PORT = "0";
const { server } = await import("../src/server.js");
if (!server.listening) await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string") throw new Error("API did not expose a TCP address.");
const hostname = address.family === "IPv6" ? "::1" : "127.0.0.1";

async function requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname,
      port: address.port,
      path,
      method,
      headers: payload === undefined ? {} : {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        try {
          resolve({
            status: incoming.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

test.after(() => new Promise<void>((resolve, reject) => {
  server.close((error) => error === undefined ? resolve() : reject(error));
}));

test("lists models and completes a small DifFUBAR job", async () => {
  const health = await requestJson("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");

  const models = await requestJson("GET", "/v1/models");
  assert.equal(models.status, 200);
  assert.equal(models.body.models[0].id, "diffubar");
  assert.ok(models.body.models.some((model: { id: string }) => model.id === "fubar"));

  const alignment = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
  const tree = await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8");
  const submitted = await requestJson("POST", "/v1/jobs", {
    modelId: "diffubar",
    alignment: { name: "demo.fasta", text: alignment },
    tree: { name: "demo.nwk", text: tree },
    parameters: { foregroundGrid: 2, backgroundGrid: 2, iterations: 250, burnin: 50, seed: 7 },
  });
  assert.equal(submitted.status, 202);

  let job = submitted.body;
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = (await requestJson("GET", `/v1/jobs/${submitted.body.id}`)).body;
  }
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.result.sites.length, 12);
  assert.equal(job.result.backend, "wasm");
});

test("completes a small untagged FUBAR job with separate optional FEL results", async () => {
  const alignment = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
  const taggedTree = await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8");
  const tree = taggedTree.replaceAll(/\{[^}]+\}/g, "");
  const submitted = await requestJson("POST", "/v1/jobs", {
    modelId: "fubar",
    alignment: { name: "demo.fasta", text: alignment },
    tree: { name: "demo.nwk", text: tree },
    parameters: { gridPoints: 4, iterations: 100, posteriorThreshold: 0.8, approximateFel: true },
  });
  assert.equal(submitted.status, 202);
  let job = submitted.body;
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = (await requestJson("GET", `/v1/jobs/${submitted.body.id}`)).body;
  }
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.result.sites.length, 12);
  assert.ok(Array.isArray(job.result.positiveSites));
  assert.ok(Array.isArray(job.result.purifyingSites));
  assert.match(job.result.csv, /P\(beta > alpha\)/);
  assert.equal(job.result.approximateFel.sites.length, 12);
  assert.equal(job.result.approximateFel.gridSize, 4);
  assert.equal(job.result.approximateFel.relativeLogLikelihoods.length, 12 * 16);
  assert.match(job.result.approximateFel.csv, /FEL p-value \(positive\)/);
  assert.doesNotMatch(job.result.csv, /FEL p-value/);

  const gibbsSubmitted = await requestJson("POST", "/v1/jobs", {
    modelId: "fubar",
    alignment: { name: "demo.fasta", text: alignment },
    tree: { name: "demo.nwk", text: tree },
    parameters: {
      gridPoints: 4,
      inferenceMethod: "gibbs",
      iterations: 200,
      burnin: 40,
      seed: 19,
      posteriorThreshold: 0.8,
    },
  });
  assert.equal(gibbsSubmitted.status, 202);
  let gibbsJob = gibbsSubmitted.body;
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(gibbsJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    gibbsJob = (await requestJson("GET", `/v1/jobs/${gibbsSubmitted.body.id}`)).body;
  }
  assert.equal(gibbsJob.status, "succeeded", gibbsJob.error);
  assert.equal(gibbsJob.result.diagnostics.inferenceMethod, "gibbs");
  assert.equal(gibbsJob.result.diagnostics.inferenceIterations, 200);
  assert.equal(gibbsJob.result.diagnostics.inferenceBurnin, 40);
});
