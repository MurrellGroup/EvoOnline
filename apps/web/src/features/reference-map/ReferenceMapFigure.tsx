import React, { useId, type CSSProperties, type RefObject } from "react";
import { aminoAcidColor, layoutLogoSegments, LogoGlyph, profileLetterColor, rawLogoLetters } from "../structure-mapping/ProfileChainAlignment.js";
import { AMINO_ACIDS } from "../structure-mapping/sequence-profile.js";
import { buildReferenceDetectionMarks, buildReferenceMapColumns } from "./reference-numbering.js";
import type { ReferenceAlignmentResult, ReferenceEvidenceSite, ReferenceHypothesis, ReferenceMapColumn } from "./types.js";

const FONT = '"DejaVu Sans", Arial, Helvetica, sans-serif';

export interface ReferenceMapFigureSettings {
  readonly title: string;
  readonly referenceLabel: string;
  readonly profileLabel: string;
  readonly referenceStart: number;
  readonly startSite: number;
  readonly endSite: number;
  readonly threshold: number;
  readonly columnWidth: number;
  readonly logoHeight: number;
  readonly referenceHeight: number;
  readonly numberFontSize: number;
  readonly tickInterval: number;
  readonly showDetectionLabels: boolean;
  readonly showGridlines: boolean;
  readonly highlightDifferences: boolean;
  readonly hypothesisColors: Readonly<Record<string, string>>;
  readonly hypothesisLabels: Readonly<Record<string, string>>;
}

interface ReferenceMapFigureProps {
  readonly result: ReferenceAlignmentResult;
  readonly evidenceSites: readonly ReferenceEvidenceSite[];
  readonly hypotheses: readonly ReferenceHypothesis[];
  readonly selectedHypothesisIds: ReadonlySet<string>;
  readonly settings: ReferenceMapFigureSettings;
  readonly svgRef?: RefObject<SVGSVGElement | null>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function visibleColumnSlice(columns: readonly ReferenceMapColumn[], startSite: number, endSite: number): readonly ReferenceMapColumn[] {
  const minimum = Math.min(startSite, endSite);
  const maximum = Math.max(startSite, endSite);
  const firstProfileSite = columns.find((column) => column.profileSite !== undefined)?.profileSite;
  let lastProfileSite: number | undefined;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    if (columns[index]!.profileSite !== undefined) { lastProfileSite = columns[index]!.profileSite; break; }
  }
  const first = minimum <= (firstProfileSite ?? minimum)
    ? 0
    : columns.findIndex((column) => column.profileSite !== undefined && column.profileSite >= minimum);
  if (first < 0) return [];
  let last = columns.length - 1;
  if (maximum < (lastProfileSite ?? maximum)) {
    while (last >= first && (columns[last]!.profileSite === undefined || columns[last]!.profileSite! > maximum)) last -= 1;
  }
  return columns.slice(first, last + 1);
}

function svgStyle(): CSSProperties {
  return { display: "block", background: "#ffffff", fontFamily: FONT };
}

