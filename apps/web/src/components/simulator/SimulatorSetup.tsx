import React, { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  BALANCED_GTR,
  decodeSimulatorConfig,
  encodeSimulatorConfig,
  FLU_DEMO_GTR,
  presetCurves,
  TRANSITION_RICH_GTR,
  createCurveEvaluator,
  type CodonSimulationConfig,
  type CurveSpec,
  type GtrSpecification,
  type MarginalDistribution,
  type SimulatorConfig,
  type ScuffCodonConfig,
  type StandardCodonConfig,
  type TreePreset,
} from "@phylo-workbench/model-simulator/browser-source";
import { CONTEXT_DEPENDENT_GENETIC_CODE_IDS, GENETIC_CODE_OPTIONS } from "@phylo-workbench/model-diffubar/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import { CommittedNumberInput } from "../CommittedNumberInput.js";

export interface SimulatorSetupProps {
  readonly parameters: ParameterValues;
  readonly onChange: (parameters: ParameterValues) => void;
  readonly disabled?: boolean;
}

function replaceConfig(parameters: ParameterValues, config: SimulatorConfig, onChange: SimulatorSetupProps["onChange"]): void {
  onChange({ ...parameters, simulatorConfig: encodeSimulatorConfig(config) });
}

function logGamma(value: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019571e-6, 1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index]! / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function MarginalControl({ label, value, onChange, color = "#167a70" }: { readonly label: string; readonly value: MarginalDistribution; readonly onChange: (value: MarginalDistribution) => void; readonly color?: string }) {
  const shape = value.kind === "gamma" ? value.shape : 1;
  const maximum = Math.max(0.02, value.mean * (value.kind === "gamma" ? 4.5 : 2));
  const samples = Array.from({ length: 80 }, (_, index) => {
    const x = maximum * (index + 0.25) / 80;
    if (value.kind === "fixed") return { x, y: Math.exp(-0.5 * ((x - value.mean) / Math.max(maximum / 80, 1e-5)) ** 2) };
    const scale = Math.max(1e-12, value.mean / shape);
    const logDensity = (shape - 1) * Math.log(Math.max(x, 1e-12)) - x / scale - logGamma(shape) - shape * Math.log(scale);
    return { x, y: Math.exp(Math.max(-700, logDensity)) };
  });
  const peak = Math.max(...samples.map((sample) => sample.y), 1e-12);
  const path = samples.map((sample, index) => `${index === 0 ? "M" : "L"}${4 + 172 * sample.x / maximum},${47 - 40 * sample.y / peak}`).join(" ");
  return <div className="sim-marginal">
    <div className="sim-marginal__heading"><strong>{label}</strong><select value={value.kind} onChange={(event) => onChange(event.target.value === "gamma" ? { kind: "gamma", mean: value.mean, shape: 2 } : { kind: "fixed", mean: value.mean })}><option value="fixed">Fixed</option><option value="gamma">Gamma-distributed by site</option></select></div>
    <div className="sim-marginal__body"><label><span>Mean</span><CommittedNumberInput integer={false} min={0} step="0.05" value={value.mean} onCommit={(mean) => onChange({ ...value, mean })} /></label>{value.kind === "gamma" && <label><span>Shape</span><CommittedNumberInput integer={false} min={0.03} step="0.1" value={value.shape} onCommit={(nextShape) => onChange({ ...value, shape: nextShape })} /></label>}<svg viewBox="0 0 180 54" aria-label={`${label} distribution`}><path d={`${path} L176,49 L4,49 Z`} fill={color} fillOpacity="0.18" /><path d={path} fill="none" stroke={color} strokeWidth="1.5" /><line x1="4" x2="176" y1="49" y2="49" stroke="#aab7b2" /><text x="4" y="53" fontSize="5" fill="#71807c">0</text><text x="176" y="53" textAnchor="end" fontSize="5" fill="#71807c">{maximum.toPrecision(2)}</text></svg></div>
  </div>;
}

function curvePath(curve: CurveSpec, horizon: number, yRange: readonly [number, number]): string {
  const evaluate = createCurveEvaluator(curve);
  const transform = (value: number): number => curve.space === "log" ? Math.log(Math.max(value, 1e-12)) : value;
  return Array.from({ length: 161 }, (_, index) => {
    const time = horizon * index / 160;
    const value = transform(evaluate(time));
    const y = 137 - 108 * (value - yRange[0]) / Math.max(1e-12, yRange[1] - yRange[0]);
    return `${index === 0 ? "M" : "L"}${48 + 548 * time / horizon},${y}`;
  }).join(" ");
}

