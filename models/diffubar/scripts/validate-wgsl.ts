import { create, globals } from "webgpu";
import { likelihoodShader } from "../src/backends/likelihood.wgsl.js";

Object.assign(globalThis, globals);
let gpu = create(["backend=null"]);
const adapter = await gpu.requestAdapter();
if (adapter === null) throw new Error("Dawn null adapter is unavailable.");
const device = await adapter.requestDevice();
try {
  const module = device.createShaderModule({ code: likelihoodShader() });
  const info = await module.getCompilationInfo();
  for (const message of info.messages) {
    process.stderr.write(`${message.type} ${message.lineNum}:${message.linePos} ${message.message}\n`);
  }
  if (info.messages.some((message) => message.type === "error")) process.exitCode = 1;
  else process.stdout.write("WGSL validation passed.\n");
} finally {
  device.destroy();
  gpu = undefined as unknown as ReturnType<typeof create>;
}
