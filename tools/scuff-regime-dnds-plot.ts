import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Random, scuffDiagnostic, type ScuffCodonConfig } from "../models/simulator/src/index.ts";

interface RegimeConfig {
  readonly seed: number;
  readonly tree: { readonly replicates: number };
  readonly codon: ScuffCodonConfig;
}

interface SavedConfig {
  readonly calm: RegimeConfig;
  readonly adaptive: RegimeConfig;
}

function replicateSeed(seed: number, replicate: number): number {
  let value = (seed ^ Math.imul(replicate + 1, 0x9e3779b1)) | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value | 0;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function number(value: number, digits = 3): string {
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function linePath(times: readonly number[], values: readonly number[], x: (value: number) => number, y: (value: number) => number): string {
  return values.map((value, index) => `${index === 0 ? "M" : "L"}${x(times[index]!).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const results = resolve(root, "benchmarks/simulator-selection/results");
  const config = JSON.parse(await readFile(resolve(results, "scuff-block-contrast.config.json"), "utf8")) as SavedConfig;
  const regimes = (["calm", "adaptive"] as const).map((name) => {
    const source = config[name];
    const seed = replicateSeed(source.seed, source.tree.replicates + 1);
    const diagnostic = scuffDiagnostic(source.codon, new Random(seed));
    return { name, config: source.codon, diagnostic };
  });

  const width = 1200;
  const height = 870;
  const plotLeft = 112;
  const plotRight = 1150;
  const plotWidth = plotRight - plotLeft;
  const panelHeight = 235;
  const panelTops = [160, 500];
  const yMin = 0.5;
  const yMax = 2.6;
  const timeMax = Math.max(...regimes.flatMap((regime) => regime.diagnostic.times));
  const x = (value: number): number => plotLeft + value / timeMax * plotWidth;
  const y = (value: number, top: number): number => top + panelHeight - (value - yMin) / (yMax - yMin) * panelHeight;
  const yTicks = [0.5, 1, 1.5, 2, 2.5];
  const xTicks = Array.from({ length: Math.floor(timeMax) + 1 }, (_, index) => index);
  const colors = { calm: "#23669a", adaptive: "#b63f4b" } as const;

  const panels = regimes.map((regime, panelIndex) => {
    const top = panelTops[panelIndex]!;
    const d = regime.diagnostic;
    const color = colors[regime.name];
    const aboveOne = d.dnds.filter((value) => value > 1).length / d.dnds.length;
    const eventRate = regime.config.eventRate.mean;
    const sigma = regime.config.equilibriumSigma.mean;
    const mixing = regime.config.mixingRate.mean;
    const title = regime.name === "calm" ? "A  Calm fitness landscape" : "B  Adaptive, shifting fitness landscape";
    const ticks = yTicks.map((tick) => `<line x1="${plotLeft}" y1="${y(tick, top)}" x2="${plotRight}" y2="${y(tick, top)}" stroke="${tick === 1 ? "#7d8582" : "#e4e8e5"}" stroke-width="${tick === 1 ? 1.4 : 1}" ${tick === 1 ? 'stroke-dasharray="7 5"' : ""}/><text x="${plotLeft - 14}" y="${y(tick, top) + 5}" text-anchor="end" class="tick">${number(tick, 1)}</text>`).join("");
    const verticals = xTicks.map((tick) => `<line x1="${x(tick)}" y1="${top}" x2="${x(tick)}" y2="${top + panelHeight}" stroke="#edf0ee"/><text x="${x(tick)}" y="${top + panelHeight + 28}" text-anchor="middle" class="tick">${tick}</text>`).join("");
    const theoryY = y(d.maximumExpectedDnds, top);
    return `<g aria-label="${escapeXml(title)}">
      <rect x="${plotLeft}" y="${top}" width="${plotWidth}" height="${panelHeight}" fill="#fbfcfb" stroke="#cfd6d2"/>
      ${verticals}${ticks}
      <line x1="${plotLeft}" y1="${theoryY}" x2="${plotRight}" y2="${theoryY}" stroke="#d2684b" stroke-width="1.4" stroke-dasharray="3 5"/>
      <path d="${linePath(d.times, d.dnds, x, (value) => y(value, top))}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#clip-${regime.name})"/>
      <text x="${plotLeft}" y="${top - 42}" class="panel-title">${escapeXml(title)}</text>
      <text x="${plotLeft}" y="${top - 17}" class="panel-subtitle">λ=${number(eventRate, 1)} · θ=${number(mixing, 1)} · σ=${number(sigma, 1)} · mean=${number(d.sampledMeanDnds)} · time above 1=${number(100 * aboveOne, 1)}%</text>
      <text x="${plotRight - 8}" y="${theoryY - 8}" text-anchor="end" class="reference">Ω(σ)=${number(d.maximumExpectedDnds)}</text>
      <text transform="translate(33 ${top + panelHeight / 2}) rotate(-90)" text-anchor="middle" class="axis-title">Expected dN/dS</text>
      ${panelIndex === 1 ? `<text x="${(plotLeft + plotRight) / 2}" y="${top + panelHeight + 67}" text-anchor="middle" class="axis-title">Evolutionary time</text>` : ""}
    </g>`;
  }).join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">SCUFF expected dN/dS trajectories for calm and adaptive regimes</title>
  <desc id="description">Two seeded trajectories of expected instantaneous dN/dS, computed from propagated codon frequencies conditional on sampled SCUFF fitness histories.</desc>
  <defs>
    <clipPath id="clip-calm"><rect x="${plotLeft}" y="${panelTops[0]}" width="${plotWidth}" height="${panelHeight}"/></clipPath>
    <clipPath id="clip-adaptive"><rect x="${plotLeft}" y="${panelTops[1]}" width="${plotWidth}" height="${panelHeight}"/></clipPath>
    <style>
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #17221e; }
      .title { font-size: 29px; font-weight: 720; letter-spacing: -0.5px; }
      .subtitle { font-size: 15px; fill: #56645e; }
      .panel-title { font-size: 20px; font-weight: 700; }
      .panel-subtitle { font-size: 14px; fill: #4d5c56; font-variant-numeric: tabular-nums; }
      .axis-title { font-size: 15px; font-weight: 650; }
      .tick { font-size: 13px; fill: #5d6864; font-variant-numeric: tabular-nums; }
      .reference { font-size: 12px; font-weight: 650; fill: #b0523b; }
      .note { font-size: 12px; fill: #65716c; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="white"/>
  <text id="title-text" x="${plotLeft}" y="47" class="title">SCUFF expected dN/dS trajectories</text>
  <text x="${plotLeft}" y="76" class="subtitle">Production codon-frequency propagation conditional on one seeded fitness history; both panels use the same axes.</text>
  <line x1="760" y1="49" x2="802" y2="49" stroke="#7d8582" stroke-width="1.4" stroke-dasharray="7 5"/><text x="812" y="54" class="note">neutrality (dN/dS=1)</text>
  <line x1="965" y1="49" x2="1007" y2="49" stroke="#d2684b" stroke-width="1.4" stroke-dasharray="3 5"/><text x="1017" y="54" class="note">Ω(σ)</text>
  ${panels}
  <text x="${plotLeft}" y="847" class="note">The red reference is the expectation immediately after an independent fitness redraw, not a bound on an individual sampled trajectory.</text>
</svg>`;

  await writeFile(resolve(results, "scuff-calm-adaptive-dnds-trajectories.svg"), svg);
}

await main();
