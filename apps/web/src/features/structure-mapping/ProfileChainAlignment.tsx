import React, { useMemo, useState } from "react";
import { AMINO_ACID_GLYPHS } from "./amino-acid-glyphs.js";
import { AMINO_ACIDS } from "./sequence-profile.js";
import type {
  AminoAcidProfile,
  AminoAcidProfileColumn,
  StructureChainView,
  StructureColorMode,
  StructureSiteDatum,
} from "./types.js";

const DEFAULT_COLUMN_WIDTH = 16;
const PROFILE_HEIGHT = 48;
const CHAIN_HEIGHT = 28;
const PROFILE_TOP = 1;
const CHAIN_TOP = PROFILE_TOP + PROFILE_HEIGHT + 2;
const NUMBER_TOP = CHAIN_TOP + CHAIN_HEIGHT + 1;
const ALIGNMENT_HEIGHT = NUMBER_TOP + 12;

const AMINO_COLORS: Readonly<Record<string, string>> = Object.freeze({
  D: "#d64545", E: "#d64545",
  K: "#3465c5", R: "#3465c5", H: "#5f74c9",
  S: "#3c9b65", T: "#3c9b65", N: "#45a37a", Q: "#45a37a", C: "#b78c22", Y: "#8d64b6",
  A: "#667a75", V: "#667a75", I: "#667a75", L: "#667a75", M: "#667a75",
  F: "#6d5a93", W: "#6d5a93", P: "#ad6a38", G: "#8a9793",
});

export function aminoAcidColor(aminoAcid: string): string {
  return AMINO_COLORS[aminoAcid] ?? "#667a75";
}

export interface LogoLetter {
  readonly aminoAcid: string;
  /** Raw fraction of all input sequences, including gaps and ambiguous codons in the denominator. */
  readonly mass: number;
}

