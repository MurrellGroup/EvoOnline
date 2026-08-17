export const CPU_BUDGET_STORAGE_KEY = "evoonline-max-cpus-v1";

export function detectedLogicalCpus(): number {
  const value = typeof navigator === "undefined" ? 1 : Number(navigator.hardwareConcurrency || 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export function clampMaxCpus(value: unknown, available = detectedLogicalCpus()): number {
  const maximum = Math.max(1, Math.floor(available));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : maximum;
}

export function loadMaxCpus(available = detectedLogicalCpus()): number {
  if (typeof localStorage === "undefined") return available;
  try {
    const stored = localStorage.getItem(CPU_BUDGET_STORAGE_KEY);
    return stored === null ? available : clampMaxCpus(stored, available);
  } catch {
    return available;
  }
}

export function storeMaxCpus(value: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CPU_BUDGET_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

export function allocateCpuBudget(maxCpus: number, taskCount: number): { readonly parallelism: number; readonly cpusPerTask: number } {
  if (taskCount <= 0) return { parallelism: 0, cpusPerTask: Math.max(1, Math.floor(maxCpus)) };
  const budget = Math.max(1, Math.floor(maxCpus));
  const parallelism = Math.max(1, Math.min(budget, Math.floor(taskCount)));
  return { parallelism, cpusPerTask: Math.max(1, Math.floor(budget / parallelism)) };
}

export async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  if (values.length === 0) return [];
  const output = new Array<Output>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(values.length, Math.floor(concurrency))) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await worker(values[index]!, index);
    }
  });
  await Promise.all(runners);
  return output;
}
