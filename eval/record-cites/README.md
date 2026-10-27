# Public record-cite evaluation (#1709)

`set.json` is the key. Its two Documents are saved federal court orders, with their public source URLs, public-domain basis, retrieval dates and SHA-256 hashes. The ten expected cite results cover English and Chinese claims, Supported, Partly, wrong-page Not found with a nearby suggestion, `Id.`, `supra`, a genuinely ambiguous ECF No. 41 and an unmatched docket number.

The Regency order is the only Document until the ambiguity case; the Robinson order is then added through the core, so the earlier unique matches do not become ambiguous by accident. Every expected Document, Location, Passage, candidate set and nearby suggestion is checked against processing in `tests/eval/recordCitesSet.test.ts`, without a model.

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
