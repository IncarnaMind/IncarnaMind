# #1709 verification record

Updated 2026-10-28. The CTO's 13-point review at `48ed7ab72` is addressed. Real-engine/model evidence, full PR CI and the CTO's re-review remain open.

## Deterministic and public-core evidence

- Real Note detection: English and Simplified Chinese paragraphs containing `(Smith Dep. 45:3–12)` each produce two checked sentences, with the complete cite resolved to printed page 45, lines 3–12. The generic abbreviation list is unchanged: a boundary is repaired only when a complete record-cite shape crosses it.
- Parser: 230 tests, including ten fixtures of every accepted shape, exact UTF-16 spans, legal prefixes, single/cross-page lines, source-qualified recording times, case-law boundaries, named `supra`, and ordinary-prose controls.
- Deposition: digital/OCR layouts, inline and both margin directions, captions, ambiguity, duplicate labels, missing labels, cross-page ranges and multiple logical pages on one physical Unit. Unlabelled and ambiguous regions never receive invented mappings.
- Resolution and choices: internal `found` before judgement, stable Document id plus content hash per canonical alias, independent per-alias settings keys, full Bates ranges, changed/deleted sources, exact scope/exclusions, only-one-occurrence recheck, and no stored previous referent.
- History and loading: current Note and proposed text, pending and short uncited sentences, unique-only claim fallback, case-law boundaries, named history across sentences, unresolved-only immediate-referent clearing, concurrent cloud checks, one shared lazy Document factory, and keyword/label-assisted Bates lookup.
- Outcomes and errors: Supported, Partly, Unsupported, Choose, Not found and per-cite Not checked. An auxiliary failure changes only its cite and never the overall sentence verdict; optional nearby evidence is independently judged in both directions. Local mode, declined consent, provider wording and disappeared choices keep their own errors.
- Full TypeScript typecheck and full Biome lint pass with only the repository's existing warnings. All three full unit shards pass, including Check record, DOCX, renderer retention and the deterministic public evaluation key.

## Public evaluation set

`eval/record-cites/set.json` holds 7 Documents, 18 claims, 20 expected results and 6 Chinese cases. It includes saved federal court orders, byte-for-byte evaluation aliases, a Bates-labelled public-domain excerpt, a CC0 fictional deposition and a clearly labelled generated VTT. Sources, sharing bases, dates and SHA-256 hashes are recorded.

The deterministic key check covers deposition Q/A and page breaks, wrong lines with nearby evidence, exhibits, Bates identifiers/ranges, `¶`/`¶¶`, source-qualified recording times, `Id.`, `supra`, ambiguity, unmatched dockets, Supported, Partly and located-but-unsupported outcomes. Every expected Document, Location, Passage, candidate and nearby suggestion resolves without a deterministic miss. Unexpected extras remain misses without reducing the matched numerator.

Fresh final-head real-model reports are still to be run on the exact clean head with Claude Haiku 5.5, Claude Sonnet 5.5, Kimi K2.6 if its window is available, and a small local Ollama model. Earlier reports at `5862dad34` are not evidence for this head.

## Real OCR

`e2e/packaged/depositionScans.packaged.ts` imports clean large-print scanned Pages 45–47 through the packaged app's real PP-OCR engine. It requires exact stored printed anchors and resolves `Smith Dep. 45:3–46:2` to four intended rows on physical pages 8–9, excluding headers, neighbouring rows and Page 47. The test is authored but has not run yet; no real-OCR pass is claimed.

## Built app

The earlier screenshots and recording under `pr-screenshots/1709` cover the card and picker presentation. The record-cite e2e fixture wrote results directly onto checks, so it did not prove real Note detection. The public-core regressions above now prove detection. Final built-flow evidence will be re-recorded after the model and OCR checks.

## Independent review and versions

Subagent reviews are self-review only. The CTO's independent review found sentence splitting, exact-line/source resolution, settings/history, loading, version, evidence and error issues; those findings are implemented with public-core regressions. No independent approval is claimed.

Latest main was rechecked: main is schema 30/PDF 14; this branch is `CONTENT_SCHEMA_VERSION = 33` and PDF `PROCESSING_VERSION`/`CURRENT_SINCE.pdf = 16`, with no SQL migration.

## Still open before merge

1. Run the real packaged OCR test and fresh final-head model evaluations.
2. Re-record the built flow, push the exact head and run full CI.
3. Complete the CTO's independent re-review.
