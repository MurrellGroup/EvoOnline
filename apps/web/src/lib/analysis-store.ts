import type { AlignmentArtifact, TreeArtifact } from "@phylo-workbench/domain";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";

export interface SavedAnalysis {
  readonly id: string;
  readonly modelId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly parameters: ParameterValues;
  readonly alignment?: AlignmentArtifact;
  readonly tree?: TreeArtifact;
  readonly result: unknown;
  readonly recombinationTrees?: RecombinationCodonTreeSet;
  readonly simulationSource?: {
    readonly simulationAnalysisId: string;
    readonly datasetId: string;
    readonly datasetIndex: number;
  };
}

const DATABASE = "evoonline-analyses";
const STORE = "analyses";
const VERSION = 1;
const memoryFallback = new Map<string, SavedAnalysis>();

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the analysis database."));
  });
}

export async function listSavedAnalyses(): Promise<readonly SavedAnalysis[]> {
  const database = await openDatabase();
  if (database === undefined) return [...memoryFallback.values()].sort((left, right) => right.createdAt - left.createdAt);
  try {
    const values = await new Promise<SavedAnalysis[]>((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as SavedAnalysis[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read saved analyses."));
    });
    return values.sort((left, right) => right.createdAt - left.createdAt);
  } finally { database.close(); }
}

export async function saveAnalysis(analysis: SavedAnalysis): Promise<void> {
  memoryFallback.set(analysis.id, analysis);
  const database = await openDatabase();
  if (database === undefined) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(analysis);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not save the analysis."));
    });
  } finally { database.close(); }
}

export async function deleteSavedAnalysis(id: string): Promise<void> {
  memoryFallback.delete(id);
  const database = await openDatabase();
  if (database === undefined) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not delete the saved analysis."));
    });
  } finally { database.close(); }
}
