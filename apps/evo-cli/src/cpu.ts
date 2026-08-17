import { availableParallelism } from "node:os";

export interface CpuAllocation {
  readonly parallelism: number;
  readonly cpusPerTask: number;
}

export function availableCpuCount(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return 1;
  }
}

export function normalizeMaxCpus(value: unknown, available = availableCpuCount()): number {
  const maximum = Math.max(1, Math.floor(available));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : maximum;
}

export function allocateCpuBudget(maxCpus: number, taskCount: number): CpuAllocation {
  if (taskCount <= 0) return { parallelism: 0, cpusPerTask: Math.max(1, maxCpus) };
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
