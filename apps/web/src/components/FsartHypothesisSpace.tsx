import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FsartAnalysisResult,
  TreeHmmSubsetHypothesis,
  TreeHmmSubsetSearchSummary,
} from "@phylo-workbench/model-fsart/browser-source";
import type { RunProgress } from "../lib/diffubar-client.js";
import { downloadSvg } from "../lib/svg-export.js";

interface Props {
  readonly result: FsartAnalysisResult;
  readonly onPolish?: (treeIds: readonly string[], onProgress: (progress: RunProgress) => void) => Promise<void>;
}

function criterionValue(hypothesis: TreeHmmSubsetHypothesis): number {
  return hypothesis.exactCriterionValue ?? hypothesis.criterionValue;
}

function numberLabel(value: number | undefined): string {
  if (value === undefined) return "not exact-checked";
  return Number.isFinite(value) ? value.toFixed(3) : "infeasible";
}

function stableJitter(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 1000) / 999 - 0.5;
}

function moveDistance(first: readonly number[], second: readonly number[]): number {
  const left = new Set(first);
  const right = new Set(second);
  let distance = 0;
  for (const value of left) if (!right.has(value)) distance += 1;
  for (const value of right) if (!left.has(value)) distance += 1;
  return distance;
}

function sameTreeIds(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  const right = new Set(second);
  return first.every((value) => right.has(value));
}

