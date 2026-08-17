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

function compareHypotheses(first: TreeHmmSubsetHypothesis, second: TreeHmmSubsetHypothesis): number {
  const firstValue = criterionValue(first);
  const secondValue = criterionValue(second);
  if (Number.isFinite(firstValue) !== Number.isFinite(secondValue)) return Number.isFinite(firstValue) ? -1 : 1;
  return firstValue - secondValue
    || first.stateCount - second.stateCount
    || first.key.localeCompare(second.key);
}

export function fsartHypothesisDeltaY(delta: number, maximumDelta: number, top: number, height: number): number {
  if (!Number.isFinite(delta)) return top + 10;
  return top + height - 10 - Math.log1p(Math.max(0, delta)) / Math.log1p(Math.max(1, maximumDelta)) * (height - 20);
}

export function selectRankedSourceBandHypotheses(
  hypotheses: readonly TreeHmmSubsetHypothesis[],
  nullKey: string,
  limit: number | "all",
): TreeHmmSubsetHypothesis[] {
  const ranked = hypotheses.slice().sort(compareHypotheses);
  const selected = limit === "all" ? ranked : ranked.slice(0, Math.max(0, limit));
  const nullHypothesis = ranked.find((hypothesis) => hypothesis.key === nullKey);
  return nullHypothesis === undefined || selected.some((hypothesis) => hypothesis.key === nullKey)
    ? selected
    : [...selected, nullHypothesis];
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

function profileRanges(profile: FsartAnalysisResult["treeHmmProfiles"][number]): readonly (readonly [number, number])[] {
  return profile.sourceRanges ?? [[profile.sourceStart, profile.sourceEnd]];
}

function sourceColorIndex(treeId: string): number {
  let hash = 0;
  for (let index = 0; index < treeId.length; index += 1) hash = Math.imul(hash, 31) + treeId.charCodeAt(index);
  return Math.abs(hash) % 8;
}

function compactTreeIds(treeIds: readonly string[]): string {
  return treeIds.length <= 8 ? treeIds.join(" + ") : `${treeIds.slice(0, 8).join(" + ")} + ${treeIds.length - 8} more`;
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
  const automaticKey = search?.finalSelectedKey ?? search?.exactSelectedKey ?? search?.selectedKey;
  const automaticHypothesis = hypotheses.find((hypothesis) => hypothesis.key === automaticKey);
  const automaticTreeIds = automaticHypothesis?.treeIds ?? (automaticKey === undefined ? [] : automaticKey.split(",")
    .map((value) => result.treeHmmProfiles[Number(value)]?.id)
    .filter((value): value is string => value !== undefined));
  const initialKey = manualTreeIds === undefined
    ? automaticHypothesis?.key ?? search?.exactSelectedKey ?? search?.selectedKey
    : hypotheses.find((hypothesis) => sameTreeIds(hypothesis.treeIds, manualTreeIds))?.key;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const [selectedTreeIds, setSelectedTreeIds] = useState<readonly string[]>(() =>
    manualTreeIds ?? automaticTreeIds ?? search?.hypotheses?.find((hypothesis) => hypothesis.key === initialKey)?.treeIds ?? result.treeHmm.states.map((state) => state.id));
  const [deltaLimit, setDeltaLimit] = useState<10 | 50 | 200 | "all">(200);
  const [sourceBandLimit, setSourceBandLimit] = useState<20 | 50 | 200 | "all">(20);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<RunProgress>();
  const [error, setError] = useState<string>();
  const svgRef = useRef<SVGSVGElement>(null);
  const sourceBandSvgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const nextSearch = result.treeHmm.initialSubsetSearch ?? result.treeHmm.subsetSearch;
    const nextManual = result.treeHmm.manualPolish?.requestedTreeIds;
    const nextAutomatic = nextSearch?.finalSelectedKey ?? nextSearch?.exactSelectedKey ?? nextSearch?.selectedKey;
    const nextAutomaticHypothesis = nextSearch?.hypotheses?.find((hypothesis) => hypothesis.key === nextAutomatic);
    const nextAutomaticTreeIds = nextAutomaticHypothesis?.treeIds ?? (nextAutomatic === undefined ? [] : nextAutomatic.split(",")
      .map((value) => result.treeHmmProfiles[Number(value)]?.id)
      .filter((value): value is string => value !== undefined));
    const nextKey = nextManual === undefined
      ? nextAutomaticHypothesis?.key ?? nextSearch?.exactSelectedKey ?? nextSearch?.selectedKey
      : nextSearch?.hypotheses?.find((hypothesis) => sameTreeIds(hypothesis.treeIds, nextManual))?.key;
    setSelectedKey(nextKey);
    setSelectedTreeIds(nextManual ?? nextAutomaticTreeIds ?? nextSearch?.hypotheses?.find((hypothesis) => hypothesis.key === nextKey)?.treeIds ?? result.treeHmm.states.map((state) => state.id));
  }, [result]);

  const hypothesisByKey = useMemo(() => new Map(hypotheses.map((hypothesis) => [hypothesis.key, hypothesis])), [hypotheses]);
  const selected = selectedKey === undefined ? undefined : hypothesisByKey.get(selectedKey);
  const checked = new Set(selectedTreeIds);
  const exactKeys = new Set(exactVerifiedKeys);
  const rankedHypotheses = hypotheses.slice().sort(compareHypotheses);
  const rankByKey = new Map(rankedHypotheses.map((hypothesis, index) => [hypothesis.key, index + 1]));
  const bestFinite = rankedHypotheses.map(criterionValue).find(Number.isFinite);
  const bestOne = hypotheses.filter((hypothesis) => hypothesis.stateCount === 1 && Number.isFinite(criterionValue(hypothesis))).sort((a, b) => criterionValue(a) - criterionValue(b))[0];
  const bestMultiple = hypotheses.filter((hypothesis) => hypothesis.stateCount > 1 && Number.isFinite(criterionValue(hypothesis))).sort((a, b) => criterionValue(a) - criterionValue(b))[0];
  const visible = hypotheses.filter((hypothesis) => {
    if (hypothesis.key === selectedKey || hypothesis.key === search?.nullKey || hypothesis.key === search?.finalSelectedKey || exactKeys.has(hypothesis.key)) return true;
    if (deltaLimit === "all") return true;
    const value = criterionValue(hypothesis);
    return Number.isFinite(value) && bestFinite !== undefined && value - bestFinite <= deltaLimit;
  });

  const width = 1040;
  const height = 430;
  const margin = { left: 76, right: 24, top: 30, bottom: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximumStates = Math.max(1, ...hypotheses.map((hypothesis) => hypothesis.stateCount));
  const stateTickStep = maximumStates <= 12 ? 1 : Math.ceil(maximumStates / 10);
  const stateTicks = Array.from(new Set([
    1,
    ...Array.from({ length: Math.ceil(maximumStates / stateTickStep) }, (_value, index) => Math.min(maximumStates, 1 + index * stateTickStep)),
    maximumStates,
  ])).sort((first, second) => first - second);
  const finiteDeltas = visible.map((hypothesis) => criterionValue(hypothesis) - (bestFinite ?? 0)).filter(Number.isFinite);
  const maximumDelta = Math.max(1, ...finiteDeltas);
  const x = (states: number, key: string): number => margin.left
    + (states - 0.5 + 0.52 * stableJitter(key)) / maximumStates * plotWidth;
  const y = (hypothesis: TreeHmmSubsetHypothesis): number => {
    const value = criterionValue(hypothesis);
    const delta = bestFinite === undefined ? Number.POSITIVE_INFINITY : value - bestFinite;
    return fsartHypothesisDeltaY(delta, maximumDelta, margin.top, plotHeight);
  };
  const visibleKeys = new Set(visible.map((hypothesis) => hypothesis.key));
  const edges = transitions.filter((transition) =>
    visibleKeys.has(transition.fromKey) && visibleKeys.has(transition.toKey)
    && (transition.fromKey === selectedKey || transition.toKey === selectedKey));
  const nearby = selected === undefined ? [] : hypotheses.filter((hypothesis) =>
    hypothesis.key !== selected.key && moveDistance(hypothesis.profileIndexes, selected.profileIndexes) <= 2)
    .sort((first, second) => criterionValue(first) - criterionValue(second)).slice(0, 8);
  const sourceBandHypotheses = selectRankedSourceBandHypotheses(hypotheses, search?.nullKey ?? "", sourceBandLimit);
  const profileById = new Map(result.treeHmmProfiles.map((profile) => [profile.id, profile]));
  const alignmentSites = Math.max(1, result.diagnostics.sites);
  const sourceWidth = 1120;
  const sourceMargin = { left: 238, right: 24, top: 38, bottom: 42 };
  const sourcePlotWidth = sourceWidth - sourceMargin.left - sourceMargin.right;
  const sourceRowHeights = sourceBandHypotheses.map((hypothesis) => Math.max(28, 14 + 2 * hypothesis.stateCount));
  const sourceRowOffsets: number[] = [];
  let sourcePlotHeight = 0;
  for (const rowHeight of sourceRowHeights) {
    sourceRowOffsets.push(sourcePlotHeight);
    sourcePlotHeight += rowHeight;
  }
  const sourceHeight = sourceMargin.top + sourcePlotHeight + sourceMargin.bottom;
  const sourceX = (siteBoundary: number): number => sourceMargin.left
    + Math.max(0, Math.min(alignmentSites, siteBoundary)) / alignmentSites * sourcePlotWidth;
  const sourceTickX = (site: number): number => sourceMargin.left
    + (site - 1) / Math.max(1, alignmentSites - 1) * sourcePlotWidth;
  const sourceTicks = Array.from(new Set([0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => Math.min(alignmentSites, Math.max(1, Math.round(1 + fraction * (alignmentSites - 1)))))));
  const stateCountForKey = (candidateKey: string | undefined): number | undefined => candidateKey === undefined
    ? undefined
    : hypothesisByKey.get(candidateKey)?.stateCount ?? (candidateKey.length === 0 ? 0 : candidateKey.split(",").length);
  const beamBoundaryWinningStages = [
    ["rapid winner", search?.selectedKey],
    ["exact-finalist winner", search?.exactSelectedKey],
    ["final automatic subset", search?.finalSelectedKey],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined && stateCountForKey(entry[1]) === search?.maximumStates)
    .map(([label]) => label);
  const legacyBoundaryUnprobed = search !== undefined
    && search.floatingIterationLimit === undefined
    && search.maximumStates < result.treeHmmProfiles.length
    && maximumStates <= search.maximumStates
    && beamBoundaryWinningStages.length > 0;

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
    setProgress({ stage: "initialization", fraction: 0, message: "Preparing selected full-tree hypothesis" });
    try {
      await onPolish(result.treeHmmProfiles.filter((profile) => checked.has(profile.id)).map((profile) => profile.id), setProgress);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  if (search === undefined) return <div className="figure-empty"><strong>No combinatorial hypothesis search was run.</strong><span>The tree family did not produce at least two usable resolved full-tree profiles, or topology-HMM search was disabled.</span></div>;
  if (hypotheses.length === 0) return <div className="figure-empty"><strong>This saved result predates the searchable hypothesis audit.</strong><span>Rerun FSART to retain and inspect every evaluated full-tree subset.</span></div>;

  const bank = result.topologyBankAudit;
  const multiAdvantage = bestOne === undefined || bestMultiple === undefined ? undefined : criterionValue(bestOne) - criterionValue(bestMultiple);
  return <div className="fsart-hypothesis-space">
    <div className="result-stats fsart-hypothesis-stats">
      <div><span>Actually evaluated</span><strong>{search.evaluatedSubsets.toLocaleString()}</strong><small>rapid scaled-forward subsets</small></div>
      <div><span>Exact-checked</span><strong>{exactVerifiedKeys.length}</strong><small>finalists and floating cleanup</small></div>
      <div><span>Scored full-tree set</span><strong>{result.treeHmmProfiles.length}</strong><small>{bank === undefined ? "independent frozen fits" : `${bank.distinctResolvedTopologies} topology signatures · same-topology fits preserved`}</small></div>
      {bank !== undefined && <div><span>Fit-to-search accounting</span><strong>{bank.familyFits} → {result.treeHmmProfiles.length}</strong><small>{bank.unresolvedFits} structurally unresolved · {bank.truncatedFullTreeFits} excluded by Scored full-tree limit · {bank.failedProfileScores} scoring failures</small></div>}
      <div><span>Beam expansion depth</span><strong>{search.maximumStates} tree{search.maximumStates === 1 ? "" : "s"}</strong><small>floating moves can grow beyond this</small></div>
      <div><span>Largest subset evaluated</span><strong>{maximumStates} tree{maximumStates === 1 ? "" : "s"}</strong><small>{result.treeHmmProfiles.length} fitted-tree candidates available</small></div>
      <div><span>Best multi-tree vs one-tree</span><strong>{multiAdvantage === undefined ? "—" : `${multiAdvantage >= 0 ? "+" : ""}${multiAdvantage.toFixed(2)}`}</strong><small>positive favors the multi-tree subset</small></div>
      <div><span>Final automatic subset</span><strong>{automaticTreeIds.join(" + ") || "—"}</strong><small>after exact floating cleanup</small></div>
      <div><span>AICc finite through</span><strong>{bank === undefined ? "—" : `${bank.maximumAiccStates} state${bank.maximumAiccStates === 1 ? "" : "s"}`}</strong><small>n − k − 1 must stay positive</small></div>
    </div>
    {bank !== undefined && bank.unresolvedFits > 0 && <p className="method-note"><strong>Why fitted trees can be absent from the scored set:</strong> all {bank.familyFits} source windows completed a FastTree fit, but {bank.unresolvedFits} output tree{bank.unresolvedFits === 1 ? " was" : "s were"} excluded because the unrooted structure had fewer than n − 3 nontrivial splits. This check ignores root placement and branch lengths: a binary zero-length edge is retained; a genuine internal multifurcation is not.</p>}
    {bank !== undefined && bank.truncatedFullTreeFits > 0 && <p className="method-note fsart-critical-warning" role="alert"><strong>FULL-TREE CANDIDATE TRUNCATION:</strong> {bank.truncatedFullTreeFits} of {bank.resolvedFits} structurally resolved source-window trees were excluded before likelihood scoring and hypothesis search because the run's <em>Scored full-tree limit</em> was {bank.resolvedFits - bank.truncatedFullTreeFits}. This search did not consider the complete resolved tree family. Raise the setting and rerun before interpreting the selected hypothesis.</p>}
    {result.treeHmm.criterion === "aicc" && bank !== undefined && bank.maximumAiccStates <= 1 && <p className="method-note method-note--warning"><strong>AICc feasibility warning:</strong> with {result.diagnostics.taxa} taxa and {result.diagnostics.sites} aligned sites, every multi-tree model has n − k − 1 ≤ 0 and therefore infinite AICc. That is a criterion limitation, not numerical likelihood underflow; use AIC or BIC only if that model-selection choice is scientifically appropriate.</p>}
    {legacyBoundaryUnprobed && <p className="method-note fsart-critical-warning" role="alert"><strong>LEGACY HYPOTHESIS-SIZE BOUNDARY:</strong> the {beamBoundaryWinningStages.join(", ")} used {search.maximumStates} trees, but this saved result contains no larger evaluated hypothesis even though {result.treeHmmProfiles.length} fitted-tree candidates were available. It predates unrestricted floating additions; rerun FSART before treating the selected size as a local optimum.</p>}
    {!search.converged && search.floatingIterationLimit !== undefined && <p className="method-note fsart-critical-warning" role="alert"><strong>FLOATING SEARCH ITERATION LIMIT REACHED:</strong> add/drop/swap search used its emergency budget of {search.floatingIterationLimit} improving moves without establishing a one-move local optimum. The selected subset is search-limited and should not be interpreted as locally optimal.</p>}
    <div className="figure-card fsart-hypothesis-card">
      <div className="figure-toolbar"><div><strong>Searched topology-subset landscape</strong><span>x = number of full-tree states · y = Δ{result.treeHmm.criterion.toUpperCase()} on a log scale, with larger values higher · outlined nodes received an exact check</span></div><div className="figure-actions"><span>{visible.length.toLocaleString()} of {hypotheses.length.toLocaleString()} shown · Δ ≤</span>{([10, 50, 200, "all"] as const).map((limit) => <button type="button" className={`button button--quiet ${deltaLimit === limit ? "is-active" : ""}`} key={limit} onClick={() => setDeltaLimit(limit)}>{limit}</button>)}<button type="button" className="button button--secondary" onClick={() => downloadHypotheses(hypotheses)}>Hypothesis CSV</button><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "FSART searched hypothesis space")}>Export SVG</button></div></div>
      <div className="figure-scroll"><svg ref={svgRef} className="fsart-hypothesis-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="FSART full-tree-subset hypothesis search landscape">
        <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="hypothesis-plot-bg" />
        {stateTicks.map((states) => {
          const column = margin.left + (states - 0.5) / maximumStates * plotWidth;
          return <g key={states}><line x1={column} x2={column} y1={margin.top} y2={margin.top + plotHeight} className="hypothesis-grid" /><text x={column} y={height - 28} textAnchor="middle" className="hypothesis-axis-label">{states}</text></g>;
        })}
        <text x={margin.left + plotWidth / 2} y={height - 8} textAnchor="middle" className="hypothesis-axis-title">Full-tree states in subset</text>
        <text x={18} y={margin.top + plotHeight / 2} transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="hypothesis-axis-title">Δ{result.treeHmm.criterion.toUpperCase()} (log scale; lower is better)</text>
        <text x={margin.left - 8} y={margin.top + 4} textAnchor="end" className="hypothesis-axis-label">{maximumDelta.toFixed(maximumDelta < 10 ? 1 : 0)}{hypotheses.some((hypothesis) => !Number.isFinite(criterionValue(hypothesis))) ? " / ∞" : ""}</text>
        <text x={margin.left - 8} y={margin.top + plotHeight} textAnchor="end" className="hypothesis-axis-label">0</text>
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
          const isFinalWinner = hypothesis.key === search.finalSelectedKey;
          const roles = [isNull ? "null" : "", isRapidWinner ? "rapid best" : "", isExactWinner ? "exact finalist best" : "", isFinalWinner ? "final automatic" : ""].filter(Boolean);
          const classes = ["hypothesis-node", isSelected ? "is-selected" : "", isNull ? "is-null" : "", isRapidWinner ? "is-rapid-winner" : "", isExactWinner ? "is-exact-winner" : "", isFinalWinner ? "is-final-winner" : "", exactKeys.has(hypothesis.key) ? "is-exact" : "", Number.isFinite(criterionValue(hypothesis)) ? "" : "is-infeasible"].filter(Boolean).join(" ");
          return <g key={hypothesis.key} className={classes} onClick={() => selectHypothesis(hypothesis)}>
            <circle cx={x(hypothesis.stateCount, hypothesis.key)} cy={y(hypothesis)} r={isSelected ? 7 : isNull || isExactWinner || isFinalWinner ? 5 : 3.2}><title>{`${hypothesis.treeIds.join(" + ")} · ${roles.join(" · ") || "evaluated"} · rapid ${numberLabel(hypothesis.criterionValue)} · exact ${numberLabel(hypothesis.exactCriterionValue)}`}</title></circle>
            {(isSelected || roles.length > 0) && <text x={x(hypothesis.stateCount, hypothesis.key) + 9} y={y(hypothesis) - 7}>{isSelected ? `${hypothesis.treeIds.join("+")} · ${roles.join("/") || "selected"}` : roles.join("/")}</text>}
          </g>;
        })}
      </svg></div>
      <div className="figure-note"><strong>What is drawn:</strong> every node is a subset whose rapid O(sites × states) scaled-forward score was computed. Lines are actual add/drop/swap requests touching the selected node. Exact checks are rings; rapid, exact-shortlist, final-cleanup, and null roles are labeled independently. “∞” nodes are mathematically undefined under AICc, not floating-point failures.</div>
    </div>
    <div className="figure-card fsart-source-band-card">
      <div className="figure-toolbar"><div><strong>Ranked hypotheses and tree-estimation sources</strong><span>best criterion at top · each thin bar spans the alignment region used to fit one retained full tree</span></div><div className="figure-actions"><span>Show top</span>{([20, 50, 200, "all"] as const).map((limit) => <button type="button" className={`button button--quiet ${sourceBandLimit === limit ? "is-active" : ""}`} key={limit} onClick={() => setSourceBandLimit(limit)}>{limit}</button>)}<span>+ null</span><button type="button" className="button button--secondary button--svg" onClick={() => sourceBandSvgRef.current !== null && downloadSvg(sourceBandSvgRef.current, "FSART ranked hypothesis tree sources")}>Export SVG</button></div></div>
      <div className="figure-scroll"><svg ref={sourceBandSvgRef} className="fsart-source-band-svg" viewBox={`0 0 ${sourceWidth} ${sourceHeight}`} role="img" aria-label="FSART hypotheses ranked by information criterion with source ranges for every retained full tree">
        <rect x={sourceMargin.left} y={sourceMargin.top} width={sourcePlotWidth} height={sourcePlotHeight} className="hypothesis-plot-bg" />
        {sourceTicks.map((site) => {
          const position = sourceTickX(site);
          return <g key={site}><line x1={position} x2={position} y1={sourceMargin.top} y2={sourceMargin.top + sourcePlotHeight} className="hypothesis-grid" /><text x={position} y={sourceMargin.top - 12} textAnchor={site === 1 ? "start" : site === alignmentSites ? "end" : "middle"} className="hypothesis-axis-label">{site.toLocaleString()}</text></g>;
        })}
        <text x={sourceMargin.left + sourcePlotWidth / 2} y={sourceHeight - 8} textAnchor="middle" className="hypothesis-axis-title">Tree-estimation source coordinates (aligned nucleotide sites)</text>
        {sourceBandHypotheses.map((hypothesis, rowIndex) => {
          const rowTop = sourceMargin.top + sourceRowOffsets[rowIndex]!;
          const rowHeight = sourceRowHeights[rowIndex]!;
          const profiles = hypothesis.treeIds.map((treeId) => profileById.get(treeId)).filter((profile): profile is NonNullable<typeof profile> => profile !== undefined)
            .slice().sort((first, second) => first.sourceStart - second.sourceStart || first.sourceEnd - second.sourceEnd || first.id.localeCompare(second.id));
          const laneHeight = (rowHeight - 11) / Math.max(1, profiles.length);
          const barHeight = Math.max(1, Math.min(2.4, laneHeight * 0.68));
          const value = criterionValue(hypothesis);
          const delta = Number.isFinite(value) && bestFinite !== undefined ? Math.max(0, value - bestFinite) : Number.POSITIVE_INFINITY;
          const isSelected = hypothesis.key === selectedKey;
          const isNull = hypothesis.key === search.nullKey;
          const roles = [isNull ? "null" : "", hypothesis.key === search.selectedKey ? "rapid best" : "", hypothesis.key === search.exactSelectedKey ? "exact best" : "", hypothesis.key === search.finalSelectedKey ? "final" : ""].filter(Boolean);
          return <g key={hypothesis.key} className={`hypothesis-source-row ${isSelected ? "is-selected" : ""}`} onClick={() => selectHypothesis(hypothesis)}>
            <title>{`Rank ${rankByKey.get(hypothesis.key)} · ${hypothesis.treeIds.join(" + ")} · ${result.treeHmm.criterion.toUpperCase()} ${numberLabel(value)}`}</title>
            <rect x={0} y={rowTop} width={sourceWidth} height={rowHeight} className="hypothesis-source-row-bg" />
            <text x={sourceMargin.left - 12} y={rowTop + 10} textAnchor="end" className="hypothesis-source-rank">#{rankByKey.get(hypothesis.key)} · Δ{result.treeHmm.criterion.toUpperCase()} {Number.isFinite(delta) ? delta.toFixed(delta < 10 ? 2 : 1) : "∞"} · {hypothesis.stateCount} tree{hypothesis.stateCount === 1 ? "" : "s"}{roles.length > 0 ? ` · ${roles.join("/")}` : ""}</text>
            <text x={sourceMargin.left - 12} y={rowTop + 21} textAnchor="end" className="hypothesis-source-ids">{compactTreeIds(hypothesis.treeIds)}</text>
            {profiles.flatMap((profile, profileIndex) => profileRanges(profile).map(([start, end], rangeIndex) => {
              const x1 = sourceX(Math.max(0, start - 1));
              const x2 = sourceX(Math.min(alignmentSites, end));
              const rangeLabel = profileRanges(profile).map((range) => `${range[0]}–${range[1]}`).join(", ");
              return <rect key={`${profile.id}-${rangeIndex}`} data-tree-id={profile.id} x={x1} y={rowTop + 6 + profileIndex * laneHeight} width={Math.max(1, x2 - x1)} height={barHeight} className={`hypothesis-source-bar hypothesis-source-bar--${sourceColorIndex(profile.id)} ${start === 1 && end === alignmentSites ? "is-global" : ""}`}><title>{`${profile.id} · fitted on ${rangeLabel} · hypothesis rank ${rankByKey.get(hypothesis.key)} · ${result.treeHmm.criterion.toUpperCase()} ${numberLabel(value)}`}</title></rect>;
            }))}
          </g>;
        })}
      </svg></div>
      <div className="figure-note"><strong>How to read it:</strong> rows use the same searched hypotheses and criterion values as the landscape above, sorted from best to worst. Bars on separate micro-lanes are independently fitted full trees; their horizontal spans are the source sites used for those fits, including every disjoint source range when present. Hover a bar for its tree ID and exact coordinates; click a row to select that hypothesis. The null is always included even when it falls outside the displayed rank cutoff.</div>
    </div>
    {selected !== undefined && <div className="fsart-hypothesis-inspector">
      <div><span>Selected searched hypothesis</span><strong>{selected.treeIds.join(" + ")}</strong><small>{selected.stateCount} state{selected.stateCount === 1 ? "" : "s"} · k={selected.parameterCount} · rapid resets {selected.expectedResets.toPrecision(3)}</small></div>
      <div><span>Rapid {result.treeHmm.criterion.toUpperCase()}</span><strong>{numberLabel(selected.criterionValue)}</strong><small>screening proxy</small></div>
      <div><span>Exact {result.treeHmm.criterion.toUpperCase()}</span><strong>{numberLabel(selected.exactCriterionValue)}</strong><small>{exactKeys.has(selected.key) ? "full rate-marginalized fit" : "not exact-checked"}</small></div>
      <div><span>Rapid log L</span><strong>{selected.logLikelihood.toFixed(2)}</strong></div>
    </div>}
    {nearby.length > 0 && <div className="fsart-nearby-hypotheses"><span>One-move neighborhood</span>{nearby.map((hypothesis) => <button type="button" key={hypothesis.key} onClick={() => selectHypothesis(hypothesis)}><strong>{hypothesis.treeIds.join(" + ")}</strong><small>{result.treeHmm.criterion.toUpperCase()} {numberLabel(hypothesis.exactCriterionValue ?? hypothesis.criterionValue)}</small></button>)}</div>}
    <div className="fsart-topology-picker">
      <div className="result-toolbar"><span><strong>Alternative full-tree subset</strong> · choose independently fitted trees directly or click a searched node</span><button type="button" className="button button--primary" disabled={pending || selectedTreeIds.length === 0 || onPolish === undefined} onClick={() => void polish()}>{pending ? "Polishing…" : "Re-estimate trees + polish breakpoints"}</button></div>
      <div className="fsart-topology-grid">{result.treeHmmProfiles.map((profile) => <label key={profile.id} className={checked.has(profile.id) ? "is-selected" : undefined}><input type="checkbox" checked={checked.has(profile.id)} onChange={() => toggleTree(profile.id)} disabled={pending} /><span><strong>{profile.id}</strong><small>{profile.sourceRanges?.map((range) => `${range[0]}–${range[1]}`).join(", ") ?? `${profile.sourceStart}–${profile.sourceEnd}`}</small></span></label>)}</div>
      <p className="figure-note">This action does not rerun the triplet scan. It fits the chosen fixed subset exactly, decodes a minimum-run Viterbi path, independently refits each selected full tree on all ranges assigned to it, freezes each refitted tree's branch lengths and Gamma shape while rescoring every site, and iterates breakpoint/tree polishing. Same-topology fits remain separate. Independent FastTree fits use the current CPU limit.</p>
      {pending && <div className="fsart-live-status" role="status"><i /><span><strong>{progress?.stage}</strong> · {progress?.message ?? "active"}{progress?.fraction === undefined ? "" : ` · ${Math.round(progress.fraction * 100)}%`}</span></div>}
      {error !== undefined && <div className="validation-issues"><p>{error}</p></div>}
      {onPolish === undefined && <p className="figure-note">Open this saved result in the analysis workspace with its alignment available to enable FastTree re-estimation.</p>}
    </div>
  </div>;
}
