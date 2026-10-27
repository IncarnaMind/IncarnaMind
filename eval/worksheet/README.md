# Revision worksheet attribution (#1979)

The fixtures in `tests/fixtures/revision-control/` are regenerated synthetic Documents, not the original B13 PDF. Both contain the issue's exact two revisions, dates, policy codes, limits and worksheet inputs, including the Chinese status and maximum-load lines. Page 1 is superseded and deliberately contains 0.150 and 0.250 in different roles from the current page 2.

`raster.pdf` has two upright image-only pages. `text.pdf` has the same words and values in a text layer; it is a content control, not a pixel-identical copy. The manifest records their SHA-256 hashes and source values. The synthetic content is covered by the repository's license.

To regenerate into a temporary folder, provide font files containing Latin and Simplified Chinese glyphs:

```sh
node --import ./scripts/tsResolve.mjs eval/worksheet/generate.ts "$LATIN_FONT" "$CHINESE_FONT" "$FIXTURE_OUTPUT"
```

This uses `tests/helpers/pdf.ts` and the existing canvas dependency. The measured raster used Arial and Hiragino Sans GB; different fonts or rendering versions can change the bytes. Use the committed files when comparing the recorded runs.

Import each fixture into a fresh app profile. For the raster, wait for the real OCR model and both scanned pages to be Ready; check both rows before measuring. For the text twin, confirm that there are no scanned pages. Select only that Document, start a new Conversation, and ask the issue's exact Question:

> Using only the scoped Document, identify the currently applicable revision and its date, policy code and maximum load in both kilograms and grams. Recompute the current load worksheet from every item’s unit mass and quantity, showing the arithmetic, and say whether it equals the current limit. Keep superseded and current values separate. Quote the Chinese current-status and maximum-load lines, and cite the original pages supporting your conclusions. Do not guess unreadable quantities.

Use Claude Haiku 5.5 and Sonnet 5.5, three Answers per model/format, on main before changing behavior and again on the branch. Use a $5 total task cap and retain every completed run or failure, including spend. Supplement with the same Question translated into Chinese, one Answer per model/format. No expected numeric answer is supplied in the Question.

Score separately:

- Current arithmetic: 0.075 × 2 = 0.150, 0.050 × 2 = 0.100, total 0.250 kg, equal to the current limit. Record the requested 250 g conversion separately if omitted.
- Attribution: inspect every current input, subtotal and total Citation for page 2 and enough row/role context. A bare value or unlabelled string of numbers fails this criterion, even when found and numerically correct.
- Comparison: reject a claim that only policy/limit changed. The bead unit mass and control-weight quantity also changed. Record explicit changed-input coverage separately from false exhaustive claims; the neutral Question does not demand an exhaustive change list.
- Source navigation: open an input Citation and check the original row, rather than a same-valued date digit, limit or superseded subtotal. Check Chinese quotations too.
- Add to note: compare quote, Document id, content hash and page attributes before and after saving.

Calibrate the attribution review against five controls: accept full current page-2 rows; reject superseded page-1 weight subtotal 0.150 as current bead subtotal; reject superseded bead subtotal 0.250 as current total; reject the policy/limit-only conclusion; accept a page-1 row explicitly used for the superseded comparison. Quote-found still measures presence, not sentence support.

The fixture is a development case with no held-out set. Small repeated samples do not establish general model reliability. Record actual model ids, source hashes, code revisions, counts, spend and limitations in the pull request.
