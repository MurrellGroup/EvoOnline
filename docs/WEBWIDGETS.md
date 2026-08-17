# WebWidgets integration

The upstream alignment editor and tree tagger remain standalone HTML documents under `apps/web/public/widgets` and are embedded same-origin.

## Why iframe adapters

- Their rendering/event loops remain isolated from the React application.
- Their original HTML/CSS/Canvas/SVG behavior is preserved.
- A tool can be upgraded or replaced behind the same message protocol.
- Model packages never depend on widget globals.

## alivibe messages

Host requests:

- `set-alignment`
- `get-alignment`
- `set-tree`
- `get-tree`
- `run-fasttree`
- `score-fasttree-segment` (private FSART service action)
- `score-fasttree-ranges` (private FSART refit action)

Widget events:

- `ready`
- `alignment-changed`
- `tree-changed`
- `status`

The direct FastTree button uses `run-fasttree`; it therefore invokes the same bioWASM FastTree installation that alivibe uses internally, without requiring the user to open the editor.

FSART uses `score-fasttree-segment` with `{ alignment, start, end, fastest, maxParallel }` to fit its global/segment/pair/triplet full-tree family. It does not mutate alivibe's displayed alignment: it mounts a numeric-name slice, runs FastTree GTR+Gamma, captures the likelihood from separated stderr, restores original Newick tip labels, and returns the complete fit plus the fitted GTR parameters when requested. The global fit runs first to establish the shared GTR matrix; independent regional fits are then dispatched across a lazy pool capped by `maxParallel`, the browser CPU limit, detected hardware concurrency, and an eight-runtime safety ceiling. Each slot owns its own virtual filesystem; the same runtime is never entered concurrently.

`score-fasttree-ranges` performs a de novo full-tree refit on one or more inclusive, possibly discontiguous Viterbi-assigned ranges. All-site FSART emissions are computed outside the widget by the frozen-tree likelihood engine: it keeps each source-fitted tree's branch lengths and Gamma shape unchanged and does not duplicate or mix alignment columns during parameter fitting.

## phylotagger messages

Host requests:

- `set-tree`
- `get-tree`

Widget events:

- `ready`
- `tree-changed`

Applying the modal snapshots its current tagged Newick. The DifFUBAR plugin—not the widget—enforces exactly two tags and alignment/tree tip agreement.

## Updating upstream

1. Copy the new upstream files and license.
2. Reapply only the relative alivibe script URLs and the two bridge blocks.
3. Test ready/request/response behavior, alignment edits, FastTree, and G1/G2 tagging.
4. Update the upstream revision in `THIRD_PARTY_NOTICES.md`.
