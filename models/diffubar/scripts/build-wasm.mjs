import { access, copyFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "src", "wasm");
await mkdir(outputDirectory, { recursive: true });

const executable = process.platform === "win32" ? "asc.cmd" : "asc";
const candidates = [
  path.join(root, "node_modules", ".bin", executable),
  path.resolve(root, "..", "..", "node_modules", ".bin", executable),
];
let asc;
for (const candidate of candidates) {
  try {
    await access(candidate);
    asc = candidate;
    break;
  } catch {
    // Try the next workspace-local or hoisted binary.
  }
}
if (asc === undefined) throw new Error("Unable to locate the AssemblyScript compiler.");
const args = [
  path.join(root, "assembly", "index.ts"),
  "--outFile", path.join(outputDirectory, "diffubar.wasm"),
  "--textFile", path.join(outputDirectory, "diffubar.wat"),
  "--bindings", "raw",
  "--exportRuntime",
  "--runtime", "incremental",
  "--optimizeLevel", "3",
  "--shrinkLevel", "1",
  "--converge",
  "--enable", "simd",
];

await new Promise((resolve, reject) => {
  const child = spawn(asc, args, { cwd: root, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`AssemblyScript compiler exited with ${code}`)));
});

const distributionWasmDirectory = path.join(root, "dist", "wasm");
await mkdir(distributionWasmDirectory, { recursive: true });
await copyFile(path.join(outputDirectory, "diffubar.wasm"), path.join(distributionWasmDirectory, "diffubar.wasm"));
