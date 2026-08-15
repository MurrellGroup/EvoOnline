import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import { downloadText } from "../lib/file-download.js";
import {
  recombinationBundleFilename,
  serializeRecombinationTreeBundle,
  type EvoOnlineRecombinationTreeBundle,
} from "../lib/recombination-bundle.js";
import { RecombinationTreeMiniature, recombinationModeInfo } from "./RecombinationTreeSummary.js";

export type RecombinationCodonMethod = "fubar" | "fame" | "flavor";

export function RecombinationCodonHandoff({ treeSet, bundle, error, onLoad }: {
  readonly treeSet?: RecombinationCodonTreeSet | undefined;
  readonly bundle?: EvoOnlineRecombinationTreeBundle | undefined;
  readonly error?: string | undefined;
  readonly onLoad?: ((method: RecombinationCodonMethod, treeSet: RecombinationCodonTreeSet, bundle: EvoOnlineRecombinationTreeBundle) => void) | undefined;
}) {
  const info = bundle === undefined ? undefined : recombinationModeInfo(bundle);
  return <div className="recombination-handoff">
    <div className="recombination-handoff__identity"><span>Continue with codon site analysis · {info?.eyebrow ?? "regional-tree handoff"}</span><strong>{info?.shortTitle ?? "Recombination-aware codon analysis"}</strong><small>{treeSet === undefined || bundle === undefined ? error : `${treeSet.segments.length} final regions · one joint global codon model · relative tree scales locked`}</small></div>
    {bundle !== undefined && <RecombinationTreeMiniature bundle={bundle} className="recombination-miniature--handoff" />}
    <div className="recombination-handoff__actions">
      {(["fubar", "fame", "flavor"] as const).map((method) => <button key={method} type="button" className={method === "fubar" ? "button button--primary" : "button button--secondary"} disabled={treeSet === undefined || bundle === undefined || onLoad === undefined} onClick={() => treeSet !== undefined && bundle !== undefined && onLoad?.(method, treeSet, bundle)}>Load into {method.toUpperCase()}</button>)}
      <button type="button" className="button button--quiet" disabled={bundle === undefined} onClick={() => bundle !== undefined && downloadText(serializeRecombinationTreeBundle(bundle), recombinationBundleFilename(bundle), "application/json;charset=utf-8")}>Download tree set</button>
    </div>
  </div>;
}
