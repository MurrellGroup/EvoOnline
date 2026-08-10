import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createAlignmentArtifact, createTreeArtifact } from "@phylo-workbench/domain";
import { getServerModel, serverModelRegistry } from "./model-registry.js";

interface SubmitJobBody {
  readonly modelId: string;
  readonly alignment: { readonly name?: string; readonly text: string };
  readonly tree: { readonly name?: string; readonly text: string };
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface JobRecord {
  readonly id: string;
  readonly modelId: string;
  readonly createdAt: string;
  readonly alignmentText: string;
  readonly treeText: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly controller: AbortController;
  readonly listeners: Set<ServerResponse>;
  status: JobStatus;
  stage: string;
  fraction: number;
  error?: string;
  result?: unknown;
}

const jobs = new Map<string, JobRecord>();
const port = Number(process.env.PORT ?? 8787);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, headers({ "Content-Type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 50 * 1024 * 1024) throw new Error("Request body exceeds 50 MiB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function snapshot(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    modelId: job.modelId,
    createdAt: job.createdAt,
    status: job.status,
    stage: job.stage,
    fraction: job.fraction,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.result === undefined ? {} : { result: job.result }),
  };
}

function broadcast(job: JobRecord): void {
  const data = `data: ${JSON.stringify(snapshot(job))}\n\n`;
  for (const listener of job.listeners) listener.write(data);
}

async function runJob(job: JobRecord): Promise<void> {
  job.status = "running";
  job.stage = "initialization";
  broadcast(job);
  try {
    const registration = getServerModel(job.modelId);
    if (registration === undefined) throw new Error(`Model '${job.modelId}' is no longer registered.`);
    job.result = await registration.run({
      alignment: job.alignmentText,
      tree: job.treeText,
      parameters: job.parameters,
      signal: job.controller.signal,
      onProgress: (stage, fraction) => {
        job.stage = stage;
        job.fraction = fraction;
        broadcast(job);
      },
    });
    job.status = "succeeded";
    job.stage = "complete";
    job.fraction = 1;
  } catch (error) {
    if (job.controller.signal.aborted) {
      job.status = "cancelled";
      job.stage = "cancelled";
    } else {
      job.status = "failed";
      job.stage = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  }
  broadcast(job);
  for (const listener of job.listeners) listener.end();
  job.listeners.clear();
}

export const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers());
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, { models: serverModelRegistry.map((registration) => registration.manifest) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const body = await readJson<SubmitJobBody>(request);
      const registration = getServerModel(body.modelId);
      if (registration === undefined) {
        json(response, 404, { error: `Unknown model '${body.modelId}'.` });
        return;
      }
      const alignment = await createAlignmentArtifact(body.alignment.name ?? "alignment.fasta", body.alignment.text);
      const tree = await createTreeArtifact(body.tree.name ?? "tree.nwk", body.tree.text, "upload");
      const validation = registration.validate({ alignment, tree });
      if (!validation.ready) {
        json(response, 422, { error: `Inputs are not valid for ${registration.manifest.shortTitle}.`, issues: validation.issues });
        return;
      }
      const id = randomUUID();
      const job: JobRecord = {
        id,
        modelId: body.modelId,
        createdAt: new Date().toISOString(),
        alignmentText: alignment.text,
        treeText: tree.text,
        parameters: body.parameters ?? {},
        controller: new AbortController(),
        listeners: new Set(),
        status: "queued",
        stage: "queued",
        fraction: 0,
      };
      jobs.set(id, job);
      json(response, 202, snapshot(job));
      setImmediate(() => void runJob(job));
      return;
    }
    const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(events|cancel))?$/);
    if (match !== null) {
      const job = jobs.get(match[1] ?? "");
      if (job === undefined) {
        json(response, 404, { error: "Job not found." });
        return;
      }
      if (request.method === "GET" && match[2] === "events") {
        response.writeHead(200, headers({
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        }));
        response.write(`data: ${JSON.stringify(snapshot(job))}\n\n`);
        if (["succeeded", "failed", "cancelled"].includes(job.status)) response.end();
        else {
          job.listeners.add(response);
          request.on("close", () => job.listeners.delete(response));
        }
        return;
      }
      if (request.method === "POST" && match[2] === "cancel") {
        job.controller.abort();
        json(response, 202, snapshot(job));
        return;
      }
      if (request.method === "GET" && match[2] === undefined) {
        json(response, 200, snapshot(job));
        return;
      }
    }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`EvoOnline API listening on http://localhost:${activePort}`);
});
