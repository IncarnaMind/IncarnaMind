# Public record-cite evaluation (#1709)

`set.json` is the key. Its seven Documents include saved federal court orders, byte-for-byte evaluation copies for exhibit and legal-paragraph aliases, a Bates-labelled excerpt of public-domain order text, a deposition re-typeset from CC0 fictional material, and one clearly labelled test-only generated VTT. Sources, sharing bases, dates and SHA-256 hashes are recorded for each. The 33 expected cite results across 29 claims cover English and ten Chinese claims: Supported, Partly, located-but-unsupported wrong pages and deposition lines with nearby suggestions, deposition Q/A lines (one line, a range across a page break, a list of ranges), exhibits, a party's exhibit that must not reach the bare one, Bates numbers and ranges, `¶` and `¶¶`, source-named recording times beside a clock time in prose, `Id.` with its own lines, a named `supra`, a genuinely ambiguous ECF No. 41 and an unmatched docket number.

A case with a `note` is checked as the User checks a Note: its paragraphs are written into a Note and every sentence is checked, so the sentence splitting, a sentence of cites alone and an `Id.` that refers to an earlier sentence are measured too. The other cases go through the core's `checkClaim`.

Each case lists its available Document keys. The model runner loads the Documents needed by the selected cases and gives every `checkClaim` case its explicit Search scope, so unique matches do not become ambiguous by accident; a Note's sentences search the Documents the run loaded. Each Document also declares its kind and expected Unit count; PDFs and the Transcript go through the same processing path. Every expected Document, Location, Passage, candidate set and nearby suggestion is checked against processing in `tests/eval/recordCitesSet.test.ts`, without a model. Resolution expects the internal `found` outcome. A located cite's final outcome is Supported, Partly, Unsupported or per-cite Not checked; unresolved cites remain Choose or Not found.

Run the deterministic key check:

```sh
npx vitest run tests/eval/recordCitesSet.test.ts
```

Run the full detection → resolution → support-judgement flow with a real model:

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic \
INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
INCARNAMIND_EVAL_CHAT_KEY=… \
npm run eval -- eval/record-cites
```

Repeat with `claude-sonnet-5-5`. Setting the variables consents to send these public claims and Passages to that model. `INCARNAMIND_EVAL_RECORD_CITES_CASES` optionally limits the run to comma-separated case ids for diagnosis; leave it unset for reportable evidence.

Each run writes `eval/results/<timestamp>-record-cites/report.md` and `report.json`: every actual and expected result, every miss, request replies, tokens, request time and the core's USD spend. A run is evidence, not a gate that hides misses.
