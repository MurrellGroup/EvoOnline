import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { MolstarStructureViewer } from "./MolstarStructureViewer.js";
import { MOLSTAR_RUNTIME_LABEL } from "./molstar-loader.js";
import { ProfileChainAlignmentPanel } from "./ProfileChainAlignment.js";
import { detectStructureFormat } from "./structure-parser.js";
import type {
  ProfileAlignment,
  StructureChainMode,
  StructureChainView,
  StructureColorMode,
  StructureFormat,
  StructureMappingWorkerRequest,
  StructureMappingWorkerResponse,
  StructureSiteDatum,
} from "./types.js";

interface StructureMappingPanelProps {
  readonly alignmentText: string;
  readonly sites: readonly StructureSiteDatum[];
  readonly colorModes: readonly StructureColorMode[];
}

interface StructureSource {
  readonly label: string;
  readonly text: string;
  readonly format: StructureFormat;
}

const MAX_STRUCTURE_BYTES = 50 * 1024 * 1024;

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function alignmentText(alignment: ProfileAlignment): string {
  const lines: string[] = [];
  for (let offset = 0; offset < alignment.alignedProfile.length; offset += 80) {
    lines.push(`profile  ${alignment.alignedProfile.slice(offset, offset + 80)}`);
    lines.push(`         ${alignment.matchLine.slice(offset, offset + 80)}`);
    lines.push(`chain    ${alignment.alignedChain.slice(offset, offset + 80)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function updateChainMode(current: StructureChainMode, control: "show" | "map", checked: boolean): StructureChainMode {
  if (control === "show") return checked ? (current === "mapped" ? "mapped" : "context") : "hidden";
  if (checked) return "mapped";
  return current === "mapped" ? "context" : current;
}

export function StructureMappingPanel({ alignmentText: inputAlignment, sites, colorModes }: StructureMappingPanelProps) {
  const workerRef = useRef<Worker | undefined>(undefined);
  const activeRequestRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pdbId, setPdbId] = useState("");
  const [source, setSource] = useState<StructureSource>();
  const [mapping, setMapping] = useState<Extract<StructureMappingWorkerResponse, { type: "result" }>['result']>();
  const [chainModes, setChainModes] = useState<Readonly<Record<string, StructureChainMode>>>({});
  const [colorModeId, setColorModeId] = useState(colorModes[0]?.id ?? "");
  const [showCartoon, setShowCartoon] = useState(true);
  const [showAtoms, setShowAtoms] = useState(false);
  const [showSurface, setShowSurface] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [progressCount, setProgressCount] = useState<string>();
  const [error, setError] = useState<string>();

  const activeMode = colorModes.find((mode) => mode.id === colorModeId) ?? colorModes[0];
  const chainViews = useMemo<readonly StructureChainView[]>(() => {
    if (mapping === undefined) return [];
    return mapping.alignments.flatMap((alignment) => {
      const chain = mapping.chains.find((candidate) => candidate.id === alignment.chainId);
      const mode = chainModes[alignment.chainId] ?? "hidden";
      return chain === undefined || mode === "hidden" ? [] : [{ chain, alignment, mode }];
    });
  }, [chainModes, mapping]);
  const mappedViews = useMemo(() => chainViews.filter((view) => view.mode === "mapped"), [chainViews]);
  const mappedAlignmentText = useMemo(() => mappedViews.map((view) => `CHAIN ${view.chain.label}\n${alignmentText(view.alignment)}`).join("\n"), [mappedViews]);
  const mappedSummary = useMemo(() => {
    if (mapping === undefined) return { union: 0, links: 0, identity: 0, coverage: 0 };
    const mappedSites = new Set<number>();
    let links = 0;
    let identityNumerator = 0;
    for (const view of mappedViews) {
      links += view.alignment.mappedResidues;
      identityNumerator += view.alignment.identity * view.alignment.mappedResidues;
      for (let index = 0; index < view.alignment.siteToResidue.length; index += 1) {
        if (view.alignment.siteToResidue[index]! >= 0) mappedSites.add(index);
      }
    }
    return {
      union: mappedSites.size,
      links,
      identity: identityNumerator / Math.max(1, links),
      coverage: mappedSites.size / Math.max(1, mapping.profile.columns.length),
    };
  }, [mappedViews, mapping]);

  useEffect(() => () => {
    abortRef.current?.abort();
    workerRef.current?.terminate();
  }, []);

  const ensureWorker = (): Worker => {
    if (workerRef.current !== undefined) return workerRef.current;
    const worker = new Worker(new URL("./structure-mapping.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<StructureMappingWorkerResponse>) => {
      const message = event.data;
      if (message.id !== activeRequestRef.current) return;
      if (message.type === "progress") {
        setProgress(message.message);
        setProgressCount(message.current === undefined || message.total === undefined ? "" : `${message.current} / ${message.total} unique chain sequences`);
      } else if (message.type === "result") {
        setMapping(message.result);
        const bestChainId = message.result.alignments[0]?.chainId;
        setChainModes(bestChainId === undefined ? {} : { [bestChainId]: "mapped" });
        setProgress(undefined);
        setProgressCount("");
      } else {
        setError(message.error);
        setProgress(undefined);
        setProgressCount("");
      }
    };
    workerRef.current = worker;
    return worker;
  };

  const mapSource = (nextSource: StructureSource): void => {
    setSource(nextSource);
    setMapping(undefined);
    setChainModes({});
    setError(undefined);
    setProgress("Preparing structure mapping…");
    setProgressCount("");
    const id = requestId();
    activeRequestRef.current = id;
    const request: StructureMappingWorkerRequest = {
      type: "map",
      id,
      alignmentText: inputAlignment,
      structureText: nextSource.text,
      format: nextSource.format,
    };
    ensureWorker().postMessage(request);
  };

  const loadPdbId = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const id = pdbId.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(id)) {
      setError("Enter a four-character PDB identifier, for example 1HIV.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    setProgress(`Downloading ${id} from the RCSB Protein Data Bank…`);
    setProgressCount("");
    try {
      const response = await fetch(`https://files.rcsb.org/download/${id}.cif`, { signal: controller.signal });
      if (!response.ok) throw new Error(`RCSB returned ${response.status} for PDB ${id}.`);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_STRUCTURE_BYTES) throw new Error("This structure exceeds the 50 MiB browser limit.");
      const text = await response.text();
      if (new Blob([text]).size > MAX_STRUCTURE_BYTES) throw new Error("This structure exceeds the 50 MiB browser limit.");
      mapSource({ label: `PDB ${id}`, text, format: "mmcif" });
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setProgress(undefined);
    }
  };

  const uploadStructure = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > MAX_STRUCTURE_BYTES) {
      setError("Structure files larger than 50 MiB are not accepted in this browser build.");
      return;
    }
    try {
      setError(undefined);
      setProgress(`Reading ${file.name}…`);
      const text = await file.text();
      mapSource({ label: file.name, text, format: detectStructureFormat(file.name, text) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setProgress(undefined);
    }
  };

  const close = (): void => {
    setOpen(false);
    abortRef.current?.abort();
  };

  const changeChainMode = (chainId: string, control: "show" | "map", checked: boolean): void => {
    setChainModes((current) => ({
      ...current,
      [chainId]: updateChainMode(current[chainId] ?? "hidden", control, checked),
    }));
  };

  return (
    <section className={`structure-mapping ${open ? "is-open" : ""}`} aria-labelledby="structure-mapping-heading">
      <div className="structure-mapping__heading">
        <div>
          <p className="eyebrow">Optional structural context</p>
          <h3 id="structure-mapping-heading">Map selection onto a protein structure</h3>
          <p>Profile-align the translated input alignment to every coordinate-bearing chain, then color residues by the selection result.</p>
        </div>
        <button type="button" className="button button--secondary" onClick={() => open ? close() : setOpen(true)}>{open ? "Close structure mapper" : "Open structure mapper"}</button>
      </div>

      {open && (
        <div className="structure-mapping__body">
          <div className="structure-source-grid">
            <form className="structure-pdb-form" onSubmit={(event) => void loadPdbId(event)}>
              <label htmlFor="structure-pdb-id">PDB identifier</label>
              <div><input id="structure-pdb-id" value={pdbId} maxLength={4} placeholder="e.g. 1HIV" onChange={(event) => setPdbId(event.target.value)} /><button type="submit" className="button button--primary">Fetch PDB</button></div>
              <small>Coordinates are fetched directly from RCSB as mmCIF.</small>
            </form>
            <div className="structure-source-or">or</div>
            <label className="structure-upload">
              <input type="file" accept=".pdb,.ent,.cif,.mmcif,chemical/x-pdb,chemical/x-mmcif,text/plain" onChange={(event) => void uploadStructure(event)} />
              <span>Upload PDB or mmCIF</span>
              <small>Processed locally · 50 MiB maximum</small>
            </label>
          </div>

          {progress !== undefined && <div className="structure-progress" role="status"><span className="structure-progress__spinner" /><div><strong>{progress}</strong>{progressCount !== "" && <small>{progressCount}</small>}</div></div>}
          {error !== undefined && <div className="structure-error" role="alert">{error}</div>}

          {source !== undefined && mapping !== undefined && activeMode !== undefined && (
            <>
              <div className="structure-mapping-summary">
                <div><span>Structure</span><strong>{source.label}</strong></div>
                <div><span>Shown chains</span><strong>{chainViews.length} · {mappedViews.length} mapped</strong></div>
                <div><span>Mapped profile codons</span><strong>{mappedSummary.union.toLocaleString()}</strong></div>
                <div><span>Codon–chain links</span><strong>{mappedSummary.links.toLocaleString()}</strong></div>
                <div><span>Weighted identity</span><strong>{mappedViews.length === 0 ? "—" : percent(mappedSummary.identity)}</strong></div>
                <div><span>Combined coverage</span><strong>{mappedViews.length === 0 ? "—" : percent(mappedSummary.coverage)}</strong></div>
              </div>

              <div className="structure-controls">
                <label><span>Color residues by</span><select value={activeMode.id} onChange={(event) => setColorModeId(event.target.value)}>{colorModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select><small>{activeMode.description}</small></label>
                <fieldset><legend>Representations</legend>
                  <label><input type="checkbox" checked={showCartoon} onChange={(event) => setShowCartoon(event.target.checked)} /> Cartoon</label>
                  <label><input type="checkbox" checked={showAtoms} onChange={(event) => setShowAtoms(event.target.checked)} /> Atoms</label>
                  <label><input type="checkbox" checked={showSurface} onChange={(event) => setShowSurface(event.target.checked)} /> Surface</label>
                </fieldset>
              </div>

              <fieldset className="structure-chain-picker">
                <legend>Structure chains</legend>
                <p><strong>Show</strong> keeps a chain as structural context. <strong>Map results</strong> also aligns and colors it; switching Map on automatically switches Show on.</p>
                <div className="structure-chain-picker__labels" aria-hidden="true"><span>Chain and alignment quality</span><span>Show</span><span>Map results</span><span>Mode</span></div>
                <div className="structure-chain-picker__list">
                  {mapping.alignments.map((alignment) => {
                    const chain = mapping.chains.find((candidate) => candidate.id === alignment.chainId);
                    if (chain === undefined) return null;
                    const mode = chainModes[alignment.chainId] ?? "hidden";
                    return <div className="structure-chain-row" key={alignment.chainId}>
                      <div><strong>Chain {chain.label}</strong><span>{chain.residues.length.toLocaleString()} aa · {percent(alignment.identity)} identity · {percent(alignment.coverage)} coverage · score {alignment.score.toFixed(1)}</span></div>
                      <label title={`Show chain ${chain.label}`}><input type="checkbox" checked={mode !== "hidden"} onChange={(event) => changeChainMode(alignment.chainId, "show", event.target.checked)} /><span className="visually-hidden">Show chain {chain.label}</span></label>
                      <label title={`Map results to chain ${chain.label}`}><input type="checkbox" checked={mode === "mapped"} onChange={(event) => changeChainMode(alignment.chainId, "map", event.target.checked)} /><span className="visually-hidden">Map results to chain {chain.label}</span></label>
                      <span className={`structure-chain-mode structure-chain-mode--${mode}`}>{mode === "mapped" ? "Mapped" : mode === "context" ? "Context" : "Hidden"}</span>
                    </div>;
                  })}
                </div>
              </fieldset>

              <div className="structure-legend" aria-label={`${activeMode.label} legend`}>{activeMode.legend.map((entry) => <span key={`${entry.color}-${entry.label}`}><i style={{ background: entry.color }} />{entry.label}</span>)}</div>
              <ProfileChainAlignmentPanel profile={mapping.profile} chainViews={mappedViews} sites={sites} colorMode={activeMode} />
              {chainViews.length > 0 ? <MolstarStructureViewer
                sourceText={source.text}
                format={source.format}
                chainViews={chainViews}
                sites={sites}
                colorMode={activeMode}
                showCartoon={showCartoon}
                showAtoms={showAtoms}
                showSurface={showSurface}
              /> : <div className="structure-viewer-empty"><strong>No chains are shown</strong><span>Switch on Show for a context chain, or Map results for a chain that should receive site colors.</span></div>}
              {mappedViews.length > 0 && <details className="structure-alignment-detail">
                <summary>Inspect text alignments for {mappedViews.length} mapped chain{mappedViews.length === 1 ? "" : "s"}</summary>
                <p>Each translated codon column is scored as an amino-acid frequency profile against each mapped chain. Gaps represent unresolved residues or lineage-specific insertions.</p>
                <pre>{mappedAlignmentText}</pre>
              </details>}
              <p className="structure-footnote">The highest-scoring local alignment is mapped by default. Other chains can be mapped independently, retained neutrally for structural context, or hidden. Review chain identity and coverage before interpreting residue colors. {MOLSTAR_RUNTIME_LABEL} is loaded only while this viewer is in use.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
