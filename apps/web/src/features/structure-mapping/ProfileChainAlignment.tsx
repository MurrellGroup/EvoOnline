import { useMemo, useState } from "react";
import { AMINO_ACIDS } from "./sequence-profile.js";
import type {
  AminoAcidProfile,
  AminoAcidProfileColumn,
  StructureChainView,
  StructureColorMode,
  StructureSiteDatum,
} from "./types.js";

const COLUMN_WIDTH = 22;
const LABEL_WIDTH = 92;
const LOGO_HEIGHT = 78;
const LOGO_TOP = 25;
const CHAIN_TOP = LOGO_TOP + LOGO_HEIGHT + 18;
const SVG_HEIGHT = 166;
const WINDOW_SIZES = [40, 60, 100] as const;

const AMINO_COLORS: Readonly<Record<string, string>> = Object.freeze({
  D: "#d64545", E: "#d64545",
  K: "#3465c5", R: "#3465c5", H: "#5f74c9",
  S: "#3c9b65", T: "#3c9b65", N: "#45a37a", Q: "#45a37a", C: "#b78c22", Y: "#8d64b6",
  A: "#667a75", V: "#667a75", I: "#667a75", L: "#667a75", M: "#667a75",
  F: "#6d5a93", W: "#6d5a93", P: "#ad6a38", G: "#8a9793",
});

export interface LogoLetter {
  readonly aminoAcid: string;
  /** Raw fraction of all input sequences, including gaps and ambiguous codons in the denominator. */
  readonly mass: number;
}

