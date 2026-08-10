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

Widget events:

- `ready`
- `alignment-changed`
- `tree-changed`
- `status`

The direct FastTree button uses `run-fasttree`; it therefore invokes the same bioWASM FastTree installation that alivibe uses internally, without requiring the user to open the editor.

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
