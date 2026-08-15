import { useMemo, useState } from "react";
import { downloadText } from "../lib/file-download.js";
import {
  aggregateComparisonSignals,
  binaryAgreement,
  comparisonSignalCall,
  extractComparisonSignals,
  groupPipelineComparisons,
  pairedComparisonValues,
  pearsonCorrelation,
  spearmanCorrelation,
  type AgreementMetric,
  type ComparisonSignal,
  type ComparisonUnit,
  type PipelineComparisonGroup,
  type PipelineComparisonRecord,
} from "../lib/pipeline-comparison.js";

interface PipelineComparisonStudioProps {
  readonly records: readonly PipelineComparisonRecord[];
}

function formatValue(signal: ComparisonSignal, value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (signal.format === "probability" || signal.format === "p-value") {
    if (value > 0 && value < 0.0001) return value.toExponential(2);
    return value.toFixed(4);
  }
  if (Math.abs(value) >= 1000 || (value !== 0 && Math.abs(value) < 0.001)) return value.toExponential(3);
  return value.toFixed(4).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function matrixColor(value: number | null, diverging: boolean): string {
  if (value === null || !Number.isFinite(value)) return "#f0f3f1";
  if (diverging && value < 0) return `rgba(67, 103, 181, ${0.14 + Math.min(1, Math.abs(value)) * 0.68})`;
  return `rgba(29, 126, 112, ${0.12 + Math.min(1, Math.abs(value)) * 0.72})`;
}

function safeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "comparison";
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function matrixValue(
  left: ComparisonSignal,
  right: ComparisonSignal,
  kind: "pearson" | "spearman",
): { readonly value: number | null; readonly count: number } {
  const pairs = pairedComparisonValues(left, right);
  return { value: kind === "pearson" ? pearsonCorrelation(pairs) : spearmanCorrelation(pairs), count: pairs.length };
}

export function PipelineComparisonStudio({ records }: PipelineComparisonStudioProps) {
  const groups: readonly PipelineComparisonGroup[] = useMemo(() => groupPipelineComparisons(records), [records]);
  const [groupKey, setGroupKey] = useState("");
  const [unit, setUnit] = useState<ComparisonUnit>("site");
  const [metricSelections, setMetricSelections] = useState<Readonly<Record<string, string>>>({});
  const [thresholds, setThresholds] = useState<Readonly<Record<string, number>>>({});
  const [correlationKind, setCorrelationKind] = useState<"spearman" | "pearson">("spearman");
  const [agreementMetric, setAgreementMetric] = useState<AgreementMetric>("jaccard");
  const [xSignalId, setXSignalId] = useState("");
  const [ySignalId, setYSignalId] = useState("");

  const activeGroup = groups.find((group) => group.key === groupKey) ?? groups[0];
  const recordSignals: readonly { readonly record: PipelineComparisonRecord; readonly signals: readonly ComparisonSignal[] }[] = useMemo(() => activeGroup?.records.map((record) => ({
    record,
    signals: extractComparisonSignals(record).map((signal) => activeGroup.allSources ? { ...signal, methodLabel: `${signal.methodLabel} · ${record.sourceLabel}` } : signal),
  })) ?? [], [activeGroup]);
  const availableUnits = (["site", "branch"] as const).filter((candidate) => (!activeGroup?.allSources || candidate === "site") && recordSignals.some((entry) => entry.signals.some((signal) => signal.unit === candidate)));
  const activeUnit = availableUnits.includes(unit) ? unit : availableUnits[0] ?? "site";
  const signalOptions = recordSignals.map(({ record, signals }) => ({ record, signals: signals.filter((signal) => signal.unit === activeUnit) })).filter((entry) => entry.signals.length > 0);
  const selectedSignals = signalOptions.map(({ record, signals }) => signals.find((signal) => signal.id === metricSelections[record.analysis.id]) ?? signals[0]!).filter((signal): signal is ComparisonSignal => signal !== undefined);
  const tableRows = useMemo(() => aggregateComparisonSignals(selectedSignals), [selectedSignals]);
  const thresholdFor = (signal: ComparisonSignal): number => thresholds[signal.id] ?? signal.defaultThreshold;
  const scatterX = selectedSignals.find((signal) => signal.id === xSignalId) ?? selectedSignals[0];
  const scatterY = selectedSignals.find((signal) => signal.id === ySignalId && signal.id !== scatterX?.id) ?? selectedSignals.find((signal) => signal.id !== scatterX?.id);
  const scatterPairs = scatterX !== undefined && scatterY !== undefined ? pairedComparisonValues(scatterX, scatterY) : [];
  const scatterCorrelation = scatterX !== undefined && scatterY !== undefined
    ? correlationKind === "pearson" ? pearsonCorrelation(scatterPairs) : spearmanCorrelation(scatterPairs)
    : null;

  const scatterGeometry = useMemo(() => {
    if (scatterPairs.length === 0) return undefined;
    let minimumX = scatterPairs[0]![0];
    let maximumX = minimumX;
    let minimumY = scatterPairs[0]![1];
    let maximumY = minimumY;
    for (const [x, y] of scatterPairs) {
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
    if (minimumX === maximumX) { minimumX -= 0.5; maximumX += 0.5; }
    if (minimumY === maximumY) { minimumY -= 0.5; maximumY += 0.5; }
    const xPad = (maximumX - minimumX) * 0.04;
    const yPad = (maximumY - minimumY) * 0.04;
    return { minimumX: minimumX - xPad, maximumX: maximumX + xPad, minimumY: minimumY - yPad, maximumY: maximumY + yPad };
  }, [scatterPairs]);

  if (activeGroup === undefined) return null;

  const downloadTable = (): void => {
    const headers = [activeUnit === "site" ? "codon" : "branch", ...selectedSignals.flatMap((signal) => [`${signal.methodLabel}: ${signal.metricLabel}`, `${signal.methodLabel}: called (${signal.thresholdDirection === "below" ? "<=" : ">="} ${formatValue(signal, thresholdFor(signal))})`])];
    const lines = [headers.map(csvCell).join(",")];
    for (const row of tableRows) {
      const cells: (string | number | boolean)[] = [activeUnit === "site" ? row.ordinal : row.label];
      for (const signal of selectedSignals) {
        const value = row.values[signal.id];
        cells.push(value ?? "", value === undefined ? "" : comparisonSignalCall(signal, value, thresholdFor(signal)));
      }
      lines.push(cells.map(csvCell).join(","));
    }
    downloadText(`${lines.join("\n")}\n`, `${safeName(activeGroup.datasetName)}-${safeName(activeGroup.sourceLabel)}-${activeUnit}-comparison.csv`, "text/csv;charset=utf-8");
  };

  const plotWidth = 680;
  const plotHeight = 360;
  const margin = { left: 68, right: 20, top: 20, bottom: 62 };
  const plotX = (value: number): number => scatterGeometry === undefined ? margin.left : margin.left + ((value - scatterGeometry.minimumX) / (scatterGeometry.maximumX - scatterGeometry.minimumX)) * (plotWidth - margin.left - margin.right);
  const plotY = (value: number): number => scatterGeometry === undefined ? margin.top : plotHeight - margin.bottom - ((value - scatterGeometry.minimumY) / (scatterGeometry.maximumY - scatterGeometry.minimumY)) * (plotHeight - margin.top - margin.bottom);
  const pointStep = Math.max(1, Math.ceil(scatterPairs.length / 1800));

  return <section className="pipeline-comparison-studio" aria-labelledby="pipeline-comparison-heading">
    <div className="pipeline-comparison-studio__heading">
      <div><p className="eyebrow">Cross-method results</p><h2 id="pipeline-comparison-heading">Aggregate table &amp; plotting studio</h2><p>Codon signals can be compared across every method × source route for one alignment; each column retains its source label. Branch comparisons remain source-specific because different trees do not share a reliable branch identity. Missing values use pairwise-complete rows.</p></div>
      <button type="button" className="button button--secondary" disabled={selectedSignals.length === 0} onClick={downloadTable}>Download aggregate CSV</button>
    </div>

    <div className="pipeline-comparison-toolbar">
      <label><span>Dataset &amp; comparison scope</span><select value={activeGroup.key} onChange={(event) => setGroupKey(event.target.value)}>{groups.map((group) => <option key={group.key} value={group.key}>{group.datasetName} · {group.allSources ? "all source routes" : `via ${group.sourceLabel}`}</option>)}</select></label>
      {availableUnits.length > 1 && <label><span>Analysis unit</span><select value={activeUnit} onChange={(event) => setUnit(event.target.value as ComparisonUnit)}>{availableUnits.map((value) => <option key={value} value={value}>{value === "site" ? "Codon sites" : "Branches"}</option>)}</select></label>}
      <label><span>Correlation</span><select value={correlationKind} onChange={(event) => setCorrelationKind(event.target.value as typeof correlationKind)}><option value="spearman">Spearman rank</option><option value="pearson">Pearson</option></select></label>
      <label><span>Agreement</span><select value={agreementMetric} onChange={(event) => setAgreementMetric(event.target.value as AgreementMetric)}><option value="jaccard">Positive-call Jaccard</option><option value="overall">Overall agreement</option></select></label>
    </div>

    {signalOptions.length === 0 ? <div className="pipeline-comparison-empty">No normalized {activeUnit} signals are available for this route.</div> : <>
      <div className="pipeline-threshold-grid">
        {signalOptions.map(({ record, signals }) => {
          const selected = signals.find((signal) => signal.id === metricSelections[record.analysis.id]) ?? signals[0]!;
          const threshold = thresholdFor(selected);
          const called = selected.values.filter((entry) => comparisonSignalCall(selected, entry.value, threshold)).length;
          return <div key={record.analysis.id} className="pipeline-threshold-card"><strong>{selected.methodLabel}</strong><label><span>Signal</span><select value={selected.id} onChange={(event) => setMetricSelections((current) => ({ ...current, [record.analysis.id]: event.target.value }))}>{signals.map((signal) => <option key={signal.id} value={signal.id}>{signal.metricLabel}</option>)}</select></label><label><span>Call threshold</span><input type="number" value={threshold} min={selected.thresholdMinimum} max={selected.thresholdMaximum} step={selected.thresholdStep} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setThresholds((current) => ({ ...current, [selected.id]: value })); }} /></label><small>{called.toLocaleString()}/{selected.values.length.toLocaleString()} called when signal {selected.thresholdDirection === "below" ? "≤" : "≥"} {formatValue(selected, threshold)}</small></div>;
        })}
      </div>

      {selectedSignals.length >= 2 && <div className="pipeline-comparison-plots">
        <article className="pipeline-comparison-plot pipeline-comparison-scatter">
          <header><div><strong>Signal correlation</strong><small>{correlationKind === "spearman" ? "Spearman ρ" : "Pearson r"} = {scatterCorrelation === null ? "—" : scatterCorrelation.toFixed(3)} · n = {scatterPairs.length.toLocaleString()}</small></div><div><label><span>X</span><select value={scatterX?.id ?? ""} onChange={(event) => setXSignalId(event.target.value)}>{selectedSignals.map((signal) => <option key={signal.id} value={signal.id}>{signal.methodLabel}</option>)}</select></label><label><span>Y</span><select value={scatterY?.id ?? ""} onChange={(event) => setYSignalId(event.target.value)}>{selectedSignals.filter((signal) => signal.id !== scatterX?.id).map((signal) => <option key={signal.id} value={signal.id}>{signal.methodLabel}</option>)}</select></label></div></header>
          {scatterGeometry !== undefined && scatterX !== undefined && scatterY !== undefined ? <svg viewBox={`0 0 ${plotWidth} ${plotHeight}`} role="img" aria-label={`${scatterX.methodLabel} versus ${scatterY.methodLabel} signal scatter plot`}>
            <line x1={margin.left} y1={plotHeight - margin.bottom} x2={plotWidth - margin.right} y2={plotHeight - margin.bottom} className="pipeline-scatter-axis" />
            <line x1={margin.left} y1={margin.top} x2={margin.left} y2={plotHeight - margin.bottom} className="pipeline-scatter-axis" />
            {thresholdFor(scatterX) >= scatterGeometry.minimumX && thresholdFor(scatterX) <= scatterGeometry.maximumX && <line x1={plotX(thresholdFor(scatterX))} y1={margin.top} x2={plotX(thresholdFor(scatterX))} y2={plotHeight - margin.bottom} className="pipeline-scatter-threshold" />}
            {thresholdFor(scatterY) >= scatterGeometry.minimumY && thresholdFor(scatterY) <= scatterGeometry.maximumY && <line x1={margin.left} y1={plotY(thresholdFor(scatterY))} x2={plotWidth - margin.right} y2={plotY(thresholdFor(scatterY))} className="pipeline-scatter-threshold" />}
            {scatterPairs.filter((_, index) => index % pointStep === 0).map(([x, y], index) => { const leftCall = comparisonSignalCall(scatterX, x, thresholdFor(scatterX)); const rightCall = comparisonSignalCall(scatterY, y, thresholdFor(scatterY)); return <circle key={`${x}-${y}-${index}`} cx={plotX(x)} cy={plotY(y)} r={3.1} className={leftCall && rightCall ? "is-both" : leftCall || rightCall ? "is-one" : "is-neither"} />; })}
            <text x={margin.left} y={plotHeight - margin.bottom + 19} textAnchor="middle">{formatValue(scatterX, scatterGeometry.minimumX)}</text><text x={plotWidth - margin.right} y={plotHeight - margin.bottom + 19} textAnchor="middle">{formatValue(scatterX, scatterGeometry.maximumX)}</text>
            <text x={margin.left - 8} y={plotHeight - margin.bottom + 4} textAnchor="end">{formatValue(scatterY, scatterGeometry.minimumY)}</text><text x={margin.left - 8} y={margin.top + 4} textAnchor="end">{formatValue(scatterY, scatterGeometry.maximumY)}</text>
            <text x={(margin.left + plotWidth - margin.right) / 2} y={plotHeight - 18} textAnchor="middle" className="pipeline-scatter-label">{scatterX.methodLabel} · {scatterX.metricLabel}</text>
            <text transform={`translate(18 ${(margin.top + plotHeight - margin.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="pipeline-scatter-label">{scatterY.methodLabel} · {scatterY.metricLabel}</text>
          </svg> : <div className="pipeline-comparison-empty">No shared observations are available for this pair.</div>}
        </article>

        <article className="pipeline-comparison-plot"><header><div><strong>Correlation matrix</strong><small>{correlationKind === "spearman" ? "Rank correlation" : "Linear correlation"} on native scales · lower p-values can therefore correlate negatively with higher-is-stronger posteriors</small></div></header><div className="pipeline-matrix-scroll"><div className="pipeline-matrix" style={{ gridTemplateColumns: `minmax(105px, 1.35fr) repeat(${selectedSignals.length}, minmax(58px, .75fr))` }}><span />{selectedSignals.map((signal) => <strong key={`column-${signal.id}`} title={`${signal.methodLabel}: ${signal.metricLabel}`}>{signal.methodLabel}</strong>)}{selectedSignals.flatMap((left) => [<strong key={`row-${left.id}`} title={`${left.methodLabel}: ${left.metricLabel}`}>{left.methodLabel}</strong>, ...selectedSignals.map((right) => { const result = matrixValue(left, right, correlationKind); return <span key={`${left.id}-${right.id}`} style={{ background: matrixColor(result.value, true) }} title={`n=${result.count}`}>{result.value === null ? "—" : result.value.toFixed(2)}</span>; })])}</div></div></article>

        <article className="pipeline-comparison-plot"><header><div><strong>Threshold agreement matrix</strong><small>{agreementMetric === "jaccard" ? "Intersection / union of positive calls" : "Matching calls and non-calls / shared rows"}</small></div></header><div className="pipeline-matrix-scroll"><div className="pipeline-matrix" style={{ gridTemplateColumns: `minmax(105px, 1.35fr) repeat(${selectedSignals.length}, minmax(58px, .75fr))` }}><span />{selectedSignals.map((signal) => <strong key={`agreement-column-${signal.id}`}>{signal.methodLabel}</strong>)}{selectedSignals.flatMap((left) => [<strong key={`agreement-row-${left.id}`}>{left.methodLabel}</strong>, ...selectedSignals.map((right) => { const result = binaryAgreement(left, right, thresholdFor(left), thresholdFor(right), agreementMetric); return <span key={`agreement-${left.id}-${right.id}`} style={{ background: matrixColor(result.value, false) }} title={`${result.both} joint calls · ${result.either} called by either · n=${result.count}`}>{result.value === null ? "—" : `${(result.value * 100).toFixed(0)}%`}</span>; })])}</div></div></article>
      </div>}

      <article className="pipeline-comparison-table">
        <header><div><strong>Unified {activeUnit === "site" ? "codon" : "branch"} table</strong><small>{tableRows.length.toLocaleString()} rows · selected signal and threshold call for each method</small></div><span>Values highlighted when called</span></header>
        <div className="result-table-wrap"><table className="result-table"><thead><tr><th>{activeUnit === "site" ? "Codon" : "Branch"}</th>{selectedSignals.map((signal) => <th key={signal.id}><strong>{signal.methodLabel}</strong><small>{signal.metricLabel}</small></th>)}</tr></thead><tbody>{tableRows.slice(0, 1000).map((row) => <tr key={row.key}><td><strong>{activeUnit === "site" ? row.ordinal : row.label}</strong></td>{selectedSignals.map((signal) => { const value = row.values[signal.id]; const called = value !== undefined && comparisonSignalCall(signal, value, thresholdFor(signal)); return <td key={signal.id} className={called ? "is-comparison-call" : undefined}>{value === undefined ? "—" : formatValue(signal, value)}{called && <small>called</small>}</td>; })}</tr>)}</tbody></table></div>
        {tableRows.length > 1000 && <p>Showing the first 1,000 rows. The downloaded aggregate contains all {tableRows.length.toLocaleString()} rows.</p>}
      </article>
    </>}
  </section>;
}
