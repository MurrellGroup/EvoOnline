import { resolve } from "node:path";
import type { ComparisonRecord, ComparisonSignal } from "./comparison.js";
import { rowsToCsv, writeText } from "./io.js";
import type { ResolvedVisualizationSettings } from "./visualization.js";

export interface StandardOutputFile {
  readonly path: string;
  readonly kind: "result-table" | "plot";
  readonly mediaType: "text/csv" | "image/svg+xml";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function scalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function flattenScalars(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (scalar(entry)) output[path] = entry;
    else if (record(entry)) Object.assign(output, flattenScalars(entry, path));
  }
  return output;
}

function rowKey(row: Record<string, unknown>, index: number): string {
  return String(row.nodeId ?? row.site ?? row.branch ?? index + 1);
}

function callColumns(
  methodId: string,
  unit: "site" | "branch",
  row: Record<string, unknown>,
  settings: ResolvedVisualizationSettings,
): Record<string, unknown> {
  const number = (key: string): number | undefined => typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] as number : undefined;
  if (methodId === "fubar" && unit === "site") {
    const positive = (number("pPositive") ?? -Infinity) > settings.positivePosteriorThreshold;
    const purifying = (number("pPurifying") ?? -Infinity) > settings.purifyingPosteriorThreshold;
    return {
      positive_posterior_threshold: settings.positivePosteriorThreshold,
      purifying_posterior_threshold: settings.purifyingPosteriorThreshold,
      positive_selected_at_threshold: positive,
      purifying_selected_at_threshold: purifying,
      selection_at_threshold: positive ? "positive" : purifying ? "purifying" : "none",
    };
  }
  if (methodId === "diffubar" && unit === "site") {
    const metrics = ["pOmega1Greater", "pOmega2Greater", "pOmega1Positive", "pOmega2Positive"] as const;
    const calls = Object.fromEntries(metrics.map((metric) => [`${metric}_selected_at_threshold`, (number(metric) ?? -Infinity) > settings.posteriorThreshold]));
    return {
      posterior_threshold: settings.posteriorThreshold,
      ...calls,
      detected_at_threshold: metrics.some((metric) => (number(metric) ?? -Infinity) > settings.posteriorThreshold),
    };
  }
  if ((methodId === "fame" || methodId === "flavor") && unit === "site") {
    return {
      posterior_threshold: settings.posteriorThreshold,
      positive_selected_at_threshold: (number("pPositive") ?? -Infinity) > settings.posteriorThreshold,
    };
  }
  if (methodId === "bsrel" && unit === "branch") {
    const pValue = number("pValueHolm");
    return {
      significance_threshold: settings.significanceThreshold,
      significant_at_threshold: pValue !== undefined && pValue <= settings.significanceThreshold,
    };
  }
  if (methodId === "clade-shift" && unit === "site") {
    return {
      posterior_threshold: settings.posteriorThreshold,
      detected_at_threshold: (number("pShift") ?? -Infinity) > settings.posteriorThreshold,
    };
  }
  if (methodId === "glamma" && unit === "site") {
    return {
      posterior_threshold: settings.posteriorThreshold,
      detected_at_threshold: (number("maximumBranchPosterior") ?? -Infinity) > settings.posteriorThreshold,
    };
  }
  return {};
}

function signalColumn(signal: ComparisonSignal): string {
  return signal.id.includes(":approximate-fel:site:") ? `approximate-fel.${signal.metricId}` : signal.metricId;
}

