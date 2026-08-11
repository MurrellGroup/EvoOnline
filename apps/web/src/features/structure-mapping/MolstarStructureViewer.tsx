import { useEffect, useMemo, useRef, useState } from "react";
import { loadMolstar, type MolstarRuntime, type MolstarViewer } from "./molstar-loader.js";
import type { StructureChain, StructureChainView, StructureColorMode, StructureFormat, StructureRepresentationKind, StructureResidue, StructureSiteDatum } from "./types.js";

interface MolstarStructureViewerProps {
  readonly sourceText: string;
  readonly format: StructureFormat;
  readonly chainViews: readonly StructureChainView[];
  readonly sites: readonly StructureSiteDatum[];
  readonly colorMode: StructureColorMode;
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

function chainSelectors(chainViews: readonly StructureChainView[]): Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] {
  const selectors = chainViews.map((view) => chainSelector(view.chain));
  return selectors.length === 1 ? selectors[0]! : selectors;
}

export function viewsForRepresentation(chainViews: readonly StructureChainView[], representation: StructureRepresentationKind): readonly StructureChainView[] {
  return chainViews.filter((view) => view.representations[representation]);
}

export interface SurfaceViewGroup {
  readonly opacity: number;
  readonly views: readonly StructureChainView[];
}

export function groupSurfaceViews(chainViews: readonly StructureChainView[]): readonly SurfaceViewGroup[] {
  const groups = new Map<number, StructureChainView[]>();
  for (const view of viewsForRepresentation(chainViews, "surface")) {
    const opacity = Math.round(Math.min(1, Math.max(0, view.representations.surfaceOpacity)) * 100) / 100;
    const group = groups.get(opacity);
    if (group === undefined) groups.set(opacity, [view]);
    else group.push(view);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([opacity, views]) => ({ opacity, views }));
}

function residueKeys(residue: StructureResidue): readonly string[] {
  return [
    `auth:${residue.authChainId}:${residue.authSeqId}:${residue.insertionCode}`,
    ...(residue.labelSeqId === undefined ? [] : [`label:${residue.chainId}:${residue.labelSeqId}`]),
  ];
}

function addColorLayers(representation: any, chainViews: readonly StructureChainView[], sites: readonly StructureSiteDatum[], mode: StructureColorMode): void {
  representation.color({ color: "#d8dfdc" });
  const mappedViews = chainViews.filter((view) => view.mode === "mapped");
  if (mappedViews.length > 0) representation.color({ color: "#aebbb7", selector: chainSelectors(mappedViews) });
  const siteByNumber = new Map(sites.map((site) => [site.site, site]));
  const groups = new Map<string, Array<Readonly<Record<string, string | number>>>>();
  for (const view of mappedViews) {
    for (let siteIndex = 0; siteIndex < view.alignment.siteToResidue.length; siteIndex += 1) {
      const residueIndex = view.alignment.siteToResidue[siteIndex]!;
      if (residueIndex < 0) continue;
      const residue = view.chain.residues[residueIndex];
      const site = siteByNumber.get(siteIndex + 1);
      if (residue === undefined || site === undefined) continue;
      const color = mode.color(site);
      const selectors = groups.get(color);
      if (selectors === undefined) groups.set(color, [residueSelector(residue)]);
      else selectors.push(residueSelector(residue));
    }
  }
  for (const [color, selectors] of groups) representation.color({ color, selector: selectors });
}

export function MolstarStructureViewer({
  sourceText,
  format,
  chainViews,
  sites,
  colorMode,
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
    for (const view of chainViews) {
      if (view.mode !== "mapped") continue;
      for (let siteIndex = 0; siteIndex < view.alignment.siteToResidue.length; siteIndex += 1) {
        const residue = view.chain.residues[view.alignment.siteToResidue[siteIndex]!];
        const site = siteByNumber.get(siteIndex + 1);
        if (residue === undefined || site === undefined) continue;
        for (const key of residueKeys(residue)) map.set(key, { residue, site });
      }
    }
    return map;
  }, [chainViews, sites]);

  const contextResidues = useMemo(() => {
    const keys = new Set<string>();
    for (const view of chainViews) {
      if (view.mode !== "context") continue;
      for (const residue of view.chain.residues) for (const key of residueKeys(residue)) keys.add(key);
    }
    return keys;
  }, [chainViews]);

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
        const authKey = `auth:${authChain}:${authSeq}:${insertion}`;
        const labelKey = `label:${labelChain}:${labelSeq}`;
        const mapped = mappedByResidue.get(authKey) ?? mappedByResidue.get(labelKey);
        if (mapped !== undefined) {
          message = `${mapped.residue.compId} ${mapped.residue.authChainId || mapped.residue.chainId}:${mapped.residue.authSeqId}${mapped.residue.insertionCode} ↔ codon ${mapped.site.site} · ${colorMode.valueLabel(mapped.site)}`;
        } else if (contextResidues.has(authKey) || contextResidues.has(labelKey)) {
          const compId = String(properties.residue.label_comp_id(location) ?? "residue");
          message = `${compId} ${authChain}:${authSeq}${insertion} · context chain · results not mapped`;
        } else {
          const compId = String(properties.residue.label_comp_id(location) ?? "residue");
          message = `${compId} ${authChain}:${authSeq}${insertion} · no aligned codon`;
        }
      });
      setHover(message ?? "Hover over a residue to inspect its mapped codon.");
    });
    return () => subscription.unsubscribe();
  }, [colorMode, contextResidues, mappedByResidue, ready]);

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
        const cartoonViews = viewsForRepresentation(chainViews, "cartoon");
        const atomViews = viewsForRepresentation(chainViews, "atoms");
        const surfaceGroups = groupSurfaceViews(chainViews);
        if (cartoonViews.length > 0) {
          const representation = structure.component({ selector: chainSelectors(cartoonViews) }).representation({ type: "cartoon" });
          addColorLayers(representation, cartoonViews, sites, colorMode);
        }
        if (atomViews.length > 0) {
          const representation = structure.component({ selector: chainSelectors(atomViews) }).representation({ type: "ball_and_stick", ignore_hydrogens: true, size_factor: 0.55 });
          addColorLayers(representation, atomViews, sites, colorMode);
        }
        for (const surfaceGroup of surfaceGroups) {
          const representation = structure.component({ selector: chainSelectors(surfaceGroup.views) }).representation({ type: "surface", surface_type: "molecular", ignore_hydrogens: true, size_factor: 1 });
          addColorLayers(representation, surfaceGroup.views, sites, colorMode);
          representation.opacity({ opacity: surfaceGroup.opacity });
        }
        const keepCamera = lastSourceRef.current === sourceUrl;
        await viewer.loadMvsData(builder.getState(), "mvsj", { keepCamera, sanityChecks: false });
        lastSourceRef.current = sourceUrl;
        if (revision === revisionRef.current) setStatus("");
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    }, 90);
    return () => window.clearTimeout(timer);
  }, [chainViews, colorMode, format, ready, sites, sourceUrl]);

  return (
    <div className="structure-viewer-shell">
      <div ref={mountRef} className="structure-viewer-canvas" aria-label="Interactive molecular structure viewer" />
      {status !== "" && <div className="structure-viewer-status" role="status"><span />{status}</div>}
      {error !== undefined && <div className="structure-viewer-error" role="alert">{error}</div>}
      <div className="structure-viewer-hover" aria-live="polite">{hover}</div>
    </div>
  );
}
