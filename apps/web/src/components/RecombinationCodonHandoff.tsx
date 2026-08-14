import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";

export type RecombinationCodonMethod = "fubar" | "fame" | "flavor";

export function RecombinationCodonHandoff({ treeSet, error, onLoad }: {
  readonly treeSet?: RecombinationCodonTreeSet | undefined;
  readonly error?: string | undefined;
  readonly onLoad?: ((method: RecombinationCodonMethod, treeSet: RecombinationCodonTreeSet) => void) | undefined;
}) {
  return <div className="recombination-handoff"><div><strong>Continue with codon site analysis</strong><span>{treeSet === undefined ? error : `${treeSet.segments.length} final regional trees · codons use their middle nucleotide · one joint global codon model · relative tree scales locked`}</span></div><div>{(["fubar", "fame", "flavor"] as const).map((method) => <button key={method} type="button" className={method === "fubar" ? "button button--primary" : "button button--secondary"} disabled={treeSet === undefined || onLoad === undefined} onClick={() => treeSet !== undefined && onLoad?.(method, treeSet)}>Load into {method.toUpperCase()}</button>)}</div></div>;
}
