import { useEffect, useMemo, useRef, useState } from "react";
import { loadMolstar, type MolstarRuntime, type MolstarViewer } from "./molstar-loader.js";
import type { ProfileAlignment, StructureChain, StructureColorMode, StructureFormat, StructureResidue, StructureSiteDatum } from "./types.js";

interface MolstarStructureViewerProps {
  readonly sourceText: string;
  readonly format: StructureFormat;
  readonly chain: StructureChain;
  readonly alignment: ProfileAlignment;
  readonly sites: readonly StructureSiteDatum[];
  readonly colorMode: StructureColorMode;
  readonly showCartoon: boolean;
  readonly showAtoms: boolean;
  readonly showSurface: boolean;
}

function residueSelector(residue: StructureResidue): Readonly<Record<string, string | number>> {
  if (residue.labelSeqId !== undefined && residue.chainId !== "") {
    return { label_asym_id: residue.chainId, label_seq_id: residue.labelSeqId };
  }
  return {
    auth_asym_id: residue.authChainId,
    auth_seq_id: residue.authSeqId,
    ...(residue.insertionCode === "" ? {} : { pdbx_PDB_ins_code: residue.insertionCode }),
  };
}

function chainSelector(chain: StructureChain): Readonly<Record<string, string>> {
  const first = chain.residues[0]!;
  return first.chainId !== "" ? { label_asym_id: first.chainId } : { auth_asym_id: first.authChainId };
}

function residueKeys(residue: StructureResidue): readonly string[] {
  return [
    `auth:${residue.authChainId}:${residue.authSeqId}:${residue.insertionCode}`,
    ...(residue.labelSeqId === undefined ? [] : [`label:${residue.chainId}:${residue.labelSeqId}`]),
  ];
}

function addColorLayers(representation: any, chain: StructureChain, alignment: ProfileAlignment, sites: readonly StructureSiteDatum[], mode: StructureColorMode, wholeStructure: boolean): void {
  representation.color({ color: wholeStructure ? "#d8dfdc" : "#aebbb7" });
  if (wholeStructure) representation.color({ color: "#aebbb7", selector: chainSelector(chain) });
  const siteByNumber = new Map(sites.map((site) => [site.site, site]));
  const groups = new Map<string, Array<Readonly<Record<string, string | number>>>>();
  for (let siteIndex = 0; siteIndex < alignment.siteToResidue.length; siteIndex += 1) {
    const residueIndex = alignment.siteToResidue[siteIndex]!;
    if (residueIndex < 0) continue;
    const residue = chain.residues[residueIndex];
    const site = siteByNumber.get(siteIndex + 1);
    if (residue === undefined || site === undefined) continue;
    const color = mode.color(site);
    const selectors = groups.get(color);
    if (selectors === undefined) groups.set(color, [residueSelector(residue)]);
    else selectors.push(residueSelector(residue));
  }
  for (const [color, selectors] of groups) representation.color({ color, selector: selectors });
}