function CurveEditor({ title, curve, horizon, color, onChange }: { readonly title: string; readonly curve: CurveSpec; readonly horizon: number; readonly color: string; readonly onChange: (curve: CurveSpec) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number>();
  const transformed = curve.points.map((point) => curve.space === "log" ? Math.log(Math.max(point.value, 1e-12)) : point.value);
  const rawMin = Math.min(...transformed);
  const rawMax = Math.max(...transformed);
  const padding = Math.max((rawMax - rawMin) * 0.2, curve.space === "log" ? 0.5 : Math.max(1, rawMax * 0.2));
  const range: [number, number] = [Math.max(curve.space === "log" ? -27 : 0, rawMin - padding), rawMax + padding];
  const fromPointer = (event: ReactPointerEvent<SVGSVGElement>): { time: number; value: number } => {
    const bounds = svgRef.current!.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * 620 / bounds.width;
    const y = (event.clientY - bounds.top) * 170 / bounds.height;
    const time = Math.max(0, Math.min(horizon, (x - 48) * horizon / 548));
    const transformedValue = range[0] + (137 - Math.max(29, Math.min(137, y))) * (range[1] - range[0]) / 108;
    return { time, value: curve.space === "log" ? Math.exp(transformedValue) : Math.max(0, transformedValue) };
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag === undefined) return;
    const point = fromPointer(event);
    const previous = curve.points[drag - 1]?.time ?? 0;
    const next = curve.points[drag + 1]?.time ?? horizon;
    const time = drag === 0 ? 0 : drag === curve.points.length - 1 ? horizon : Math.max(previous + horizon * 0.005, Math.min(next - horizon * 0.005, point.time));
    onChange({ ...curve, points: curve.points.map((entry, index) => index === drag ? { time, value: point.value } : entry) });
  };
  const add = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if ((event.target as SVGElement).tagName === "circle") return;
    const point = fromPointer(event);
    onChange({ ...curve, points: [...curve.points, point].sort((left, right) => left.time - right.time) });
  };
  return <div className="sim-curve-editor">
    <div className="sim-curve-editor__heading"><strong>{title}</strong><label>Interpolation <select value={curve.space} onChange={(event) => onChange({ ...curve, space: event.target.value as CurveSpec["space"] })}><option value="log">Log-PCHIP</option><option value="linear">Linear-scale PCHIP</option></select></label></div>
    <svg ref={svgRef} viewBox="0 0 620 170" onDoubleClick={add} onPointerMove={move} onPointerUp={() => setDrag(undefined)} onPointerCancel={() => setDrag(undefined)}>
      <rect x="48" y="29" width="548" height="108" fill="#fbfcfb" stroke="#dce3de" />
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}><line x1={48 + 548 * fraction} x2={48 + 548 * fraction} y1="29" y2="137" stroke="#edf0ed" /><text x={48 + 548 * fraction} y="153" textAnchor="middle" fontSize="8" fill="#71807c">{(horizon * fraction).toPrecision(3)}</text></g>)}
      <path d={curvePath(curve, horizon, range)} fill="none" stroke={color} strokeWidth="2.5" />
      {curve.points.map((point, index) => {
        const value = curve.space === "log" ? Math.log(Math.max(point.value, 1e-12)) : point.value;
        const x = 48 + 548 * point.time / horizon;
        const y = 137 - 108 * (value - range[0]) / Math.max(1e-12, range[1] - range[0]);
        return <circle key={`${index}-${point.time}`} cx={x} cy={y} r="5" fill="#fff" stroke={color} strokeWidth="2.5" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag(index); }} />;
      })}
      <text transform="translate(12 84) rotate(-90)" textAnchor="middle" fontSize="8" fill="#52635f">{curve.space === "log" ? "log scale" : "linear scale"}</text><text x="322" y="166" textAnchor="middle" fontSize="8" fill="#52635f">time before most recent sample</text>
    </svg>
    <div className="sim-curve-points">{curve.points.map((point, index) => <div key={index}><span>{index + 1}</span><CommittedNumberInput aria-label={`Point ${index + 1} time`} integer={false} min={0} max={horizon} value={point.time} onCommit={(time) => onChange({ ...curve, points: curve.points.map((entry, i) => i === index ? { ...entry, time } : entry).sort((a, b) => a.time - b.time) })} /><CommittedNumberInput aria-label={`Point ${index + 1} value`} integer={false} min={0} value={point.value} onCommit={(value) => onChange({ ...curve, points: curve.points.map((entry, i) => i === index ? { ...entry, value } : entry) })} /><button type="button" disabled={curve.points.length <= 2 || index === 0 || index === curve.points.length - 1} onClick={() => onChange({ ...curve, points: curve.points.filter((_, i) => i !== index) })}>×</button></div>)}</div>
    <small>Drag control points. Double-click the curve to add one; endpoint times remain fixed. The shape-preserving cubic cannot overshoot between monotone controls.</small>
  </div>;
}