export function rawLogoLetters(column: AminoAcidProfileColumn, sequenceCount: number): readonly LogoLetter[] {
  if (sequenceCount <= 0) return [];
  const observedFraction = column.validCount / sequenceCount;
  return Array.from(AMINO_ACIDS, (aminoAcid, index) => ({
    aminoAcid,
    mass: column.frequencies[index]! * observedFraction,
  }))
    .filter((entry) => entry.mass > 0)
    .sort((left, right) => right.mass - left.mass || left.aminoAcid.localeCompare(right.aminoAcid));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

interface ChainAlignmentProps {
  readonly profile: AminoAcidProfile;
  readonly view: StructureChainView;
  readonly sites: readonly StructureSiteDatum[];
  readonly colorMode: StructureColorMode;
}

function initialWindowStart(view: StructureChainView, sites: readonly StructureSiteDatum[], windowSize: number): number {
  const detected = new Set(sites.filter((site) => site.detected).map((site) => site.site - 1));
  const alignmentColumn = Array.from(view.alignment.profileIndices).findIndex((profileIndex) => detected.has(profileIndex));
  return Math.max(0, alignmentColumn < 0 ? 0 : alignmentColumn - Math.floor(windowSize / 3));
}

function ProfileChainAlignment({ profile, view, sites, colorMode }: ChainAlignmentProps) {
  const [windowSize, setWindowSize] = useState<number>(60);
  const [windowStart, setWindowStart] = useState(() => initialWindowStart(view, sites, 60));
  const alignmentLength = view.alignment.profileIndices.length;
  const maximumStart = Math.max(0, alignmentLength - windowSize);
  const start = clamp(windowStart, 0, maximumStart);
  const end = Math.min(alignmentLength, start + windowSize);
  const siteByNumber = useMemo(() => new Map(sites.map((site) => [site.site, site])), [sites]);
  const visibleColumns = useMemo(() => {
    const columns: Array<{ readonly alignmentIndex: number; readonly profileIndex: number; readonly residueIndex: number }> = [];
    for (let index = start; index < end; index += 1) {
      columns.push({
        alignmentIndex: index,
        profileIndex: view.alignment.profileIndices[index]!,
        residueIndex: view.alignment.residueIndices[index]!,
      });
    }
    return columns;
  }, [end, start, view.alignment.profileIndices, view.alignment.residueIndices]);
  const width = LABEL_WIDTH + visibleColumns.length * COLUMN_WIDTH + 12;

  const changeWindowSize = (next: number): void => {
    const center = start + windowSize / 2;
    setWindowSize(next);
    setWindowStart(Math.max(0, Math.round(center - next / 2)));
  };

  return (
    <article className="profile-chain-alignment" aria-labelledby={`profile-chain-${view.chain.id}`}>
      <div className="profile-chain-alignment__header">
        <div>
          <h5 id={`profile-chain-${view.chain.id}`}>Chain {view.chain.label}</h5>
          <span>{view.chain.residues.length.toLocaleString()} residues · {percent(view.alignment.identity)} identity · {percent(view.alignment.coverage)} profile coverage</span>
        </div>
        <div className="profile-chain-alignment__controls">
          <button type="button" disabled={start === 0} onClick={() => setWindowStart(Math.max(0, start - windowSize))}>Previous</button>
          <label>Window <select value={windowSize} onChange={(event) => changeWindowSize(Number(event.target.value))}>{WINDOW_SIZES.map((size) => <option key={size} value={size}>{size} columns</option>)}</select></label>
          <button type="button" disabled={end === alignmentLength} onClick={() => setWindowStart(Math.min(maximumStart, start + windowSize))}>Next</button>
        </div>
      </div>
      {maximumStart > 0 && <label className="profile-chain-alignment__range"><span>Alignment columns {start + 1}–{end} of {alignmentLength}</span><input type="range" min={0} max={maximumStart} value={start} onChange={(event) => setWindowStart(Number(event.target.value))} aria-label={`Visible alignment window for chain ${view.chain.label}`} /></label>}
      <div className="profile-chain-alignment__scroll">
        <svg width={width} height={SVG_HEIGHT} viewBox={`0 0 ${width} ${SVG_HEIGHT}`} role="img" aria-label={`Raw amino-acid profile aligned to structure chain ${view.chain.label}`}>
          <text className="profile-chain-alignment__row-label" x={LABEL_WIDTH - 10} y={LOGO_TOP + LOGO_HEIGHT / 2} textAnchor="end">AA profile</text>
          <text className="profile-chain-alignment__row-label" x={LABEL_WIDTH - 10} y={CHAIN_TOP + 12} textAnchor="end">Chain {view.chain.label}</text>
          <line x1={LABEL_WIDTH} x2={width - 8} y1={LOGO_TOP + LOGO_HEIGHT} y2={LOGO_TOP + LOGO_HEIGHT} className="profile-chain-alignment__baseline" />
          {visibleColumns.map(({ alignmentIndex, profileIndex, residueIndex }, visibleIndex) => {
            const x = LABEL_WIDTH + visibleIndex * COLUMN_WIDTH;
            const column = profileIndex < 0 ? undefined : profile.columns[profileIndex];
            const residue = residueIndex < 0 ? undefined : view.chain.residues[residueIndex];
            const letters = column === undefined ? [] : rawLogoLetters(column, profile.sequenceCount);
            const occupancy = column === undefined ? 0 : column.validCount / profile.sequenceCount;
            const site = column === undefined ? undefined : siteByNumber.get(column.site);
            const selectionColor = site === undefined ? "#dce3df" : colorMode.color(site);
            let cumulative = 0;
            const title = column === undefined
              ? `Alignment column ${alignmentIndex + 1}: insertion in structure chain`
              : `Codon ${column.site}: ${percent(occupancy)} unambiguous AA occupancy; ${letters.map((letter) => `${letter.aminoAcid} ${percent(letter.mass)}`).join(", ") || "no resolved amino acids"}`;
            return (
              <g key={alignmentIndex} data-profile-site={column?.site ?? "gap"} data-occupancy={occupancy.toFixed(6)}>
                <title>{`${title}${residue === undefined ? "; gap in structure chain" : `; chain residue ${residue.compId} ${residue.authSeqId}${residue.insertionCode}`}`}</title>
                {column === undefined && <rect x={x + 2} y={LOGO_TOP} width={COLUMN_WIDTH - 4} height={LOGO_HEIGHT} className="profile-chain-alignment__profile-gap" />}
                {letters.map((letter) => {
                  const letterHeight = letter.mass * LOGO_HEIGHT;
                  const y = LOGO_TOP + LOGO_HEIGHT - cumulative - letterHeight;
                  cumulative += letterHeight;
                  if (letterHeight < 1.5) return <rect key={letter.aminoAcid} x={x + 3} y={y} width={COLUMN_WIDTH - 6} height={Math.max(0.5, letterHeight)} fill={AMINO_COLORS[letter.aminoAcid] ?? "#667a75"} />;
                  return <text key={letter.aminoAcid} x={x + COLUMN_WIDTH / 2} y={y} dy="0.82em" textAnchor="middle" textLength={COLUMN_WIDTH - 4} lengthAdjust="spacingAndGlyphs" fontSize={letterHeight} fontWeight={850} fill={AMINO_COLORS[letter.aminoAcid] ?? "#667a75"}>{letter.aminoAcid}</text>;
                })}
                <rect x={x + 2} y={CHAIN_TOP} width={COLUMN_WIDTH - 4} height={21} rx={2} fill={selectionColor} fillOpacity={0.82} stroke={site?.detected ? "#344742" : "none"} strokeWidth={site?.detected ? 0.7 : 0} />
                <text x={x + COLUMN_WIDTH / 2} y={CHAIN_TOP + 15} textAnchor="middle" className="profile-chain-alignment__residue">{residue?.aminoAcid ?? "–"}</text>
                {(visibleIndex === 0 || (column !== undefined && column.site % 10 === 0)) && <>
                  <line x1={x + COLUMN_WIDTH / 2} x2={x + COLUMN_WIDTH / 2} y1={CHAIN_TOP + 22} y2={CHAIN_TOP + 27} className="profile-chain-alignment__tick" />
                  <text x={x + COLUMN_WIDTH / 2} y={CHAIN_TOP + 38} textAnchor="middle" className="profile-chain-alignment__number">{column?.site ?? ""}</text>
                </>}
              </g>
            );
          })}
        </svg>
      </div>
    </article>
  );
}

interface ProfileChainAlignmentPanelProps {
  readonly profile: AminoAcidProfile;
  readonly chainViews: readonly StructureChainView[];
  readonly sites: readonly StructureSiteDatum[];
  readonly colorMode: StructureColorMode;
}

export function ProfileChainAlignmentPanel({ profile, chainViews, sites, colorMode }: ProfileChainAlignmentPanelProps) {
  if (chainViews.length === 0) return null;
  return (
    <section className="profile-chain-alignments" aria-labelledby="profile-chain-alignments-heading">
      <div className="profile-chain-alignments__heading">
        <div>
          <h4 id="profile-chain-alignments-heading">Sequence profile aligned to mapped chains</h4>
          <p>Letter height is raw amino-acid frequency across all input sequences. Stacks sum to observed non-gap occupancy; empty height is missing, ambiguous, or gapped sequence mass.</p>
        </div>
        <span>Raw frequency · no entropy scaling</span>
      </div>
      {chainViews.map((view) => <ProfileChainAlignment key={view.chain.id} profile={profile} view={view} sites={sites} colorMode={colorMode} />)}
    </section>
  );
}
