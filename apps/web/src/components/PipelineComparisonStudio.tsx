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

function compactText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`;
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
  const [tableMode, setTableMode] = useState<"all" | "selected">("all");

  const activeGroup = groups.find((group) => group.key === groupKey) ?? groups[0];
  const recordSignals: readonly { readonly record: PipelineComparisonRecord; readonly signals: readonly ComparisonSignal[] }[] = useMemo(() => activeGroup?.records.map((record) => ({
    record,
    signals: extractComparisonSignals(record).map((signal) => activeGroup.allSources ? { ...signal, methodLabel: `${signal.methodLabel} · ${record.sourceLabel}` } : signal),
  })) ?? [], [activeGroup]);
  const availableUnits = (["site", "branch"] as const).filter((candidate) => (!activeGroup?.allSources || candidate === "site") && recordSignals.some((entry) => entry.signals.some((signal) => signal.unit === candidate)));
  const activeUnit = availableUnits.includes(unit) ? unit : availableUnits[0] ?? "site";
  const signalOptions = useMemo(() => recordSignals.map(({ record, signals }) => ({ record, signals: signals.filter((signal) => signal.unit === activeUnit) })).filter((entry) => entry.signals.length > 0), [activeUnit, recordSignals]);
  const selectedSignals = useMemo(() => signalOptions.map(({ record, signals }) => signals.find((signal) => signal.id === metricSelections[record.analysis.id]) ?? signals[0]!).filter((signal): signal is ComparisonSignal => signal !== undefined), [metricSelections, signalOptions]);
  const thresholdFor = (signal: ComparisonSignal): number => thresholds[signal.id] ?? signal.defaultThreshold;
  const allSignals = useMemo(() => signalOptions.flatMap((entry) => entry.signals), [signalOptions]);
  const tableSignals = useMemo(() => tableMode === "all" ? allSignals : selectedSignals, [allSignals, selectedSignals, tableMode]);
  const tableRows = useMemo(() => aggregateComparisonSignals(tableSignals), [tableSignals]);
  const selectedSignalIds = useMemo(() => new Set(selectedSignals.map((signal) => signal.id)), [selectedSignals]);
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
    const headers = [activeUnit === "site" ? "codon" : "branch", ...tableSignals.flatMap((signal) => [
      `${signal.methodLabel}: ${signal.metricLabel} [${signal.provenance}]`,
      ...(selectedSignalIds.has(signal.id) ? [`${signal.methodLabel}: selected-signal call (${signal.thresholdDirection === "below" ? "<=" : ">="} ${formatValue(signal, thresholdFor(signal))})`] : []),
    ])];
    const lines = [headers.map(csvCell).join(",")];
    for (const row of tableRows) {
      const cells: (string | number | boolean)[] = [activeUnit === "site" ? row.ordinal : row.label];
      for (const signal of tableSignals) {
        const value = row.values[signal.id];
        cells.push(value ?? "");
        if (selectedSignalIds.has(signal.id)) cells.push(value === undefined ? "" : comparisonSignalCall(signal, value, thresholdFor(signal)));
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
  const siteOrdinals = selectedSignals.flatMap((signal) => signal.values.map((entry) => entry.ordinal));
  let minimumSite = siteOrdinals[0] ?? 1;
  let maximumSite = minimumSite;
  for (const site of siteOrdinals) { minimumSite = Math.min(minimumSite, site); maximumSite = Math.max(maximumSite, site); }
  const sitePlotWidth = 960;
  const sitePlotLeft = 205;
  const sitePlotRight = 42;
  const sitePlotTop = 20;
  const sitePlotBottom = 36;
  const siteLaneHeight = 82;
  const sitePlotHeight = sitePlotTop + selectedSignals.length * siteLaneHeight + sitePlotBottom;
  const siteX = (site: number): number => sitePlotLeft + ((site - minimumSite) / Math.max(1, maximumSite - minimumSite)) * (sitePlotWidth - sitePlotLeft - sitePlotRight);
  const siteColors = ["#1d7e70", "#4267b5", "#d1525b", "#a16816", "#7449a3", "#21849b", "#8a5a44", "#4f7d2b"] as const;

  return <section className="pipeline-comparison-studio" aria-labelledby="pipeline-comparison-heading">
    <div className="pipeline-comparison-studio__heading">
      <div><p className="eyebrow">Cross-method results</p><h2 id="pipeline-comparison-heading">Aggregate table &amp; plotting studio</h2><p>Codon signals can be compared across every method × source route for one alignment; each column retains its source label. Branch comparisons remain source-specific because different trees do not share a reliable branch identity. Missing values use pairwise-complete rows.</p></div>
      <button type="button" className="button button--secondary" disabled={tableSignals.length === 0} onClick={downloadTable}>Download aggregate CSV</button>
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
          return <div key={record.analysis.id} className="pipeline-threshold-card"><strong>{selected.methodLabel}</strong><label><span>Signal</span><select value={selected.id} onChange={(event) => setMetricSelections((current) => ({ ...current, [record.analysis.id]: event.target.value }))}>{signals.map((signal) => <option key={signal.id} value={signal.id}>{signal.provenance === "derived" ? "Derived · " : "Reported · "}{signal.metricLabel}</option>)}</select></label><label><span>Call threshold</span><input type="number" value={threshold} min={selected.thresholdMinimum} max={selected.thresholdMaximum} step={selected.thresholdStep} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setThresholds((current) => ({ ...current, [selected.id]: value })); }} /></label><small>{called.toLocaleString()}/{selected.values.length.toLocaleString()} called when signal {selected.thresholdDirection === "below" ? "≤" : "≥"} {formatValue(selected, threshold)}</small>{selected.description !== undefined && <small className="pipeline-signal-description">{selected.description}</small>}</div>;
        })}
      </div>

      {activeUnit === "site" && selectedSignals.length > 0 && <article className="pipeline-comparison-plot pipeline-sites-results-plot">
        <header><div><strong>Sites by results</strong><small>Every method uses its selected signal above · aligned codon axis · independent native y-range per row · dashed line is that method’s call threshold</small></div></header>
        <div className="pipeline-sites-results-plot__scroll"><svg viewBox={`0 0 ${sitePlotWidth} ${sitePlotHeight}`} role="img" aria-label="Selected results by codon site for all methods">
          {selectedSignals.map((signal, signalIndex) => {
            const threshold = thresholdFor(signal);
            const entries = [...signal.values].sort((left, right) => left.ordinal - right.ordinal);
            let minimum = threshold;
            let maximum = threshold;
            for (const entry of entries) { minimum = Math.min(minimum, entry.value); maximum = Math.max(maximum, entry.value); }
            if (minimum === maximum) { minimum -= 0.5; maximum += 0.5; }
            const padding = (maximum - minimum) * 0.06;
            minimum -= padding;
            maximum += padding;
            const laneTop = sitePlotTop + signalIndex * siteLaneHeight;
            const laneBottom = laneTop + siteLaneHeight - 18;
            const y = (value: number): number => laneBottom - ((value - minimum) / (maximum - minimum)) * (laneBottom - laneTop);
            const stride = Math.max(1, Math.ceil(entries.length / 1800));
            const visible = entries.filter((_, index) => index % stride === 0 || index === entries.length - 1);
            const path = visible.map((entry, index) => `${index === 0 ? "M" : "L"}${siteX(entry.ordinal).toFixed(2)},${y(entry.value).toFixed(2)}`).join(" ");
            const color = siteColors[signalIndex % siteColors.length]!;
            return <g key={`site-lane-${signal.id}`}>
              <rect x={sitePlotLeft} y={laneTop} width={sitePlotWidth - sitePlotLeft - sitePlotRight} height={laneBottom - laneTop} className="pipeline-site-lane-background" />
              <line x1={sitePlotLeft} y1={y(threshold)} x2={sitePlotWidth - sitePlotRight} y2={y(threshold)} className="pipeline-site-threshold" />
              <path d={path} fill="none" stroke={color} className="pipeline-site-series" />
              {visible.filter((_, index) => index % Math.max(1, Math.ceil(visible.length / 220)) === 0).map((entry) => <circle key={`${signal.id}-${entry.key}`} cx={siteX(entry.ordinal)} cy={y(entry.value)} r={2.1} fill={color}><title>{`${entry.label} · ${signal.methodLabel} · ${signal.metricLabel}: ${formatValue(signal, entry.value)}`}</title></circle>)}
              <text x={12} y={laneTop + 17} className="pipeline-site-method">{compactText(signal.methodLabel, 30)}<title>{signal.methodLabel}</title></text>
              <text x={12} y={laneTop + 32} className="pipeline-site-metric">{compactText(signal.metricLabel, 36)}<title>{signal.metricLabel}</title></text>
              <text x={sitePlotLeft - 8} y={laneTop + 5} textAnchor="end" className="pipeline-site-scale">{formatValue(signal, maximum)}</text>
              <text x={sitePlotLeft - 8} y={laneBottom + 4} textAnchor="end" className="pipeline-site-scale">{formatValue(signal, minimum)}</text>
              <text x={sitePlotWidth - sitePlotRight + 5} y={y(threshold) + 3} className="pipeline-site-threshold-label">{formatValue(signal, threshold)}</text>
            </g>;
          })}
          <line x1={sitePlotLeft} y1={sitePlotHeight - sitePlotBottom} x2={sitePlotWidth - sitePlotRight} y2={sitePlotHeight - sitePlotBottom} className="pipeline-scatter-axis" />
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => { const site = minimumSite + fraction * (maximumSite - minimumSite); const x = siteX(site); return <g key={`site-tick-${fraction}`}><line x1={x} y1={sitePlotTop} x2={x} y2={sitePlotHeight - sitePlotBottom} className="pipeline-site-gridline" /><text x={x} y={sitePlotHeight - 12} textAnchor="middle" className="pipeline-site-scale">{Math.round(site)}</text></g>; })}
          <text x={(sitePlotLeft + sitePlotWidth - sitePlotRight) / 2} y={sitePlotHeight - 1} textAnchor="middle" className="pipeline-scatter-label">Codon site</text>
        </svg></div>
      </article>}

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
        <header><div><strong>Unified {activeUnit === "site" ? "codon" : "branch"} table</strong><small>{tableRows.length.toLocaleString()} rows · {tableSignals.length.toLocaleString()} {tableMode === "all" ? "reported and derived quantities" : "selected plotting signals"}</small></div><label className="pipeline-table-mode"><span>Columns</span><select value={tableMode} onChange={(event) => setTableMode(event.target.value as typeof tableMode)}><option value="all">All available quantities</option><option value="selected">Selected plot signals only</option></select></label></header>
        <div className="result-table-wrap"><table className="result-table"><thead><tr><th>{activeUnit === "site" ? "Codon" : "Branch"}</th>{tableSignals.map((signal) => <th key={signal.id}><strong>{signal.methodLabel}</strong><small>{signal.metricLabel}</small><small>{signal.provenance}{selectedSignalIds.has(signal.id) ? " · selected plot signal" : ""}</small></th>)}</tr></thead><tbody>{tableRows.slice(0, 1000).map((row) => <tr key={row.key}><td><strong>{activeUnit === "site" ? row.ordinal : row.label}</strong></td>{tableSignals.map((signal) => { const value = row.values[signal.id]; const called = selectedSignalIds.has(signal.id) && value !== undefined && comparisonSignalCall(signal, value, thresholdFor(signal)); return <td key={signal.id} className={called ? "is-comparison-call" : undefined} title={signal.description}>{value === undefined ? "—" : formatValue(signal, value)}{called && <small>called</small>}</td>; })}</tr>)}</tbody></table></div>
        {tableRows.length > 1000 && <p>Showing the first 1,000 rows. The downloaded aggregate contains all {tableRows.length.toLocaleString()} rows.</p>}
      </article>
    </>}
  </section>;
}