function numberField(label: string, value: number, onCommit: (value: number) => void, options: { min?: number; max?: number; step?: number; integer?: boolean; note?: string } = {}) {
  return <label className="sim-field"><span>{label}</span><CommittedNumberInput value={value} onCommit={onCommit} integer={options.integer ?? false} min={options.min} max={options.max} step={options.step} />{options.note !== undefined && <small>{options.note}</small>}</label>;
}

const GTR_PRESETS: Readonly<Record<string, GtrSpecification>> = { "flu-demo": FLU_DEMO_GTR, "transition-rich": TRANSITION_RICH_GTR, balanced: BALANCED_GTR };
const PAIRS = ["A↔C", "A↔G", "A↔T", "C↔G", "C↔T", "G↔T"];

export function SimulatorSetup({ parameters, onChange, disabled = false }: SimulatorSetupProps) {
  const config = useMemo(() => decodeSimulatorConfig(parameters.simulatorConfig), [parameters.simulatorConfig]);
  const setConfig = (next: SimulatorConfig): void => replaceConfig(parameters, next, onChange);
  const setTree = (tree: SimulatorConfig["tree"]): void => setConfig({ ...config, tree });
  const setCodon = (codon: CodonSimulationConfig): void => setConfig({ ...config, codon });
  const applyPreset = (preset: Exclude<TreePreset, "custom">): void => setTree({ ...config.tree, preset, ...presetCurves(preset, config.tree.horizon, config.tree.observedTips) });
  const initializePopulation = (name: string): void => {
    const source = name === "sin-linear" ? { ...presetCurves("seasonal", config.tree.horizon, config.tree.observedTips).population, space: "linear" as const } : presetCurves(name === "sin-log" ? "seasonal" : name as Exclude<TreePreset, "custom">, config.tree.horizon, config.tree.observedTips).population;
    setTree({ ...config.tree, preset: "custom", population: source });
  };
  const initializeSampling = (name: string): void => {
    const source = name === "contemporaneous" ? presetCurves("constant", config.tree.horizon, config.tree.observedTips).sampling : presetCurves(name as Exclude<TreePreset, "custom">, config.tree.horizon, config.tree.observedTips).sampling;
    setTree({ ...config.tree, preset: "custom", sampling: source, initialTips: name === "contemporaneous" ? config.tree.observedTips : Math.min(config.tree.initialTips, 3) });
  };
  const changeEngine = (engine: "mg94" | "scuff"): void => {
    if (engine === config.codon.engine) return;
    const common = { sites: config.codon.sites, geneticCodeId: config.codon.geneticCodeId, gtr: config.codon.gtr, alpha: config.codon.alpha };
    setCodon(engine === "mg94"
      ? { engine, ...common, omega: { kind: "gamma", mean: 0.55, shape: 0.8 } }
      : { engine, ...common, eventRate: { kind: "gamma", mean: 12, shape: 3 }, equilibriumSigma: { kind: "gamma", mean: 2.2, shape: 8 }, mixingRate: { kind: "gamma", mean: 1, shape: 3 }, burninTime: 3, diagnosticTime: 4 });
  };
  const setGtr = (gtr: GtrSpecification): void => setCodon({ ...config.codon, gtr });
  const updateMg94 = (patch: Partial<StandardCodonConfig>): void => { if (config.codon.engine === "mg94") setCodon({ ...config.codon, ...patch }); };
  const updateScuff = (patch: Partial<ScuffCodonConfig>): void => { if (config.codon.engine === "scuff") setCodon({ ...config.codon, ...patch }); };

  return <fieldset className="simulator-setup" disabled={disabled}>
    <details open className="sim-panel"><summary><strong>1 · Sample genealogies</strong><span>Heterochronous coalescent · explicit calendar-time axis</span></summary><div className="sim-panel__body">
      <div className="sim-preset-row"><label><span>Standard design</span><select value={config.tree.preset} onChange={(event) => event.target.value === "custom" ? setTree({ ...config.tree, preset: "custom" }) : applyPreset(event.target.value as Exclude<TreePreset, "custom">)}><option value="constant">Constant population · contemporaneous</option><option value="serial">Constant population · serial sampling</option><option value="exponential">Exponential growth</option><option value="logistic">Logistic epidemic</option><option value="seasonal">Seasonal population and sampling</option><option value="bottleneck">Population bottleneck</option><option value="ladder">Rapid ladder-like sampling</option><option value="custom">Custom editable curves</option></select></label><span className="sim-equation">λ<sub>coal</sub>(t)=C(k,2)/(ploidy·N<sub>e</sub>(t))</span></div>
      <div className="sim-compact-grid">{numberField("Observed tips", config.tree.observedTips, (observedTips) => setTree({ ...config.tree, observedTips, initialTips: Math.min(config.tree.initialTips, observedTips) }), { min: 2, max: 2000, integer: true })}{numberField("Initial tips at t=0", config.tree.initialTips, (initialTips) => setTree({ ...config.tree, initialTips }), { min: 1, max: config.tree.observedTips, integer: true })}{numberField("Trees / datasets", config.tree.replicates, (replicates) => setTree({ ...config.tree, replicates }), { min: 1, max: 100, integer: true })}{numberField("Curve horizon", config.tree.horizon, (horizon) => { const scale = horizon / config.tree.horizon; setTree({ ...config.tree, horizon, population: { ...config.tree.population, points: config.tree.population.points.map((point) => ({ ...point, time: point.time * scale })) }, sampling: { ...config.tree.sampling, points: config.tree.sampling.points.map((point) => ({ ...point, time: point.time * scale })) } }); }, { min: 0.1 })}{numberField("Substitutions / time", config.tree.branchScale, (branchScale) => setTree({ ...config.tree, branchScale }), { min: 0.0000001, step: 0.001 })}<label className="sim-field"><span>Population convention</span><select value={config.tree.ploidy} onChange={(event) => setTree({ ...config.tree, ploidy: Number(event.target.value) as 1 | 2 })}><option value="1">Haploid gene-copy Nₑ</option><option value="2">Diploid-individual Nₑ</option></select></label></div>
      <div className="sim-curve-init"><label>Initialize population<select defaultValue="logistic" onChange={(event) => initializePopulation(event.target.value)}><option value="constant">Constant</option><option value="exponential">Exponential</option><option value="logistic">Logistic</option><option value="sin-log">Sinusoidal in log Nₑ</option><option value="sin-linear">Sinusoidal in Nₑ</option><option value="bottleneck">Bottleneck</option></select></label><label>Initialize sampling<select defaultValue="serial" onChange={(event) => initializeSampling(event.target.value)}><option value="contemporaneous">Contemporaneous</option><option value="serial">Constant serial</option><option value="logistic">Epidemic-biased</option><option value="seasonal">Seasonal / pulsed</option><option value="ladder">Dense serial</option></select></label></div>
      <div className="sim-curve-grid"><CurveEditor title="Effective population size Nₑ(t)" curve={config.tree.population} horizon={config.tree.horizon} color="#167a70" onChange={(population) => setTree({ ...config.tree, preset: "custom", population })} /><CurveEditor title="Sampling intensity s(t)" curve={config.tree.sampling} horizon={config.tree.horizon} color="#d8644b" onChange={(sampling) => setTree({ ...config.tree, preset: "custom", sampling })} /></div>
    </div></details>

    <details open className="sim-panel"><summary><strong>2 · Evolve codon sequences</strong><span>Non-uniform GTR+F3×4 · MG94 or dynamic-fitness SCUFF</span></summary><div className="sim-panel__body">
      <div className="sim-engine-tabs"><button type="button" className={config.codon.engine === "mg94" ? "is-active" : ""} onClick={() => changeEngine("mg94")}><strong>Standard codon model</strong><small>Exact MG94 Gillespie process</small></button><button type="button" className={config.codon.engine === "scuff" ? "is-active" : ""} onClick={() => changeEngine("scuff")}><strong>SCUFF</strong><small>OU-shifting amino-acid fitness</small></button><label className="toggle"><input type="checkbox" checked={config.simulateAlignment} onChange={(event) => setConfig({ ...config, simulateAlignment: event.target.checked })} /><span>Simulate alignments (off = trees only)</span></label></div>
      <div className="sim-compact-grid">{numberField("Codon sites", config.codon.sites, (sites) => setCodon({ ...config.codon, sites }), { min: 1, max: 10000, integer: true })}<label className="sim-field sim-field--wide"><span>Genetic code</span><select value={config.codon.geneticCodeId} onChange={(event) => setCodon({ ...config.codon, geneticCodeId: Number(event.target.value) as CodonSimulationConfig["geneticCodeId"] })}>{GENETIC_CODE_OPTIONS.filter((option) => !CONTEXT_DEPENDENT_GENETIC_CODE_IDS.includes(Number(option.value) as 27 | 28 | 31)).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="sim-field"><span>Nucleotide model</span><select value={config.codon.gtr.preset} onChange={(event) => setGtr(GTR_PRESETS[event.target.value] ?? { ...config.codon.gtr, preset: "custom" })}><option value="flu-demo">Empirical influenza GTR (default)</option><option value="transition-rich">Transition-rich</option><option value="balanced">Balanced GTR</option><option value="custom">Custom</option></select></label></div>
      <div className="sim-marginal-grid"><MarginalControl label="Synonymous rate α" value={config.codon.alpha} onChange={(alpha) => setCodon({ ...config.codon, alpha })} />{config.codon.engine === "mg94" ? <MarginalControl label="Nonsynonymous multiplier ω" value={config.codon.omega} color="#6f62ef" onChange={(omega) => updateMg94({ omega })} /> : <><MarginalControl label="Fitness jump rate λ" value={config.codon.eventRate} color="#d8644b" onChange={(eventRate) => updateScuff({ eventRate })} /><MarginalControl label="Equilibrium fitness SD σ" value={config.codon.equilibriumSigma} color="#6f62ef" onChange={(equilibriumSigma) => updateScuff({ equilibriumSigma })} /><MarginalControl label="OU mixing rate θ" value={config.codon.mixingRate} color="#b68128" onChange={(mixingRate) => updateScuff({ mixingRate })} /></>}</div>
      {config.codon.engine === "scuff" && <div className="sim-compact-grid">{numberField("Root burn-in time", config.codon.burninTime, (burninTime) => updateScuff({ burninTime }), { min: 0 })}{numberField("Diagnostic trace time", config.codon.diagnosticTime, (diagnosticTime) => updateScuff({ diagnosticTime }), { min: 0.01 })}<div className="sim-explanation"><strong>SCUFF event update</strong><span>f′ = ρf + σ√(1−ρ²)ε, ρ = exp(−θ/λ); substitutions and fitness jumps compete in one exact Gillespie clock.</span></div></div>}
      <details className="sim-subpanel"><summary>Custom GTR exchangeabilities and F3×4</summary><div className="sim-gtr"><div>{config.codon.gtr.exchangeabilities.map((value, index) => <label key={PAIRS[index]}><span>{PAIRS[index]}</span><CommittedNumberInput integer={false} min={0.000001} value={value} onCommit={(next) => setGtr({ ...config.codon.gtr, preset: "custom", exchangeabilities: config.codon.gtr.exchangeabilities.map((entry, i) => i === index ? next : entry) as unknown as GtrSpecification["exchangeabilities"] })} /></label>)}</div><div>{config.codon.gtr.f3x4.map((value, index) => <label key={index}><span>{["1A","1C","1G","1T","2A","2C","2G","2T","3A","3C","3G","3T"][index]}</span><CommittedNumberInput integer={false} min={0.000001} value={value} onCommit={(next) => setGtr({ ...config.codon.gtr, preset: "custom", f3x4: config.codon.gtr.f3x4.map((entry, i) => i === index ? next : entry) })} /></label>)}</div></div></details>
    </div></details>

    <details open className="sim-panel"><summary><strong>3 · Optional ancestral recombination</strong><span>Events occur inside branches · hidden carrier lineages supported</span></summary><div className="sim-panel__body">
      <label className="sim-recomb-enable toggle"><input type="checkbox" checked={config.recombination.enabled} onChange={(event) => setConfig({ ...config, recombination: { ...config.recombination, enabled: event.target.checked } })} /><span><strong>Simulate recombination</strong> A genomic tract changes parent at a continuous time inside its recipient branch.</span></label>
      <div className={config.recombination.enabled ? "" : "sim-disabled-block"}><div className="sim-compact-grid">{numberField("Events / lineage-time", config.recombination.eventRate, (eventRate) => setConfig({ ...config, recombination: { ...config.recombination, eventRate } }), { min: 0, step: 0.001 })}<label className="sim-field"><span>Breakpoint process</span><select value={config.recombination.mode} onChange={(event) => setConfig({ ...config, recombination: { ...config.recombination, mode: event.target.value as SimulatorConfig["recombination"]["mode"] } })}><option value="single-crossover">One crossover</option><option value="single-tract">One imported tract (two boundaries)</option><option value="few-switches">Few alternating switches</option><option value="template-switching">Many template switches</option></select></label>{numberField("Mean breakpoints / event", config.recombination.meanBreakpoints, (meanBreakpoints) => setConfig({ ...config, recombination: { ...config.recombination, meanBreakpoints } }), { min: 1 })}{numberField("Mean tract length (codons)", config.recombination.meanTractCodons, (meanTractCodons) => setConfig({ ...config, recombination: { ...config.recombination, meanTractCodons } }), { min: 1 })}{numberField("Carrier-tree oversampling", config.recombination.carrierOversample, (carrierOversample) => setConfig({ ...config, recombination: { ...config.recombination, carrierOversample } }), { min: 1, max: 20, note: "Simulate this many carrier tips per observed tip, then subsample." })}<label className="sim-field"><span>Breakpoint hotspots</span><select value={config.recombination.hotspotMode} onChange={(event) => setConfig({ ...config, recombination: { ...config.recombination, hotspotMode: event.target.value as SimulatorConfig["recombination"]["hotspotMode"] } })}><option value="none">Uniform</option><option value="random">Random Gaussian hotspots</option><option value="manual">Manual codon positions</option></select></label>{config.recombination.hotspotMode !== "none" && <>{numberField("Hotspot count", config.recombination.hotspotCount, (hotspotCount) => setConfig({ ...config, recombination: { ...config.recombination, hotspotCount } }), { min: 0, max: 100, integer: true })}{numberField("Hotspot width", config.recombination.hotspotWidth, (hotspotWidth) => setConfig({ ...config, recombination: { ...config.recombination, hotspotWidth } }), { min: 0.5 })}{numberField("Hotspot enrichment", config.recombination.hotspotIntensity, (hotspotIntensity) => setConfig({ ...config, recombination: { ...config.recombination, hotspotIntensity } }), { min: 0 })}</>}</div>{config.recombination.hotspotMode === "manual" && <label className="sim-field sim-field--full"><span>Manual hotspot codons (comma-separated)</span><input value={config.recombination.manualHotspots.join(", ")} onChange={(event) => setConfig({ ...config, recombination: { ...config.recombination, manualHotspots: event.target.value.split(/[,\s]+/).map(Number).filter(Number.isFinite) } })} /></label>}<p className="sim-recomb-note">Recipient and donor edges must coexist at the sampled event time. Tracts from one event share that parent switch; multiple events compose into the local genealogy for each genomic interval. Carrier tips not selected as observed samples can still donate ancestry.</p></div>
    </div></details>

    <div className="sim-seed-strip"><label>Reproducible seed <CommittedNumberInput value={config.seed} onCommit={(seed) => setConfig({ ...config, seed })} min={-2147483648} max={2147483647} /></label><span>All trees, site parameters, recombination events, and sequences are reproduced from this seed.</span></div>
  </fieldset>;
}