function standardCsv(
  source: ComparisonRecord,
  unit: "site" | "branch",
  signals: readonly ComparisonSignal[],
  settings: ResolvedVisualizationSettings,
): { readonly csv: string; readonly columns: readonly (readonly [string, string])[]; readonly rows: number } | undefined {
  const result = record(source.result) ? source.result : {};
  const rawRows = Array.isArray(result[unit === "site" ? "sites" : "branches"])
    ? (result[unit === "site" ? "sites" : "branches"] as readonly unknown[]).filter(record)
    : [];
  const relevantSignals = signals.filter((signal) => signal.unit === unit);
  if (rawRows.length === 0 && relevantSignals.length === 0) return undefined;

  const rows = new Map<string, Record<string, unknown>>();
  rawRows.forEach((raw, index) => {
    const flattened = flattenScalars(raw);
    rows.set(rowKey(raw, index), { ...flattened, ...callColumns(source.methodId, unit, flattened, settings) });
  });
  for (const signal of relevantSignals) for (const value of signal.values) {
    const current = rows.get(value.key) ?? {
      [unit === "site" ? "site" : "branch key"]: value.key,
      label: value.label,
    };
    current[signalColumn(signal)] = value.value;
    rows.set(value.key, current);
  }

  const ordered = [...rows.entries()].sort((left, right) => {
    const leftOrdinal = Number(left[1].site ?? left[1].branch ?? left[0]);
    const rightOrdinal = Number(right[1].site ?? right[1].branch ?? right[0]);
    return leftOrdinal - rightOrdinal || left[0].localeCompare(right[0]);
  }).map(([, row]) => row);
  const identifiers = unit === "site" ? ["site"] : ["branch", "nodeId", "name", "parentName"];
  const all = [...new Set(ordered.flatMap((row) => Object.keys(row)))];
  const headers = [...identifiers.filter((header) => all.includes(header)), ...all.filter((header) => !identifiers.includes(header))];
  const labels = new Map(relevantSignals.map((signal) => [signalColumn(signal), signal.metricLabel]));
  return {
    csv: rowsToCsv(headers, ordered.map((row) => headers.map((header) => row[header]))),
    columns: headers.map((header) => [header, labels.get(header) ?? header] as const),
    rows: ordered.length,
  };
}

function approximateFelCsv(
  source: ComparisonRecord,
  settings: ResolvedVisualizationSettings,
): string | undefined {
  if (!record(source.result) || !record(source.result.approximateFel) || !Array.isArray(source.result.approximateFel.sites)) return undefined;
  const rows = source.result.approximateFel.sites.filter(record).map((row) => {
    const flattened = flattenScalars(row);
    const positiveP = typeof flattened.pPositive === "number" ? flattened.pPositive : undefined;
    const purifyingP = typeof flattened.pPurifying === "number" ? flattened.pPurifying : undefined;
    return {
      ...flattened,
      significance_threshold: settings.significanceThreshold,
      positive_selected_at_threshold: positiveP !== undefined && positiveP <= settings.significanceThreshold,
      purifying_selected_at_threshold: purifyingP !== undefined && purifyingP <= settings.significanceThreshold,
    };
  });
  if (rows.length === 0) return undefined;
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return rowsToCsv(headers, rows.map((row) => headers.map((header) => row[header as keyof typeof row])));
}

export async function writeStandardMethodTables(
  directory: string,
  source: ComparisonRecord,
  signals: readonly ComparisonSignal[],
  settings: ResolvedVisualizationSettings,
): Promise<readonly StandardOutputFile[]> {
  const files: StandardOutputFile[] = [];
  const summaries: Array<{ readonly unit: "site" | "branch"; readonly path: string; readonly csv: string; readonly columns: readonly (readonly [string, string])[]; readonly rows: number }> = [];
  for (const unit of ["site", "branch"] as const) {
    const table = standardCsv(source, unit, signals, settings);
    if (table === undefined) continue;
    const path = resolve(directory, "tables", `${unit}-results.csv`);
    await writeText(path, table.csv);
    files.push({ path, kind: "result-table", mediaType: "text/csv" });
    summaries.push({ unit, path, csv: table.csv, columns: table.columns, rows: table.rows });
  }
  const primary = summaries.find((summary) => summary.unit === "site") ?? summaries[0];
  if (primary !== undefined) {
    const path = resolve(directory, "results.csv");
    await writeText(path, primary.csv);
    files.push({ path, kind: "result-table", mediaType: "text/csv" });
  }
  const columnRows = summaries.flatMap((summary) => summary.columns.map(([column, description]) => [summary.unit, column, description]));
  if (columnRows.length > 0) {
    const path = resolve(directory, "tables", "column-descriptions.csv");
    await writeText(path, rowsToCsv(["table unit", "column", "description"], columnRows));
    files.push({ path, kind: "result-table", mediaType: "text/csv" });
  }
  const approximateFel = approximateFelCsv(source, settings);
  if (approximateFel !== undefined) {
    const path = resolve(directory, "tables", "approximate-fel-site-results.csv");
    await writeText(path, approximateFel);
    files.push({ path, kind: "result-table", mediaType: "text/csv" });
  }
  return files;
}
