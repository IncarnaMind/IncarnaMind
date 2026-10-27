# #1709 proposed domain design for architecture review

## Recommended model

1. **One parser and resolver, no second legal-citation engine.** A shared `recordCites` module turns supported shapes into a small AST: source alias, shape, exact Location, and the preceding cite for `Id.`/`supra`. Core resolves it against live Documents and stored per-Mind history; it never chooses the first candidate and never asks a model to infer identity.
2. **Deposition reuses `page`.** The existing `page` Location gains optional `lines?: { from, to }`, the printed line on the first printed page and on the last, so `45:3–46:2` is printed pages 45–46 with lines 3–2. `pageFrom/pageTo` and `printed` keep their current physical/printed-page meanings, and normalization preserves `lines`; an older reader can still open the page. Text and OCR extraction attach source line labels and physical anchors only to documents with an explicit `Page N` layout, with layout-order fallback when line labels are absent. Exhibit, ECF, Bates and recording keep existing `page`/`section`/`time` Locations; legal paragraph ranges use the existing paragraph range where it fits, not a second meaning for OCR `lineN` or plain-text `lines`.
3. **Every outcome stays per cite.** `ClaimCheckResult` and `ClaimCheckAttributes` gain an optional `recordCites` array. Each entry keeps the raw cite, resolved Document id/name/version, exact Location, outcome (`supported`, `partly`, `choose`, `not-found`), supporting passage, candidate Document ids when choice is required, and an optional nearby suggestion. The existing overall verdict stays for the sentence as a whole; the array is what lets the Check record and Word comments list every miss. Older editors would misread this content, so `CONTENT_SCHEMA_VERSION` rises once, allocated from the next free number on main at merge and rechecked after every main merge. No SQL data migration is implied by that choice.
4. **Ambiguity is a result, then a choice stored in existing settings.** One/two/many/no candidates resolve as unique / `choose` with candidate Document ids / `choose` / `not-found`. The card asks once and the only new API writes that choice and re-checks only that cite; candidates are already in its result. Existing `content.editSettings` stores choices by normalized alias as Document id plus exact Location, the way citation style is stored. Background and direct `checkClaim` use the same result states and never guess. Deleted or changed chosen Documents drop the saved choice and require re-resolution.
5. **Results use existing surfaces.** `withResult` copies the array. `ClaimCheckShown` keeps the current overall result/recheck semantics and adds the per-cite details needed by the card. PDF/CSV Check records list each entry; Word comments carry the passage and Document/page. English and Simplified Chinese use the existing overall vocabulary, with no new margin glyph.
6. **Extraction is isolated.** Only PDF deposition layouts gain the new anchors, with a `PROCESSING_VERSION` bump for that format only. Existing Units, boilerplate removal, quote matching and old Citation versions remain unchanged. No network Source provider or CourtListener connector is added for this feature.

## Alternatives rejected

- Reusing plain-text/OCR `lines`: they are file-global or reading-order, not printed deposition lines and would point to the wrong words.
- Treating an overall sentence verdict as enough: it cannot list every record-cite result or ambiguity, so misses would disappear from the Check record.
- Filename-only/first-match resolution: two Documents can share a name, exhibit or docket, so this silently invents certainty.
- Guessing or silently choosing a source inside any check: ambiguity is a `choose` result with candidates, including background and no-Note checks; only the card turns it into a stored choice.
- A CourtListener provider for record matching: unnecessary for local Documents and would add network/consent scope without solving exact Location.

## Test shape

- Parser/fixture tests for every shape and boundary, including two Units and page breaks, no earlier referent, deleted source, and duplicate candidates.
- Public-core tests for unique/ambiguous/changed choices, `Id.`/`supra`, no-Mind behavior and stored rechecks.
- Digital and scanned deposition fixtures proving printed page+line to physical Unit mapping and exact highlighting.
- PDF/CSV record and DOCX comments proving every result and passage survives, with no repair prompt.
- Public-record evaluation with its key and every miss listed; real Haiku/Sonnet checks for the model-dependent support and nearby-evidence flow, with EN/ZH, timing and spend.
