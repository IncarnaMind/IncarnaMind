# #1709 verification record

Updated 2026-10-28. All issue acceptance criteria and the real-model hand checks are complete; full PR CI remains.

## Deterministic and public-core evidence

- Parser: 209 tests, including ten fixtures of every accepted shape and reading-order/`Id.`/`supra` cases.
- Deposition mapping and processing: 17 tests, including digital/OCR layouts and page breaks. Two scanned PDF pages pass through the actual render → OCR → stored-anchor path before resolving across their break.
- Resolver and public source choice: candidates, normalized aliases, stable-id choices after a name no longer matches, only-one-occurrence recheck, deleted/changed choices, direct checks with no Note, positional cross-sentence `Id.`, Search scope/exclusions, timestamp persistence and deletion-driven Needs re-check.
- Shared resolving fixtures: 160 exact Document/Location/Passage cases, ten of every accepted shape, all green.
- Fixed-passage judgement: Supported, Partly and Not found, retained/rejected nearby suggestions, raw-citation removal from the factual claim, and no nearby display for a Supported cited result.
- History and concurrency: exact raw/claim/position validation, unique-only proposed-id fallback, direct-cite reading order, fresh-plus-recheck ordering, complete Note history including pending and uncited sentences, contradiction watch, nested writes and cut validation.
- All affected suites: **797 tests** pass across parser, exact resolving fixtures, deposition, Check record, renderer record-cite retention, claim checks, scope, Mind checks, contradiction watch, written checks, public-core choices, DOCX and public-evaluation key/scoring.
- Full TypeScript typecheck and full Biome lint pass; only the repository's existing warnings remain.

## Public court records and real models

`eval/record-cites/set.json` keys ten expected cite results across eight claims against two saved federal court orders. Both PDFs, their public sources, public-domain basis, retrieval dates and SHA-256 hashes are saved. `tests/eval/recordCitesSet.test.ts` resolves every key to the intended Document and exact Location with no misses.

The set covers English and Chinese claims, Supported, Partly, wrong-page Not found with exact nearby evidence, `Id.`, `supra`, a genuine two-Document ECF No. 41 ambiguity and an unmatched docket. Reports record every actual and expected result, every miss, request replies, tokens, request time and core-counted USD spend.

At `5862dad3474e987528e5f33867fd76986c2d3e66`:

- **Claude Haiku 5.5: 10/10, zero misses.** 20 requests, 158,690 input and 3,146 output tokens, 28.7 s of requests, 69.4 s end to end, **$0.009558185**. [Report](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/haiku-report.md) · [Full results](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/haiku-report.json).
- **Claude Sonnet 5.5: 10/10, zero misses.** 26 requests, 198,219 input and 2,735 output tokens, 51.7 s of requests, 106.6 s end to end, **$0.1946039**. [Report](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/sonnet-report.md) · [Full results](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/sonnet-report.json).

Earlier provider-credit failures are excluded from accuracy evidence. A Kimi K2.6 attempt returned `Invalid Authentication` before judgement and is also excluded; no Kimi accuracy claim is made.

## DOCX

- Native DOCX: 24/24 `wordReview` tests. An overall-Supported sentence carries every record-cite result and Passage in its comment, in raw order, in English and Chinese; all existing sentence counts remain zero. An existing overall Not found keeps its prefix and count.
- Imported DOCX: the focused patch test and full `wordExport` suite pass. The test preserves an existing Word comment, balanced/distinct comment ranges and the unrelated paragraph's exact XML.
- The Check record lists each record cite independently; it does not inflate sentence counts.

## Built app

`e2e/recordCites.spec.ts` passes both flows on the final test build:

- all four outcomes remain visible in raw order on an overall-Supported card;
- cited and nearby Passages open at their physical pages;
- duplicate names are distinguished by stable Document id and a live, shortened local path detail, without persisting that path in Note content;
- choosing re-checks only that cite, restores keyboard focus and survives closing/reopening the app and Note;
- the narrow Chinese card and source picker have no horizontal/window overflow and retain raw English cites.

Screenshots and recording (public test data):

- [English card](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-en.png)
- [Chinese source picker at 900 px](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-picker-narrow-zh.png)
- [Chinese card at 900 px](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-narrow-zh.png)
- [Built flow recording](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/record-cites-flow.mp4)

Real-model built-app hand checks also pass on Haiku 5.5 and Sonnet 5.5, each in English and Simplified Chinese: select the public claim, choose Check against Documents, open the card and verify the Supported record cite with its exact Passage. [Haiku English](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/hand-haiku-en.png) · [Haiku Chinese](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/hand-haiku-zh.png) · [Sonnet English](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/hand-sonnet-en.png) · [Sonnet Chinese](https://raw.githubusercontent.com/IncarnaMind/pr-screenshots/main/1709/hand-sonnet-zh.png).

## Independent review and versions

Self-review and CodeRabbit's findings are addressed: evidence-only judgement, EvidenceScope/exclusions, chosen versions, timestamp choices, invalid choices, exact Bates suffixes, positional history, all cloud paths, whole printed deposition pages, duplicate details without device-path persistence, complete Note history and duplicate-position ambiguity. The established provider-failure rule remains overall `not-checked`, with no fabricated per-cite verdict. The CTO's independent review follows full CI; subagent reviews are not independent approval.

Latest main was merged and rechecked: main is schema 30/PDF 14; this branch is `CONTENT_SCHEMA_VERSION = 32` and PDF `PROCESSING_VERSION`/`CURRENT_SINCE.pdf = 15`, with no SQL migration.

## Still open before merge

1. Push the exact head and run full CI.
2. Complete the CTO's independent review.