function UnknownResidueGlyph({ aminoAcid, x, y, width, height }: { readonly aminoAcid: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
  if (AMINO_ACIDS.includes(aminoAcid)) return <LogoGlyph aminoAcid={aminoAcid} x={x} y={y} width={width} height={height} color={aminoAcidColor(aminoAcid)} />;
  return <text x={x + width / 2} y={y + height * 0.72} textAnchor="middle" fill="#778682" fontSize={Math.min(12, height * 0.55)} fontWeight="800">{aminoAcid}</text>;
}

export function ReferenceMapFigure({
  result,
  evidenceSites,
  hypotheses,
  selectedHypothesisIds,
  settings,
  svgRef,
}: ReferenceMapFigureProps) {
  const titleId = useId();
  const descriptionId = useId();
  const allColumns = buildReferenceMapColumns(result.alignment, settings.referenceStart);
  const columns = visibleColumnSlice(allColumns, settings.startSite, settings.endSite);
  const selectedHypotheses = hypotheses.filter((hypothesis) => selectedHypothesisIds.has(hypothesis.id));
  const marks = buildReferenceDetectionMarks(columns, evidenceSites, selectedHypothesisIds, settings.threshold);
  const visibleIndexByAlignment = new Map(columns.map((column, index) => [column.alignmentIndex, index]));
  const marksByHypothesis = new Map(selectedHypotheses.map((hypothesis) => [hypothesis.id, marks.filter((mark) => mark.hypothesisId === hypothesis.id)]));
  const maximumCoordinateLength = Math.max(1, ...marks.map((mark) => mark.coordinateLabel.length));
  const laneHeight = settings.showDetectionLabels
    ? Math.max(29, settings.numberFontSize * maximumCoordinateLength * 0.62 + 18)
    : 20;
  const left = 190;
  const right = 22;
  const titleTop = 24;
  const laneTop = 56;
  const referenceTop = laneTop + selectedHypotheses.length * laneHeight + 12;
  const profileTop = referenceTop + settings.referenceHeight + 6;
  const axisTop = profileTop + settings.logoHeight + 7;
  const height = axisTop + 28;
  const plotWidth = columns.length * settings.columnWidth;
  const width = Math.max(720, left + plotWidth + right);
  const detectedAlignmentColumns = new Set(marks.map((mark) => mark.alignmentIndex));
  const firstReferenceIndex = columns.findIndex((column) => column.referenceIndex >= 0);
  let lastReferenceIndex = -1;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    if (columns[index]!.referenceIndex >= 0) { lastReferenceIndex = index; break; }
  }
  const referenceCoverage = result.alignment.mappedResidues / Math.max(1, result.reference.sequence.length);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
      style={svgStyle()}
      data-reference-map="true"
    >
      <title id={titleId}>{settings.title}</title>
      <desc id={descriptionId}>A globally aligned amino-acid reference above a raw-frequency amino-acid profile. Selected posterior hypotheses are annotated in separate, non-overlapping lanes using reference coordinates; profile insertions receive letter suffixes.</desc>
      <rect width={width} height={height} fill="#ffffff" />
      <text x="18" y={titleTop} fill="#172321" fontSize="16" fontWeight="750">{settings.title}</text>
      <text x="18" y={titleTop + 17} fill="#70807c" fontSize="8.5">
        {`${result.reference.name} · ${percent(result.alignment.identity)} identity · ${percent(result.alignment.coverage)} profile coverage · ${percent(referenceCoverage)} reference coverage · posterior > ${settings.threshold.toFixed(3)}`}
      </text>

      {settings.showGridlines && [...detectedAlignmentColumns].map((alignmentIndex) => {
        const visibleIndex = visibleIndexByAlignment.get(alignmentIndex);
        if (visibleIndex === undefined) return null;
        const x = left + (visibleIndex + 0.5) * settings.columnWidth;
        return <line key={`grid-${alignmentIndex}`} x1={x} x2={x} y1={laneTop - 3} y2={profileTop + settings.logoHeight} stroke="#304a43" strokeOpacity="0.075" strokeWidth="1" />;
      })}

      {selectedHypotheses.map((hypothesis, laneIndex) => {
        const color = settings.hypothesisColors[hypothesis.id] ?? hypothesis.color;
        const label = settings.hypothesisLabels[hypothesis.id] ?? hypothesis.shortLabel;
        const laneMarks = marksByHypothesis.get(hypothesis.id) ?? [];
        const baseline = laneTop + (laneIndex + 1) * laneHeight - 5;
        return <g key={hypothesis.id} data-hypothesis={hypothesis.id}>
          <text x={left - 12} y={baseline + 2} textAnchor="end" fill={color} fontSize="8" fontWeight="800">{label}</text>
          <text x={left - 12} y={baseline + 12} textAnchor="end" fill="#8a9692" fontSize="6.5">{laneMarks.length} detection{laneMarks.length === 1 ? "" : "s"}</text>
          <line x1={left} x2={left + plotWidth} y1={baseline} y2={baseline} stroke={color} strokeOpacity="0.25" />
          {laneMarks.map((mark) => {
            const visibleIndex = visibleIndexByAlignment.get(mark.alignmentIndex);
            if (visibleIndex === undefined) return null;
            const x = left + (visibleIndex + 0.5) * settings.columnWidth;
            const evidenceFraction = Math.max(0, Math.min(1, (mark.probability - settings.threshold) / Math.max(1e-8, 1 - settings.threshold)));
            return <g key={`${hypothesis.id}-${mark.site}`} data-detection-site={mark.site} data-coordinate={mark.coordinateLabel}>
              <title>{`${hypothesis.label} at codon ${mark.site} → reference ${mark.coordinateLabel}: posterior ${mark.probability.toFixed(5)}`}</title>
              <line x1={x} x2={x} y1={baseline} y2={baseline - 5 - evidenceFraction * 3} stroke={color} strokeWidth="1.5" />
              <circle cx={x} cy={baseline} r={2.1 + evidenceFraction * 1.1} fill={color} stroke="#ffffff" strokeWidth="0.8" />
              {settings.showDetectionLabels && <text
                transform={`translate(${x + settings.numberFontSize * 0.3} ${baseline - 12}) rotate(-90)`}
                textAnchor="start"
                fill={color}
                fontSize={settings.numberFontSize}
                fontWeight="850"
                style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 2.2, strokeLinejoin: "round" }}
              >{mark.coordinateLabel}</text>}
            </g>;
          })}
        </g>;
      })}

      <text x={left - 12} y={referenceTop + settings.referenceHeight * 0.61} textAnchor="end" fill="#465b55" fontSize="8" fontWeight="800">{settings.referenceLabel}</text>
      <text x={left - 12} y={profileTop + settings.logoHeight * 0.58} textAnchor="end" fill="#465b55" fontSize="8" fontWeight="800">{settings.profileLabel}</text>
      <rect x={left} y={referenceTop} width={plotWidth} height={settings.referenceHeight} fill="#f7f9f8" />
      <rect x={left} y={profileTop} width={plotWidth} height={settings.logoHeight} fill="#fbfcfb" />
      <line x1={left} x2={left + plotWidth} y1={profileTop - 3} y2={profileTop - 3} stroke="#c7d0cc" strokeWidth="0.8" />

      {columns.map((column, visibleIndex) => {
        const x = left + visibleIndex * settings.columnWidth + 1;
        const glyphWidth = Math.max(2, settings.columnWidth - 2);
        const referenceAminoAcid = column.referenceIndex < 0 ? undefined : result.reference.sequence[column.referenceIndex];
        const profileColumn = column.profileIndex < 0 ? undefined : result.profile.columns[column.profileIndex];
        const letters = profileColumn === undefined ? [] : rawLogoLetters(profileColumn, result.profile.sequenceCount);
        const segments = layoutLogoSegments(letters, profileTop, settings.logoHeight);
        const occupancy = profileColumn === undefined ? 0 : profileColumn.validCount / result.profile.sequenceCount;
        const columnTitle = profileColumn === undefined
          ? `Reference ${column.coordinateLabel} ${referenceAminoAcid}; insertion in reference relative to the alignment profile.`
          : referenceAminoAcid === undefined
            ? `Codon ${profileColumn.site}; insertion ${column.coordinateLabel} relative to the reference; ${percent(occupancy)} profile occupancy.`
            : `Codon ${profileColumn.site} ↔ reference ${column.coordinateLabel} ${referenceAminoAcid}; ${percent(occupancy)} profile occupancy.`;
        return <g key={column.alignmentIndex} data-profile-site={column.profileSite ?? "gap"} data-reference-coordinate={column.coordinateLabel} data-occupancy={occupancy.toFixed(6)}>
          <title>{columnTitle}</title>
          {referenceAminoAcid === undefined
            ? <><rect x={x} y={referenceTop} width={glyphWidth} height={settings.referenceHeight} fill="#fff8ea" stroke="#dbb568" strokeDasharray="2 2" /><text x={x + glyphWidth / 2} y={referenceTop + settings.referenceHeight * 0.68} textAnchor="middle" fill="#b68a35" fontSize="10" fontWeight="800">–</text></>
            : <UnknownResidueGlyph aminoAcid={referenceAminoAcid} x={x} y={referenceTop} width={glyphWidth} height={settings.referenceHeight} />}
          {profileColumn === undefined
            ? <><rect x={x} y={profileTop} width={glyphWidth} height={settings.logoHeight} fill="#f2f5f3" stroke="#cbd5d0" strokeDasharray="2 2" /><text x={x + glyphWidth / 2} y={profileTop + settings.logoHeight * 0.62} textAnchor="middle" fill="#9aa6a2" fontSize="11" fontWeight="800">–</text></>
            : segments.map((segment) => <LogoGlyph
              key={segment.aminoAcid}
              aminoAcid={segment.aminoAcid}
              x={x}
              y={segment.y}
              width={glyphWidth}
              height={segment.height}
              color={profileLetterColor(segment.aminoAcid, referenceAminoAcid, settings.highlightDifferences)}
            />)}
          {referenceAminoAcid === undefined && <rect x={x} y={referenceTop - 2} width={glyphWidth} height="2" fill="#d59c2c" />}
        </g>;
      })}

      <line x1={left} x2={left + plotWidth} y1={axisTop} y2={axisTop} stroke="#9eada7" strokeWidth="0.75" />
      {columns.map((column, visibleIndex) => {
        if (column.referenceNumber === undefined) return null;
        const isEdge = visibleIndex === firstReferenceIndex || visibleIndex === lastReferenceIndex;
        if (!isEdge && (column.referenceNumber - settings.referenceStart) % settings.tickInterval !== 0) return null;
        const x = left + (visibleIndex + 0.5) * settings.columnWidth;
        return <g key={`tick-${column.alignmentIndex}`}>
          <line x1={x} x2={x} y1={axisTop} y2={axisTop + 4} stroke="#81908b" />
          <text x={x} y={axisTop + 13} textAnchor="middle" fill="#687873" fontSize="7" fontVariant="tabular-nums">{column.referenceNumber}</text>
        </g>;
      })}
      <text x={left - 12} y={axisTop + 13} textAnchor="end" fill="#7b8985" fontSize="7" fontWeight="750">Reference coordinate</text>
      {selectedHypotheses.length === 0 && <text x={left} y={laneTop + 4} fill="#84928e" fontSize="8">No hypothesis lanes selected; reference and profile alignment remain visible.</text>}
      {columns.length === 0 && <text x={left} y={profileTop + 20} fill="#84928e" fontSize="9">No profile columns fall inside the selected codon window.</text>}
    </svg>
  );
}
