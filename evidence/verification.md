# #1709 verification record

Updated 2026-10-27. This is not yet a claim that every acceptance box is met.

## Deterministic and public-core evidence

- Parser: 209 tests, including ten fixtures of every accepted shape and reading-order/`Id.`/`supra` cases.
- Deposition mapping and processing: 17 tests, including digital/OCR layouts and page breaks.
- Resolver and public source choice: 30 resolver tests plus 11 public-core choice tests. These cover candidates and duplicate details, normalized aliases, stable-id choices after a name no longer matches, only-one-occurrence recheck, deleted/changed choices, direct checks with no Note, positional cross-sentence `Id.`, Search scope/exclusions, timestamp persistence and deletion-driven Needs re-check.
- Shared resolving fixtures: 160 exact Document/Location/Passage cases, ten of every accepted shape, all green. Two scanned PDF pages also pass through the actual render → OCR → stored-anchor path before resolving across their break.
- Fixed-passage judgement: 6 tests, including a retained supported nearby suggestion, rejection of an unhelpful one, and no nearby display for a Supported cited result.
- All affected suites: 748 tests pass across parser, exact resolving fixtures, deposition, Check record, renderer record-cite retention, claim checks, scope, Mind checks, contradiction watch, written checks, public-core choices, DOCX and public-evaluation key/scoring.
- Full TypeScript typecheck and full Biome lint pass; only the repository's existing warnings remain.

## Public court records

`eval/record-cites/set.json` keys ten expected cite results across eight claims against two saved federal court orders. Both PDFs, their public sources, public-domain basis, retrieval dates and SHA-256 hashes are saved. `tests/eval/recordCitesSet.test.ts` resolves every key to the intended Document and exact Location with no misses.

The set covers English and Chinese claims, Supported, Partly, wrong-page Not found with exact nearby evidence, `Id.`, `supra`, a genuine two-Document ECF No. 41 ambiguity and an unmatched docket. `eval/record-cites/recordCites.eval.ts` is the real-model runner. Its report schema records every miss, actual request replies, tokens, request time and core-counted USD spend.

**Real Haiku 5.5 and Sonnet 5.5 runs: pending; no accuracy claim made yet.** The existing credential setup is available and keeps keys outside the repository.

## DOCX

- Native DOCX: 24/24 `wordReview` tests. An overall-Supported sentence carries every record-cite result and Passage in its comment, in raw order, in English and Chinese; all existing sentence counts remain zero. An existing overall Not found keeps its prefix and count.
- Imported DOCX: the focused patch test passes and the full `wordExport` suite passes in the broader run. The test preserves an existing Word comment, balanced/distinct comment ranges and the unrelated paragraph's exact XML.
- The Check record already lists each record cite independently; it does not inflate sentence counts.

## Built app

`e2e/recordCites.spec.ts` passes 6/6 (both flows repeated three times) on the test build:

- all four outcomes remain visible in raw order on an overall-Supported card;
- cited and nearby Passages open at their physical pages;
- two duplicate names remain distinct by stable Document id;
- choosing re-checks only that cite, restores keyboard focus and survives closing/reopening the app and Note;
- the narrow Chinese card and source picker have no horizontal/window overflow and retain raw English cites.

Screenshots (public test data, in the screenshots repository):

- [English card](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-en.png)
- [Chinese source picker at 900 px](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-picker-narrow-zh.png)
- [Chinese card at 900 px](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-narrow-zh.png)
- [Built flow recording (5.6 s)](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-flow.mp4)

## Independent-review corrections

The final diff also fixes the review's concrete findings: the model now judges the Passage rather than the raw cite; cross-sentence `Id.`/`supra` use an immediate, position-validated Note referent, never a later item or the cite itself; all cloud check paths preserve reading order for references; deposition `Id. at N` uses printed page maps; duplicate candidates carry local source details; resolution honors EvidenceScope and checked-Document exclusions; chosen sources join `check.versions`; timestamp choices persist; invalid choices become actionable Not found/Choose results; Bates matching rejects alphanumeric suffixes. The established provider-failure rule remains overall `not-checked`, with no fabricated per-cite verdict.

## Still open before `Closes #1709`

1. Merge current main and recheck `CONTENT_SCHEMA_VERSION`, `PROCESSING_VERSION` and `CURRENT_SINCE.pdf`.
2. Run the public evaluation and hand checks with real Claude Haiku 5.5 and Sonnet 5.5; save both reports with every miss, EN/ZH, timing and spend.
3. Run final full CI and address independent review findings.
