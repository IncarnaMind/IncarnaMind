# Slide editor bake-off

Three ways to edit a .pptx on a drawn slide, measured on the same decks with the same edits:

- **A**: our own renderer (`src/renderer/src/viewer/slides/SlideEditor.tsx`) with the deck's own bytes patched (`src/core/exports/pptxPatch/edits.ts`).
- **B**: `@office-kit/pptx-editor`, as shipped, mounted with `mountEditor()`.
- **C**: Slidewise's `applyEdits` and `serializeDeck`, as a reference.

B and C are installed and run outside this repository; this folder holds A's runs, the comparison every arm goes through, and the bench that drives each arm's editor in Electron.

## The decks

`corpus.ts`: the PowerPoint patch spike's 58 public decks (`../pptx/corpus.ts`) and 8 public decks whose text is Chinese, each pinned by URL and SHA-256, fetched at run time into the folder `DECK_EDITOR_LANE` names, never committed.

## The corpus run (measures 1 to 3)

`targets.ts` chooses, from each original and with our own reader, the edits every arm makes: words typed at the end of the first paragraph with words in one text shape on each of the first three slides that have one, and one shape on each of the first three slides moved 24 px right and 12 px down and made a tenth wider.

```sh
export DECK_EDITOR_LANE=<a folder of your own>
DECK_EDITOR_PHASE=a npx vitest run -c eval/deck-editor/vitest.config.ts        # fetch, choose, make A's copies
DECK_EDITOR_PHASE=compare npx vitest run -c eval/deck-editor/vitest.config.ts  # measure every arm's copies in $DECK_EDITOR_LANE/out/<arm>
```

`compare.ts` measures each copy against its original: parts whose stored bytes or content changed, parts lost or added, the elements a changed part lost, changes on an edited slide outside the edited shapes, whether our reader reads the copy back with the edits, whether every written part is well-formed XML, and whether every relationship's target is there.

## The bench (measures 2 to 8 through the editors)

`bench/` opens one arm's page in an Electron window with a home, data folder and request log of its own (`bench/host.ts`), and drives it as a person would (`bench/*.bench.ts`): typing through an input method over the DevTools Protocol, dragging and sizing shapes, finding a quote's words in the page, and picturing slides.

```sh
BENCH_OUT=$DECK_EDITOR_LANE/bench/A npx vite build -c eval/deck-editor/bench/vite.config.ts
npx esbuild eval/deck-editor/bench/host.ts eval/deck-editor/bench/preload.ts --bundle --platform=node --format=cjs --external:electron --outdir=$DECK_EDITOR_LANE/bench/host
npx playwright test -c eval/deck-editor/bench/playwright.config.ts
```