export function MolstarStructureViewer({
  sourceText,
  format,
  chain,
  alignment,
  sites,
  colorMode,
  showCartoon,
  showAtoms,
  showSurface,
}: MolstarStructureViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MolstarViewer | undefined>(undefined);
  const runtimeRef = useRef<MolstarRuntime | undefined>(undefined);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(0);
  const lastSourceRef = useRef<string | undefined>(undefined);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [status, setStatus] = useState("Loading the lightweight Mol* viewer…");
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState("Hover over a residue to inspect its mapped codon.");
  const [ready, setReady] = useState(false);

  const mappedByResidue = useMemo(() => {
    const map = new Map<string, { readonly residue: StructureResidue; readonly site: StructureSiteDatum }>();
    const siteByNumber = new Map(sites.map((site) => [site.site, site]));
    for (let siteIndex = 0; siteIndex < alignment.siteToResidue.length; siteIndex += 1) {
      const residue = chain.residues[alignment.siteToResidue[siteIndex]!];
      const site = siteByNumber.get(siteIndex + 1);
      if (residue === undefined || site === undefined) continue;
      for (const key of residueKeys(residue)) map.set(key, { residue, site });
    }
    return map;
  }, [alignment, chain, sites]);

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([sourceText], { type: format === "mmcif" ? "chemical/x-mmcif" : "chemical/x-pdb" }));
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [format, sourceText]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void loadMolstar().then(async (runtime) => {
      if (disposed || mountRef.current === null) return;
      runtimeRef.current = runtime;
      const viewer = await runtime.Viewer.create(mountRef.current, {
        extensions: ["mvs"],
        layoutIsExpanded: false,
        layoutShowControls: false,
        layoutShowRemoteState: false,
        layoutShowSequence: false,
        layoutShowLog: false,
        layoutShowLeftPanel: false,
        viewportShowReset: true,
        viewportShowScreenshotControls: true,
        viewportShowControls: false,
        viewportShowExpand: false,
        viewportShowToggleFullscreen: true,
        viewportShowSettings: false,
        viewportShowSelectionMode: false,
        viewportShowAnimation: false,
        viewportShowTrajectoryControls: false,
        viewportFocusBehavior: "secondary-zoom",
        viewportBackgroundColor: "#f7faf8",
        powerPreference: "high-performance",
      });
      if (disposed) {
        viewer.dispose();
        return;
      }
      viewerRef.current = viewer;
      resizeObserver = new ResizeObserver(() => viewer.handleResize());
      resizeObserver.observe(mountRef.current);
      setStatus("Preparing the mapped structure…");
      setReady(true);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      viewerRef.current?.dispose();
      viewerRef.current = undefined;
      runtimeRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const runtime = runtimeRef.current;
    if (viewer === undefined || runtime === undefined) return;
    const loci = runtime.lib.structure.StructureElement.Loci;
    const properties = runtime.lib.structure.StructureProperties;
    const subscription = viewer.subscribe(viewer.plugin.behaviors.interaction.hover, (event: any) => {
      if (!loci.is(event.current.loci)) {
        setHover("Hover over a residue to inspect its mapped codon.");
        return;
      }
      let message: string | undefined;
      loci.forEachLocation(event.current.loci, (location: any) => {
        if (message !== undefined) return;
        const authChain = String(properties.chain.auth_asym_id(location) ?? "");
        const authSeq = Number(properties.residue.auth_seq_id(location));
        const insertion = String(properties.residue.pdbx_PDB_ins_code(location) ?? "").replace(/[?.]/g, "");
        const labelChain = String(properties.chain.label_asym_id(location) ?? "");
        const labelSeq = Number(properties.residue.label_seq_id(location));
        const mapped = mappedByResidue.get(`auth:${authChain}:${authSeq}:${insertion}`) ?? mappedByResidue.get(`label:${labelChain}:${labelSeq}`);
        if (mapped !== undefined) {
          message = `${mapped.residue.compId} ${mapped.residue.authChainId || mapped.residue.chainId}:${mapped.residue.authSeqId}${mapped.residue.insertionCode} ↔ codon ${mapped.site.site} · ${colorMode.valueLabel(mapped.site)}`;
        } else {
          const compId = String(properties.residue.label_comp_id(location) ?? "residue");
          message = `${compId} ${authChain}:${authSeq}${insertion} · no aligned codon`;
        }
      });
      setHover(message ?? "Hover over a residue to inspect its mapped codon.");
    });
    return () => subscription.unsubscribe();
  }, [colorMode, mappedByResidue, ready]);

  useEffect(() => {
    if (sourceUrl === undefined) return;
    const revision = ++revisionRef.current;
    const timer = window.setTimeout(() => {
      queueRef.current = queueRef.current.catch(() => undefined).then(async () => {
        if (revision !== revisionRef.current) return;
        const viewer = viewerRef.current;
        const runtime = runtimeRef.current;
        if (viewer === undefined || runtime === undefined) return;
        setError(undefined);
        setStatus("Updating structure colors and representations…");
        const builder = runtime.lib.extensions.mvs.createBuilder();
        builder.canvas({ background_color: "#f7faf8" });
        const structure = builder
          .download({ url: sourceUrl })
          .parse({ format: format === "mmcif" ? "mmcif" : "pdb" })
          .modelStructure({});
        if (showCartoon) {
          const representation = structure.component({ selector: "protein" }).representation({ type: "cartoon" });
          addColorLayers(representation, chain, alignment, sites, colorMode, true);
        }
        if (showAtoms) {
          const representation = structure.component({ selector: chainSelector(chain) }).representation({ type: "ball_and_stick", ignore_hydrogens: true, size_factor: 0.55 });
          addColorLayers(representation, chain, alignment, sites, colorMode, false);
        }
        if (showSurface) {
          const representation = structure.component({ selector: chainSelector(chain) }).representation({ type: "surface", surface_type: "molecular", ignore_hydrogens: true, size_factor: 1 });
          addColorLayers(representation, chain, alignment, sites, colorMode, false);
          representation.opacity({ opacity: 0.68 });
        }
        if (!showCartoon && !showAtoms && !showSurface) {
          structure.component({ selector: chainSelector(chain) }).representation({ type: "backbone", size_factor: 0.2 }).color({ color: "#c6d0cc" });
        }
        const keepCamera = lastSourceRef.current === sourceUrl;
        await viewer.loadMvsData(builder.getState(), "mvsj", { keepCamera, sanityChecks: false });
        lastSourceRef.current = sourceUrl;
        if (revision === revisionRef.current) setStatus("");
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    }, 90);
    return () => window.clearTimeout(timer);
  }, [alignment, chain, colorMode, format, ready, showAtoms, showCartoon, showSurface, sites, sourceUrl]);

  return (
    <div className="structure-viewer-shell">
      <div ref={mountRef} className="structure-viewer-canvas" aria-label="Interactive molecular structure viewer" />
      {status !== "" && <div className="structure-viewer-status" role="status"><span />{status}</div>}
      {error !== undefined && <div className="structure-viewer-error" role="alert">{error}</div>}
      <div className="structure-viewer-hover" aria-live="polite">{hover}</div>
    </div>
  );
}
