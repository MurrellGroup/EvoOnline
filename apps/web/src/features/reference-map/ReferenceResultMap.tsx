import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { downloadSvg } from "../../lib/svg-export.js";
import { ReferenceMapFigure, type ReferenceMapFigureSettings } from "./ReferenceMapFigure.js";
import type {
  ReferenceAlignmentResult,
  ReferenceAlignmentWorkerRequest,
  ReferenceAlignmentWorkerResponse,
  ReferenceEvidenceSite,
  ReferenceHypothesis,
  ReferenceSequenceKind,
} from "./types.js";

interface ReferenceResultMapProps {
  readonly modelName: string;
  readonly alignmentText: string;
  readonly evidenceSites: readonly ReferenceEvidenceSite[];
  readonly hypotheses: readonly ReferenceHypothesis[];
  readonly initialThreshold: number;
}

interface ReferenceSource {
  readonly name: string;
  readonly text: string;
  readonly bytes: number;
}

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function ReferenceResultMap({ modelName, alignmentText, evidenceSites, hypotheses, initialThreshold }: ReferenceResultMapProps) {
  const workerRef = useRef<Worker | undefined>(undefined);
  const activeRequestRef = useRef<string | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<ReferenceSource>();
  const [referenceKind, setReferenceKind] = useState<ReferenceSequenceKind>("auto");
  const [alignmentResult, setAlignmentResult] = useState<ReferenceAlignmentResult>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [selectedHypothesisIds, setSelectedHypothesisIds] = useState<ReadonlySet<string>>(() => new Set(hypotheses.map((hypothesis) => hypothesis.id)));
  const [threshold, setThreshold] = useState(clamp(initialThreshold, 0.5, 0.999));
  const [referenceStart, setReferenceStart] = useState(1);
  const [startSite, setStartSite] = useState(1);
  const [endSite, setEndSite] = useState(Math.max(1, evidenceSites.length));
  const [columnWidth, setColumnWidth] = useState(16);
  const [logoHeight, setLogoHeight] = useState(54);
  const [referenceHeight, setReferenceHeight] = useState(28);
  const [numberFontSize, setNumberFontSize] = useState(8);
  const [tickInterval, setTickInterval] = useState(10);
  const [showDetectionLabels, setShowDetectionLabels] = useState(true);
  const [showGridlines, setShowGridlines] = useState(true);
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const [title, setTitle] = useState(`${modelName} selection on reference coordinates`);
  const [referenceLabel, setReferenceLabel] = useState("Reference");
  const [profileLabel, setProfileLabel] = useState("AA alignment profile");
  const [hypothesisColors, setHypothesisColors] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.color])));
  const [hypothesisLabels, setHypothesisLabels] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.shortLabel])));

  useEffect(() => () => workerRef.current?.terminate(), []);

  const ensureWorker = (): Worker => {
    if (workerRef.current !== undefined) return workerRef.current;
    const worker = new Worker(new URL("./reference-alignment.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ReferenceAlignmentWorkerResponse>) => {
      const message = event.data;
      if (message.id !== activeRequestRef.current) return;
      if (message.type === "progress") {
        setProgress(message.message);
      } else if (message.type === "result") {
        setAlignmentResult(message.result);
        setReferenceLabel(message.result.reference.name);
        setTitle(`${modelName} selection mapped to ${message.result.reference.name}`);
        setStartSite(1);
        setEndSite(message.result.profile.columns.length);
        setProgress(undefined);
      } else {
        setError(message.error);
        setProgress(undefined);
      }
    };
    workerRef.current = worker;
    return worker;
  };

  const alignSource = (nextSource: ReferenceSource, kind: ReferenceSequenceKind): void => {
    const id = requestId();
    activeRequestRef.current = id;
    workerRef.current?.terminate();
    workerRef.current = undefined;
    setAlignmentResult(undefined);
    setError(undefined);
    setProgress("Preparing reference alignment…");
    const request: ReferenceAlignmentWorkerRequest = {
      type: "align",
      id,
      alignmentText,
      referenceText: nextSource.text,
      fallbackName: nextSource.name,
      referenceKind: kind,
    };
    ensureWorker().postMessage(request);
  };

  const uploadReference = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      setError("Reference files larger than 10 MiB are not accepted in this browser build.");
      return;
    }
    try {
      const nextSource = { name: file.name, text: await file.text(), bytes: file.size };
      setSource(nextSource);
      alignSource(nextSource, referenceKind);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const maximumSite = alignmentResult?.profile.columns.length ?? Math.max(1, evidenceSites.length);
  const settings = useMemo<ReferenceMapFigureSettings>(() => ({
    title,
    referenceLabel,
    profileLabel,
    referenceStart,
    startSite: clamp(Math.trunc(startSite), 1, maximumSite),
    endSite: clamp(Math.trunc(endSite), 1, maximumSite),
    threshold,
    columnWidth,
    logoHeight,
    referenceHeight,
    numberFontSize,
    tickInterval,
    showDetectionLabels,
    showGridlines,
    highlightDifferences,
    hypothesisColors,
    hypothesisLabels,
  }), [columnWidth, endSite, highlightDifferences, hypothesisColors, hypothesisLabels, logoHeight, maximumSite, numberFontSize, profileLabel, referenceHeight, referenceLabel, referenceStart, showDetectionLabels, showGridlines, startSite, threshold, tickInterval, title]);

  const selectedDetections = useMemo(() => evidenceSites.reduce((total, site) => total + hypotheses.reduce((count, hypothesis) => count + (selectedHypothesisIds.has(hypothesis.id) && (site.probabilities[hypothesis.id] ?? 0) > threshold ? 1 : 0), 0), 0), [evidenceSites, hypotheses, selectedHypothesisIds, threshold]);

  const toggleHypothesis = (hypothesisId: string, checked: boolean): void => {
    setSelectedHypothesisIds((current) => {
      const next = new Set(current);
      if (checked) next.add(hypothesisId);
      else next.delete(hypothesisId);
      return next;
    });
  };

  return (
    <section className={`reference-map${open ? " is-open" : ""}`} aria-labelledby="reference-map-heading">
      <div className="reference-map__heading">
        <div>
          <p className="eyebrow">Optional reference-coordinate figure</p>
          <h3 id="reference-map-heading">Align selection results to a reference sequence</h3>
          <p>Upload one protein or coding-nucleotide reference to create a publication-ready reference/profile map with insertion-aware coordinates and independent hypothesis lanes.</p>
        </div>
        <button type="button" className="button button--secondary" onClick={() => setOpen((current) => !current)}>{open ? "Close reference map" : "Open reference map"}</button>
      </div>

      {open && <div className="reference-map__body">
        <details className="reference-map-panel reference-map-source" open>
          <summary><strong>Reference sequence</strong><span>{source?.name ?? "Single-sequence FASTA or plain sequence"}</span></summary>
          <div className="reference-map-source__body">
            <label className="reference-map-upload">
              <input type="file" accept=".fa,.fasta,.faa,.fas,.fna,.ffn,.txt,text/plain" onChange={(event) => void uploadReference(event)} />
              <span>{source === undefined ? "Upload reference" : "Replace reference"}</span>
              <small>Protein or coding nucleotide · processed locally · 10 MiB maximum</small>
            </label>
            <label><span>Interpret sequence as</span><select value={referenceKind} onChange={(event) => {
              const kind = event.target.value as ReferenceSequenceKind;
              setReferenceKind(kind);
              if (source !== undefined) alignSource(source, kind);
            }}><option value="auto">Auto-detect</option><option value="protein">Protein</option><option value="nucleotide">Coding nucleotide</option></select><small>Override auto-detection for nucleotide-like protein sequences.</small></label>
          </div>
        </details>

        {progress !== undefined && <div className="reference-map-progress" role="status"><span /><strong>{progress}</strong></div>}
        {error !== undefined && <div className="reference-map-error" role="alert">{error}</div>}

        {alignmentResult !== undefined && <>
          <details className="reference-map-panel reference-map-summary" open>
            <summary><strong>Alignment summary</strong><span>Global affine-gap profile alignment</span></summary>
            <div>
              <span><small>Reference</small><strong>{alignmentResult.reference.name}</strong></span>
              <span><small>Input</small><strong>{alignmentResult.reference.kind === "nucleotide" ? `${alignmentResult.reference.sourceLength.toLocaleString()} nt → ` : ""}{alignmentResult.reference.sequence.length.toLocaleString()} aa</strong></span>
              <span><small>Identity</small><strong>{percent(alignmentResult.alignment.identity)}</strong></span>
              <span><small>Profile coverage</small><strong>{percent(alignmentResult.alignment.coverage)}</strong></span>
              <span><small>Alignment columns</small><strong>{alignmentResult.alignment.profileIndices.length.toLocaleString()}</strong></span>
              <span><small>Score / mapped</small><strong>{alignmentResult.alignment.scorePerMappedResidue.toFixed(2)}</strong></span>
            </div>
          </details>

          <details className="reference-map-panel reference-map-hypotheses" open>
            <summary><strong>Hypothesis lanes</strong><span>{selectedHypothesisIds.size} of {hypotheses.length} shown · {selectedDetections.toLocaleString()} full-analysis annotations</span></summary>
            <div>{hypotheses.map((hypothesis) => <label key={hypothesis.id} style={{ borderColor: `${hypothesisColors[hypothesis.id] ?? hypothesis.color}55` }}>
              <input type="checkbox" checked={selectedHypothesisIds.has(hypothesis.id)} onChange={(event) => toggleHypothesis(hypothesis.id, event.target.checked)} />
              <i style={{ background: hypothesisColors[hypothesis.id] ?? hypothesis.color }} />
              <span><strong>{hypothesisLabels[hypothesis.id] ?? hypothesis.shortLabel}</strong><small>{hypothesis.label}</small></span>
            </label>)}</div>
          </details>

          <details className="reference-map-panel reference-map-settings" open>
            <summary><strong>Figure settings</strong><span>Coordinates, window, geometry, and annotations</span></summary>
            <div className="reference-map-settings__grid">
              <label className="reference-map-setting--wide"><span>Posterior threshold <strong>{threshold.toFixed(3)}</strong></span><input type="range" min={0.5} max={0.999} step={0.001} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
              <label><span>Reference starts at</span><input type="number" step={1} value={referenceStart} onChange={(event) => setReferenceStart(Number(event.target.value))} /></label>
              <label><span>Codon window</span><span className="reference-map-window"><input aria-label="First codon shown" type="number" min={1} max={maximumSite} value={startSite} onChange={(event) => setStartSite(Number(event.target.value))} /><b>–</b><input aria-label="Last codon shown" type="number" min={1} max={maximumSite} value={endSite} onChange={(event) => setEndSite(Number(event.target.value))} /></span></label>
              <label><span>Horizontal scale <strong>{columnWidth}px</strong></span><input type="range" min={14} max={36} step={1} value={columnWidth} onChange={(event) => setColumnWidth(Number(event.target.value))} /></label>
              <label><span>Profile height <strong>{logoHeight}px</strong></span><input type="range" min={36} max={84} step={2} value={logoHeight} onChange={(event) => setLogoHeight(Number(event.target.value))} /></label>
              <label><span>Reference height <strong>{referenceHeight}px</strong></span><input type="range" min={18} max={44} step={1} value={referenceHeight} onChange={(event) => setReferenceHeight(Number(event.target.value))} /></label>
              <label><span>Detection label size <strong>{numberFontSize}px</strong></span><input type="range" min={6} max={10} step={0.5} value={numberFontSize} onChange={(event) => setNumberFontSize(Number(event.target.value))} /></label>
              <label><span>Coordinate ticks</span><select value={tickInterval} onChange={(event) => setTickInterval(Number(event.target.value))}><option value={5}>Every 5</option><option value={10}>Every 10</option><option value={20}>Every 20</option><option value={50}>Every 50</option></select></label>
            </div>
            <div className="reference-map-settings__toggles">
              <label className="toggle"><input type="checkbox" checked={showDetectionLabels} onChange={(event) => setShowDetectionLabels(event.target.checked)} /><span>Detection numbers</span></label>
              <label className="toggle"><input type="checkbox" checked={showGridlines} onChange={(event) => setShowGridlines(event.target.checked)} /><span>Detection guides</span></label>
              <label className="toggle"><input type="checkbox" checked={highlightDifferences} onChange={(event) => setHighlightDifferences(event.target.checked)} /><span>Fade reference matches</span></label>
            </div>
          </details>

          <details className="reference-map-panel reference-map-labels" open>
            <summary><strong>Labels &amp; colors</strong><span>All edits are retained in SVG export</span></summary>
            <div className="reference-map-labels__grid">
              <label className="reference-map-label--wide"><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label><span>Reference row</span><input value={referenceLabel} onChange={(event) => setReferenceLabel(event.target.value)} /></label>
              <label><span>Profile row</span><input value={profileLabel} onChange={(event) => setProfileLabel(event.target.value)} /></label>
              {hypotheses.map((hypothesis) => <label key={hypothesis.id}><span>{hypothesis.label}</span><span className="reference-map-label-color"><input value={hypothesisLabels[hypothesis.id] ?? hypothesis.shortLabel} onChange={(event) => setHypothesisLabels((current) => ({ ...current, [hypothesis.id]: event.target.value }))} /><input type="color" value={hypothesisColors[hypothesis.id] ?? hypothesis.color} aria-label={`Color for ${hypothesis.label}`} onChange={(event) => setHypothesisColors((current) => ({ ...current, [hypothesis.id]: event.target.value }))} /></span></label>)}
            </div>
          </details>

          <article className="reference-map-figure-card">
            <div className="reference-map-figure-card__heading"><div><strong>{title}</strong><span>Reference residues are pure glyphs above raw-frequency profile stacks. Each selected hypothesis occupies its own collision-free annotation lane.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
            <div className="reference-map-figure-scroll" tabIndex={0} aria-label="Scrollable reference-coordinate selection figure"><ReferenceMapFigure result={alignmentResult} evidenceSites={evidenceSites} hypotheses={hypotheses} selectedHypothesisIds={selectedHypothesisIds} settings={settings} svgRef={svgRef} /></div>
          </article>
          <p className="reference-map-note">Coordinates advance only when a reference residue is consumed. Alignment-only insertions are suffixed alphabetically after the preceding reference coordinate: the third insertion after residue 76 is <strong>76C</strong>. Reference-only insertions remain visible as gaps in the profile row.</p>
        </>}
      </div>}
    </section>
  );
}