function downloadHypotheses(hypotheses: readonly TreeHmmSubsetHypothesis[]): void {
  const header = ["Subset key", "Tree IDs", "States", "Rapid log likelihood", "Rapid criterion", "Exact log likelihood", "Exact criterion", "Parameters", "Rapid expected resets", "Delta from rapid best"];
  const rows = hypotheses.map((hypothesis) => [
    hypothesis.key,
    hypothesis.treeIds.join("|"),
    hypothesis.stateCount,
    hypothesis.logLikelihood,
    hypothesis.criterionValue,
    hypothesis.exactLogLikelihood ?? "",
    hypothesis.exactCriterionValue ?? "",
    hypothesis.parameterCount,
    hypothesis.expectedResets,
    hypothesis.deltaFromBest ?? "",
  ].join(","));
  const url = URL.createObjectURL(new Blob([[header.join(","), ...rows].join("\n") + "\n"], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "fsart-searched-hypotheses.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FsartHypothesisSpace({ result, onPolish }: Props) {
  const search: TreeHmmSubsetSearchSummary | undefined = result.treeHmm.initialSubsetSearch ?? result.treeHmm.subsetSearch;
  const hypotheses = search?.hypotheses ?? [];
  const transitions = search?.transitions ?? [];
  const exactVerifiedKeys = search?.exactVerifiedKeys ?? [];
  const manualTreeIds = result.treeHmm.manualPolish?.requestedTreeIds;
  const initialKey = manualTreeIds === undefined
    ? search?.exactSelectedKey ?? search?.selectedKey
    : hypotheses.find((hypothesis) => sameTreeIds(hypothesis.treeIds, manualTreeIds))?.key;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const [selectedTreeIds, setSelectedTreeIds] = useState<readonly string[]>(() =>
    manualTreeIds ?? search?.hypotheses?.find((hypothesis) => hypothesis.key === initialKey)?.treeIds ?? result.treeHmm.states.map((state) => state.id));
  const [deltaLimit, setDeltaLimit] = useState<10 | 50 | 200 | "all">(50);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<RunProgress>();
  const [error, setError] = useState<string>();
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const nextSearch = result.treeHmm.initialSubsetSearch ?? result.treeHmm.subsetSearch;
    const nextManual = result.treeHmm.manualPolish?.requestedTreeIds;
    const nextKey = nextManual === undefined
      ? nextSearch?.exactSelectedKey ?? nextSearch?.selectedKey
      : nextSearch?.hypotheses?.find((hypothesis) => sameTreeIds(hypothesis.treeIds, nextManual))?.key;
    setSelectedKey(nextKey);
    setSelectedTreeIds(nextManual ?? nextSearch?.hypotheses?.find((hypothesis) => hypothesis.key === nextKey)?.treeIds ?? result.treeHmm.states.map((state) => state.id));
  }, [result]);

  const hypothesisByKey = useMemo(() => new Map(hypotheses.map((hypothesis) => [hypothesis.key, hypothesis])), [hypotheses]);
  const selected = selectedKey === undefined ? undefined : hypothesisByKey.get(selectedKey);
  const checked = new Set(selectedTreeIds);
  const exactKeys = new Set(exactVerifiedKeys);
  const bestFinite = hypotheses.map(criterionValue).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const bestOne = hypotheses.filter((hypothesis) => hypothesis.stateCount === 1 && Number.isFinite(criterionValue(hypothesis))).sort((a, b) => criterionValue(a) - criterionValue(b))[0];
  const bestMultiple = hypotheses.filter((hypothesis) => hypothesis.stateCount > 1 && Number.isFinite(criterionValue(hypothesis))).sort((a, b) => criterionValue(a) - criterionValue(b))[0];
  const visible = hypotheses.filter((hypothesis) => {
    if (hypothesis.key === selectedKey || hypothesis.key === search?.nullKey || exactKeys.has(hypothesis.key)) return true;
    if (deltaLimit === "all") return true;
    const value = criterionValue(hypothesis);
    return Number.isFinite(value) && bestFinite !== undefined && value - bestFinite <= deltaLimit;
  });

  const width = 1040;
  const height = 430;
  const margin = { left: 76, right: 24, top: 30, bottom: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximumStates = Math.max(1, search?.maximumStates ?? 1);
  const finiteDeltas = visible.map((hypothesis) => criterionValue(hypothesis) - (bestFinite ?? 0)).filter(Number.isFinite);
  const maximumDelta = Math.max(1, ...finiteDeltas);
  const x = (states: number, key: string): number => margin.left
    + (states - 0.5 + 0.52 * stableJitter(key)) / maximumStates * plotWidth;
  const y = (hypothesis: TreeHmmSubsetHypothesis): number => {
    const value = criterionValue(hypothesis);
    if (!Number.isFinite(value) || bestFinite === undefined) return margin.top + plotHeight;
    const delta = Math.max(0, value - bestFinite);
    return margin.top + Math.log1p(delta) / Math.log1p(maximumDelta) * (plotHeight - 12);
  };
  const visibleKeys = new Set(visible.map((hypothesis) => hypothesis.key));
  const edges = transitions.filter((transition) =>
    visibleKeys.has(transition.fromKey) && visibleKeys.has(transition.toKey)
    && (transition.fromKey === selectedKey || transition.toKey === selectedKey));
  const nearby = selected === undefined ? [] : hypotheses.filter((hypothesis) =>
    hypothesis.key !== selected.key && moveDistance(hypothesis.profileIndexes, selected.profileIndexes) <= 2)
    .sort((first, second) => criterionValue(first) - criterionValue(second)).slice(0, 8);

  const selectHypothesis = (hypothesis: TreeHmmSubsetHypothesis): void => {
    setSelectedKey(hypothesis.key);
    setSelectedTreeIds(hypothesis.treeIds);
    setError(undefined);
  };
  const toggleTree = (id: string): void => {
    setSelectedKey(undefined);
    setSelectedTreeIds(checked.has(id) ? selectedTreeIds.filter((value) => value !== id) : [...selectedTreeIds, id]);
    setError(undefined);
  };
  const polish = async (): Promise<void> => {
    if (onPolish === undefined || selectedTreeIds.length === 0) return;
    setPending(true);
    setError(undefined);
    setProgress({ stage: "initialization", fraction: 0, message: "Preparing selected topology hypothesis" });
    try {
      await onPolish(result.treeHmmProfiles.filter((profile) => checked.has(profile.id)).map((profile) => profile.id), setProgress);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  if (search === undefined) return <div className="figure-empty"><strong>No combinatorial hypothesis search was run.</strong><span>The tree family did not produce at least two usable resolved topology profiles, or topology-HMM search was disabled.</span></div>;
  if (hypotheses.length === 0) return <div className="figure-empty"><strong>This saved result predates the searchable hypothesis audit.</strong><span>Rerun FSART to retain and inspect every evaluated topology subset.</span></div>;

  const bank = result.topologyBankAudit;
  const multiAdvantage = bestOne === undefined || bestMultiple === undefined ? undefined : criterionValue(bestOne) - criterionValue(bestMultiple);
  return <div className="fsart-hypothesis-space">
    <div className="result-stats fsart-hypothesis-stats">
      <div><span>Actually evaluated</span><strong>{search.evaluatedSubsets.toLocaleString()}</strong><small>rapid scaled-forward subsets</small></div>
      <div><span>Exact-checked finalists</span><strong>{exactVerifiedKeys.length}</strong><small>full forward/backward + rate grid</small></div>
      <div><span>Tree bank</span><strong>{result.treeHmmProfiles.length}</strong><small>{bank === undefined ? "cached fixed topologies" : `${bank.uniqueResolvedTopologies} unique · ${bank.unresolvedFits} unresolved fits dropped`}</small></div>
      <div><span>Best multi-tree vs one-tree</span><strong>{multiAdvantage === undefined ? "—" : `${multiAdvantage >= 0 ? "+" : ""}${multiAdvantage.toFixed(2)}`}</strong><small>positive favors the multi-tree subset</small></div>
      <div><span>AICc finite through</span><strong>{bank === undefined ? "—" : `${bank.maximumAiccStates} state${bank.maximumAiccStates === 1 ? "" : "s"}`}</strong><small>n − k − 1 must stay positive</small></div>
    </div>
    {result.treeHmm.criterion === "aicc" && bank !== undefined && bank.maximumAiccStates <= 1 && <p className="method-note method-note--warning"><strong>AICc feasibility warning:</strong> with {result.diagnostics.taxa} taxa and {result.diagnostics.sites} aligned sites, every multi-tree model has n − k − 1 ≤ 0 and therefore infinite AICc. That is a criterion limitation, not numerical likelihood underflow; use AIC or BIC only if that model-selection choice is scientifically appropriate.</p>}
    <div className="figure-card fsart-hypothesis-card">
      <div className="figure-toolbar"><div><strong>Searched topology-subset landscape</strong><span>x = number of topology states · y = Δ{result.treeHmm.criterion.toUpperCase()} on a log scale · outlined nodes received an exact check</span></div><div className="figure-actions"><span>Show Δ ≤</span>{([10, 50, 200, "all"] as const).map((limit) => <button type="button" className={`button button--quiet ${deltaLimit === limit ? "is-active" : ""}`} key={limit} onClick={() => setDeltaLimit(limit)}>{limit}</button>)}<button type="button" className="button button--secondary" onClick={() => downloadHypotheses(hypotheses)}>Hypothesis CSV</button><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "FSART searched hypothesis space")}>Export SVG</button></div></div>
      <div className="figure-scroll"><svg ref={svgRef} className="fsart-hypothesis-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="FSART topology-subset hypothesis search landscape">
        <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="hypothesis-plot-bg" />
        {Array.from({ length: maximumStates }, (_value, index) => index + 1).map((states) => {
          const column = margin.left + (states - 0.5) / maximumStates * plotWidth;
          return <g key={states}><line x1={column} x2={column} y1={margin.top} y2={margin.top + plotHeight} className="hypothesis-grid" /><text x={column} y={height - 28} textAnchor="middle" className="hypothesis-axis-label">{states}</text></g>;
        })}
        <text x={margin.left + plotWidth / 2} y={height - 8} textAnchor="middle" className="hypothesis-axis-title">Topology states in subset</text>
        <text x={18} y={margin.top + plotHeight / 2} transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="hypothesis-axis-title">Δ{result.treeHmm.criterion.toUpperCase()} (log scale; lower is better)</text>
        <text x={margin.left - 8} y={margin.top + 4} textAnchor="end" className="hypothesis-axis-label">0</text>
        <text x={margin.left - 8} y={margin.top + plotHeight} textAnchor="end" className="hypothesis-axis-label">{maximumDelta.toFixed(maximumDelta < 10 ? 1 : 0)}{hypotheses.some((hypothesis) => !Number.isFinite(criterionValue(hypothesis))) ? " / ∞" : ""}</text>
        {edges.map((edge) => {
          const from = hypothesisByKey.get(edge.fromKey)!;
          const to = hypothesisByKey.get(edge.toKey)!;
          return <line key={`${edge.fromKey}-${edge.toKey}-${edge.phase}`} x1={x(from.stateCount, from.key)} y1={y(from)} x2={x(to.stateCount, to.key)} y2={y(to)} className={`hypothesis-edge hypothesis-edge--${edge.move}`} />;
        })}
        {visible.map((hypothesis) => {
          const isSelected = hypothesis.key === selectedKey;
          const isNull = hypothesis.key === search.nullKey;
          const isRapidWinner = hypothesis.key === search.selectedKey;
          const isExactWinner = hypothesis.key === search.exactSelectedKey;
          const classes = ["hypothesis-node", isSelected ? "is-selected" : "", isNull ? "is-null" : "", isRapidWinner ? "is-rapid-winner" : "", isExactWinner ? "is-exact-winner" : "", exactKeys.has(hypothesis.key) ? "is-exact" : "", Number.isFinite(criterionValue(hypothesis)) ? "" : "is-infeasible"].filter(Boolean).join(" ");
          return <g key={hypothesis.key} className={classes} onClick={() => selectHypothesis(hypothesis)}>
            <circle cx={x(hypothesis.stateCount, hypothesis.key)} cy={y(hypothesis)} r={isSelected ? 7 : isNull || isExactWinner ? 5 : 3.2}><title>{`${hypothesis.treeIds.join(" + ")} · rapid ${numberLabel(hypothesis.criterionValue)} · exact ${numberLabel(hypothesis.exactCriterionValue)}`}</title></circle>
            {(isSelected || isNull || isExactWinner) && <text x={x(hypothesis.stateCount, hypothesis.key) + 9} y={y(hypothesis) - 7}>{isSelected ? hypothesis.treeIds.join("+") : isNull ? "null" : "exact best"}</text>}
          </g>;
        })}
      </svg></div>
      <div className="figure-note"><strong>What is drawn:</strong> every node is a subset whose rapid O(sites × states) scaled-forward score was computed. Lines are actual add/drop/swap requests touching the selected node. Exact checks are rings; “∞” nodes are mathematically undefined under AICc, not floating-point failures.</div>
    </div>
    {selected !== undefined && <div className="fsart-hypothesis-inspector">
      <div><span>Selected searched hypothesis</span><strong>{selected.treeIds.join(" + ")}</strong><small>{selected.stateCount} state{selected.stateCount === 1 ? "" : "s"} · k={selected.parameterCount} · rapid resets {selected.expectedResets.toPrecision(3)}</small></div>
      <div><span>Rapid {result.treeHmm.criterion.toUpperCase()}</span><strong>{numberLabel(selected.criterionValue)}</strong><small>screening proxy</small></div>
      <div><span>Exact {result.treeHmm.criterion.toUpperCase()}</span><strong>{numberLabel(selected.exactCriterionValue)}</strong><small>{exactKeys.has(selected.key) ? "full rate-marginalized fit" : "not shortlisted"}</small></div>
      <div><span>Rapid log L</span><strong>{selected.logLikelihood.toFixed(2)}</strong></div>
    </div>}
    {nearby.length > 0 && <div className="fsart-nearby-hypotheses"><span>One-move neighborhood</span>{nearby.map((hypothesis) => <button type="button" key={hypothesis.key} onClick={() => selectHypothesis(hypothesis)}><strong>{hypothesis.treeIds.join(" + ")}</strong><small>{result.treeHmm.criterion.toUpperCase()} {numberLabel(hypothesis.exactCriterionValue ?? hypothesis.criterionValue)}</small></button>)}</div>}
    <div className="fsart-topology-picker">
      <div className="result-toolbar"><span><strong>Alternative topology subset</strong> · choose cached trees directly or click a searched node</span><button type="button" className="button button--primary" disabled={pending || selectedTreeIds.length === 0 || onPolish === undefined} onClick={() => void polish()}>{pending ? "Polishing…" : "Re-estimate trees + polish breakpoints"}</button></div>
      <div className="fsart-topology-grid">{result.treeHmmProfiles.map((profile) => <label key={profile.id} className={checked.has(profile.id) ? "is-selected" : undefined}><input type="checkbox" checked={checked.has(profile.id)} onChange={() => toggleTree(profile.id)} disabled={pending} /><span><strong>{profile.id}</strong><small>{profile.sourceRanges?.map((range) => `${range[0]}–${range[1]}`).join(", ") ?? `${profile.sourceStart}–${profile.sourceEnd}`}</small></span></label>)}</div>
      <p className="figure-note">This action does not rerun the triplet scan. It fits the chosen fixed subset exactly, decodes a minimum-run Viterbi path, refits each selected tree on all ranges assigned to it, rescales every refitted topology at every site, and iterates breakpoint/tree polishing. Independent FastTree fits use the current CPU limit.</p>
      {pending && <div className="fsart-live-status" role="status"><i /><span><strong>{progress?.stage}</strong> · {progress?.message ?? "active"}{progress?.fraction === undefined ? "" : ` · ${Math.round(progress.fraction * 100)}%`}</span></div>}
      {error !== undefined && <div className="validation-issues"><p>{error}</p></div>}
      {onPolish === undefined && <p className="figure-note">Open this saved result in the analysis workspace with its alignment available to enable FastTree re-estimation.</p>}
    </div>
  </div>;
}
