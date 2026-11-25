# PowerPoint patch spike

`npx vitest run -c eval/pptx/vitest.config.ts` runs the PowerPoint patches (`src/core/exports/pptxPatch`, #1264) over a corpus of public decks and writes what it finds to `eval/results/pptx-<start>/`. Neither `npm test` nor CI's checks run it; `.github/workflows/pptx-spike.yml` does, on demand and on pushes to the spike's branch.

## The corpus

`corpus.ts`: public decks, each pinned by URL and SHA-256 and fetched into the evaluation's cache when the spike runs. None is committed. A file whose bytes no longer match its hash stops the run. The corpus holds government, university, association and company decks, decks saved by WPS, LibreOffice and Keynote, and decks with charts and their workbooks, SmartArt, animations, comments, audio and video, several masters, and Chinese and Japanese text.

## What it does to each deck

- **Saves it with no edit.** Every part must keep its stored bytes.
- **Edits three slides.** On the first three slides with a text shape, it sets the shape's first paragraph and the slide's notes; a slide without notes gets a notes slide, and a deck without a notes master gets one. It then checks that:
  - every part it didn't edit kept its bytes: masters, layouts, themes, fonts, SmartArt, comments, media, embeddings and the other slides;
  - on an edited slide, only the edited shape's text changed, and the animations kept their bytes;
  - the copy reads back with the new text.
- **Changes a chart's data**, on the first chart with an embedded workbook. The chart's cache and the workbook must then agree, point by point.

It also makes a new deck from a template: python-pptx's default template (MIT, made in PowerPoint), made 16:9 and given East Asian theme fonts, all through the same patches. And it writes a deck whose chart frame carries a Citation tag and whose chart workbook has a note on a cell, for a person to edit in PowerPoint and check that both survive.

## In CI

The workflow runs the spike, then two checks on every original and every copy:
- the Open XML SDK's validator (`validator/`, MIT) checks the schema;
- LibreOffice opens each file and converts it to PDF.

It uploads the copies and the results as the `pptx-spike` artifact. It also uploads `pptx-owner-check`: ten sampled decks, each beside its patched copies, the template deck and the Citation test, with `CHECK.md` saying what to look for in PowerPoint and WPS. LibreOffice runs in CI only.