export interface LogoSegment extends LogoLetter {
  readonly y: number;
  readonly height: number;
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

/** Returns exact, non-overlapping bottom-up segment boxes whose total height is the observed mass. */
export function layoutLogoSegments(letters: readonly LogoLetter[], top: number, totalHeight: number): readonly LogoSegment[] {
  let occupied = 0;
  return letters.map((letter) => {
    const height = Math.max(0, letter.mass * totalHeight);
    occupied += height;
    return { ...letter, y: top + totalHeight - occupied, height };
  });
}

export function profileLetterColor(aminoAcid: string, chainAminoAcid: string | undefined, highlightDifferences: boolean): string {
  return highlightDifferences && aminoAcid === chainAminoAcid ? "#dce2df" : aminoAcidColor(aminoAcid);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

interface LogoGlyphProps {
  readonly aminoAcid: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly className?: string;
}

/**
 * A nested viewport clips every glyph to its mathematically assigned segment.
 * This avoids SVG font ascender/descender metrics leaking between stacked letters.
 */
export function LogoGlyph({ aminoAcid, x, y, width, height, color, className }: LogoGlyphProps) {
  if (height <= 0) return null;
  if (height < 1.25) return <rect className={className} x={x} y={y} width={width} height={Math.max(0.35, height)} fill={color} />;
  const path = AMINO_ACID_GLYPHS[aminoAcid];
  if (path === undefined) return null;
  return (
    <svg className={className} x={x} y={y} width={width} height={height} viewBox="0 0 100 100" preserveAspectRatio="none" overflow="hidden" aria-hidden="true">
      <path d={path} fill={color} />
    </svg>
  );
}

interface ChainAlignmentProps {
  readonly profile: AminoAcidProfile;
  readonly view: StructureChainView;
  readonly sites: readonly StructureSiteDatum[];
  readonly colorMode: StructureColorMode;
}

function ProfileChainAlignment({ profile, view, sites, colorMode }: ChainAlignmentProps) {
  const [columnWidth, setColumnWidth] = useState(DEFAULT_COLUMN_WIDTH);
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const siteByNumber = useMemo(() => new Map(sites.map((site) => [site.site, site])), [sites]);
  const alignmentColumns = useMemo(() => Array.from(view.alignment.profileIndices, (profileIndex, alignmentIndex) => ({
    alignmentIndex,
    profileIndex,
    residueIndex: view.alignment.residueIndices[alignmentIndex]!,
  })), [view.alignment.profileIndices, view.alignment.residueIndices]);
  const width = Math.max(1, alignmentColumns.length * columnWidth + 4);

  return (
    <details className="profile-chain-alignment" open>
      <summary id={`profile-chain-${view.chain.id}`}>
        <strong>Chain {view.chain.label}</strong>
        <span>{view.chain.residues.length.toLocaleString()} aa</span>
        <span>{percent(view.alignment.identity)} identity</span>
        <span>{percent(view.alignment.coverage)} coverage</span>
        <span>{view.alignment.mappedResidues.toLocaleString()} mapped</span>
      </summary>
      <div className="profile-chain-alignment__controls">
        <label className="toggle"><input type="checkbox" checked={highlightDifferences} onChange={(event) => setHighlightDifferences(event.target.checked)} /><span>Highlight differences</span></label>
        <small>Matching profile letters become light gray.</small>
        <label className="profile-chain-alignment__scale"><span>Horizontal scale</span><input type="range" min={7} max={32} step={1} value={columnWidth} onChange={(event) => setColumnWidth(Number(event.target.value))} aria-label={`Horizontal alignment scale for chain ${view.chain.label}`} /><output>{columnWidth} px</output></label>
      </div>
      <div className="profile-chain-alignment__body">
        <div className="profile-chain-alignment__labels" aria-hidden="true"><span>AA profile</span><span>Chain {view.chain.label}</span><i /></div>
        <div className="profile-chain-alignment__scroll" tabIndex={0} aria-label={`Scrollable full profile alignment for chain ${view.chain.label}`}>
          <svg width={width} height={ALIGNMENT_HEIGHT} viewBox={`0 0 ${width} ${ALIGNMENT_HEIGHT}`} role="img" aria-labelledby={`profile-chain-${view.chain.id}`}>
            <line x1={0} x2={width} y1={CHAIN_TOP - 1} y2={CHAIN_TOP - 1} className="profile-chain-alignment__baseline" />
            {alignmentColumns.map(({ alignmentIndex, profileIndex, residueIndex }) => {
              const x = alignmentIndex * columnWidth + 2;
              const glyphWidth = Math.max(2, columnWidth - 2);
              const column = profileIndex < 0 ? undefined : profile.columns[profileIndex];
              const residue = residueIndex < 0 ? undefined : view.chain.residues[residueIndex];
              const letters = column === undefined ? [] : rawLogoLetters(column, profile.sequenceCount);
              const segments = layoutLogoSegments(letters, PROFILE_TOP, PROFILE_HEIGHT);
              const occupancy = column === undefined ? 0 : column.validCount / profile.sequenceCount;
              const site = column === undefined ? undefined : siteByNumber.get(column.site);
              const selectionColor = site === undefined ? "#eef1ef" : colorMode.color(site);
              const title = column === undefined
                ? `Alignment column ${alignmentIndex + 1}: insertion in structure chain`
                : `Codon ${column.site}: ${percent(occupancy)} unambiguous AA occupancy; ${letters.map((letter) => `${letter.aminoAcid} ${percent(letter.mass)}`).join(", ") || "no resolved amino acids"}`;
              return (
                <g key={alignmentIndex} data-profile-site={column?.site ?? "gap"} data-occupancy={occupancy.toFixed(6)}>
                  <title>{`${title}${residue === undefined ? "; gap in structure chain" : `; chain residue ${residue.compId} ${residue.authSeqId}${residue.insertionCode}`}`}</title>
                  {column === undefined && <rect x={x} y={PROFILE_TOP} width={glyphWidth} height={PROFILE_HEIGHT} className="profile-chain-alignment__profile-gap" />}
                  {segments.map((segment) => <LogoGlyph
                    key={segment.aminoAcid}
                    aminoAcid={segment.aminoAcid}
                    x={x}
                    y={segment.y}
                    width={glyphWidth}
                    height={segment.height}
                    color={profileLetterColor(segment.aminoAcid, residue?.aminoAcid, highlightDifferences)}
                    className="profile-chain-alignment__profile-letter"
                  />)}
                  {residue === undefined
                    ? <text x={x + glyphWidth / 2} y={CHAIN_TOP + CHAIN_HEIGHT * 0.72} textAnchor="middle" className="profile-chain-alignment__gap-letter">–</text>
                    : <>
                      <rect x={x} y={CHAIN_TOP} width={glyphWidth} height={CHAIN_HEIGHT} rx={1.5} fill={selectionColor} fillOpacity={0.2} stroke={site?.detected ? selectionColor : "none"} strokeWidth={site?.detected ? 1 : 0} />
                      <LogoGlyph aminoAcid={residue.aminoAcid} x={x} y={CHAIN_TOP} width={glyphWidth} height={CHAIN_HEIGHT} color={aminoAcidColor(residue.aminoAcid)} className="profile-chain-alignment__chain-letter" />
                    </>}
                  {(alignmentIndex === 0 || (column !== undefined && column.site % 10 === 0)) && <>
                    <line x1={x + glyphWidth / 2} x2={x + glyphWidth / 2} y1={NUMBER_TOP} y2={NUMBER_TOP + 2} className="profile-chain-alignment__tick" />
                    <text x={x + glyphWidth / 2} y={NUMBER_TOP + 9} textAnchor="middle" className="profile-chain-alignment__number">{column?.site ?? ""}</text>
                  </>}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </details>
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
    <details className="profile-chain-alignments" open>
      <summary id="profile-chain-alignments-heading"><strong>Sequence profile aligned to mapped chains</strong><span>{chainViews.length} chain{chainViews.length === 1 ? "" : "s"} · raw frequency · no entropy scaling</span></summary>
      <p>Each complete local alignment uses native horizontal scrolling. Profile stacks sum to observed non-gap occupancy; structure residues are pure, 100%-height glyphs.</p>
      <div className="profile-chain-alignments__list">{chainViews.map((view) => <ProfileChainAlignment key={view.chain.id} profile={profile} view={view} sites={sites} colorMode={colorMode} />)}</div>
    </details>
  );
}
