# Claim parts evaluation

Frozen synthetic set for [#2002](https://github.com/IncarnaMind/IncarnaMind/issues/2002): **72 cases / 36 English–Simplified Chinese pairs**, 112 logical Sources and 72 isolated Document profiles. [Before baseline](https://github.com/IncarnaMind/IncarnaMind/issues/2002#issuecomment-6481763531) is posted; **after results: TBD**.

- [cases.json](cases.json) keeps exact sentences, UTF-16 `[start,end)` spans, fact/opinion kinds, expected verdicts, quote expectations, coverage and calculation requirements.
- [sources.json](sources.json) keeps the Source bank and exact Documents for each profile. Import **only the Documents in the case's `source_profile_id`**. Importing the entire bank invalidates missing-evidence cases. Map logical Source ids to actual imported Document/Passage ids.

## Measurement

The before source is `1ab6333165df86a2b818466f53d3a5953c124350`; use these same fixtures for both source arms.

Run the same ordered cases before and after on Haiku 5.5 and Sonnet 5.5. Record the exact source commit, model id, actual settings, requests, usage, latency, errors and every outcome. Keep configured seed/order/temperature policy fixed and report provider support. Run the existing sorter twice over all sentences: own Note and Verify. Independently call public core `checkClaim` for every case with a fresh isolated profile. These are separate measurements, **not a full Note/Verify UI pipeline**. Record actual batch requests when sorting changes.

Score inclusion separately from exact returned kind/spans. Compare native part rows, original-language checked Citations, per-part coverage and omission inventories; missing fields score missing/zero, never inferred from scalar verdicts or gold. Derived quantities need a successful calculation receipt with all required checked inputs, compatible units/periods and a matching computed result. Formula references describe expected arithmetic; an equivalent supported formula is valid, and the reference text remains unchanged.

There are **52 factual/mixed native verdict golds and 20 pure-opinion controls**. Independent `checkClaim` on a pure opinion is an explicit check: retain its native outcome as an observation, without scoring against null verdict gold or counting a checked opinion as automatically left out. Score automatic sorting/omission behavior separately. Only returned opinion spans actually left unjudged count as omissions; M01's prefix and suffix each count once.

Acceptance subsets overlap: complete summaries 10, mixed facts 10, pure opinions 20 and unbacked-cause negatives 10. F01's bare future assertion is scored Unsupported against its forecast-only Source, with the exact reason/action in gold. A01 accurately attributes that same forecast and is scored Supported. A02 retains the negative speaker/quote control.

## Integrity

Only operational wrapper metadata was removed. Every case, gold object, text, span, formula reference, Source and profile is unchanged.

| Published file | SHA-256 |
|---|---|
| cases.json | `f5f529f6f0eb39aec35368351e5e94227475cdd8ce2ea3713a7099c241e29aa6` |
| sources.json | `0abecb239359295e17cacc62327d5b70bc5f53e8b44fae5684b8946752fafe54` |

Original benchmark artifact hashes (including their original wrapper metadata): dataset `3b80d5233a61d5da3dd34b1c8719dd672a20eced54f02021354bca4009cb6997`; Sources `43bfa0ae2888a1cc735438992135a3777457b6ead96e5f4968b19e6bb870177f`. Published file hashes differ because of wrapper removal and formatting; measurement payloads are identical.
