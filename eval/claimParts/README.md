# Claim parts evaluation

Frozen synthetic set for [#2002](https://github.com/IncarnaMind/IncarnaMind/issues/2002): **72 cases / 36 English–Simplified Chinese pairs**, 112 logical Sources and 72 isolated Document profiles. [Before baseline](https://github.com/IncarnaMind/IncarnaMind/issues/2002#issuecomment-6481763531) was posted before implementation. The feature pull request carries the complete measured outcomes, including misses and the failed first candidate.

- [cases.json](cases.json) keeps exact sentences, UTF-16 `[start,end)` spans, fact/opinion kinds, expected verdicts, quote expectations, coverage and calculation requirements.
- [sources.json](sources.json) keeps the Source bank and exact Documents for each profile. Import **only the Documents in the case's `source_profile_id`**. Importing the entire bank invalidates missing-evidence cases. Map logical Source ids to actual imported Document/Passage ids.

## Measurement

The before source is `1ab6333165df86a2b818466f53d3a5953c124350`; use these same fixtures for both source arms.

Run the same ordered cases before and after on Haiku 5.5 and Sonnet 5.5. Record the exact source commit, model id, actual settings, requests, usage, latency, errors and every outcome. Keep configured seed/order/temperature policy fixed and report provider support. Run the existing sorter twice over all sentences: own Note and Verify. Independently call public core `checkClaim` for every case with a fresh isolated profile. These are separate measurements, **not a full Note/Verify UI pipeline**. Record actual batch requests when sorting changes.

Score inclusion separately from exact returned kind/spans. Compare native part rows, original-language checked Citations, per-part coverage and omission inventories; missing fields score missing/zero, never inferred from scalar verdicts or gold. Derived quantities need a successful calculation receipt with all required checked inputs, compatible units/periods and a matching computed result. Formula references describe expected arithmetic; an equivalent supported formula is valid, and the reference text remains unchanged.

There are **52 factual/mixed native verdict golds and 20 pure-opinion controls**. Independent `checkClaim` on a pure opinion is an explicit check: retain its native outcome as an observation, without scoring against null verdict gold or counting a checked opinion as automatically left out. Score automatic sorting/omission behavior separately. Only returned opinion spans actually left unjudged count as omissions; M01's prefix and suffix each count once.

Acceptance subsets overlap: complete summaries 10, mixed facts 10, pure opinions 20 and unbacked-cause negatives 10. F01's bare future assertion is scored Unsupported against its forecast-only Source, with the exact reason/action in gold. A01 accurately attributes that same forecast and is scored Supported. A02 retains the negative speaker/quote control.

## Observed results

Both final models retained all 72 cases on `1919eafb87a9692eac591a19887c4b73daa9c368`. Kimi was not run: no balance. No gold, Source profile, order or scoring rule changed after freezing.

| Native verdict agreement | Haiku 5.5 before → after | Sonnet 5.5 before → after |
|---|---:|---:|
| All factual/mixed cases | 48/52 → 44/52 | 49/52 → 49/52 |
| Complete summaries | 9/10 → 9/10 | 10/10 → 10/10 |
| Mixed fact/opinion | 9/10 → 9/10 | 9/10 → 10/10 |
| Unsupported causal links | 10/10 → 9/10 | 10/10 → 10/10 |
| Bare forecast | 0/2 → 2/2 | 0/2 → 2/2 |
| Attributed forecast | 2/2 → 2/2 | 2/2 → 2/2 |
| False Supported | 2 → 0 | 2 → 0 |
| Whole-parent accepted calculations | 1/4 → 3/4 | 2/4 → 4/4 |

Both final models classify 72/72 correctly in each sorting view, retain mixed fact/opinion representation in 10/10, and omit all 20 pure opinions. Exact inventories are stricter: Haiku's own/Verify part spans match 33/72 and 31/72, and opinion spans match 43/72 and 50/72; Sonnet's are 38/72, 36/72 and 54/72, 54/72. Punctuation, quote boundaries, member labels and alternative decompositions remain scored as misses.

Raw verdict agreement is not complete proof. Exact frozen proof matches account for 10/16 final Supported results on Haiku and 13/17 on Sonnet. Haiku has five punctuation-only mismatches and one merged causal inventory; Sonnet has three punctuation-only mismatches and one checked causal subquote. Every actual checked quote remains in the measured record. Quantified coverage is persisted for 7/8 Haiku cases and 8/8 Sonnet cases, with actual counts of 3/4 or 2/5; Haiku Q03-en omits its structured inventory. Both models correctly leave all eight quantified cases Unsupported. Strict coverage matches remain 0/8 because the exact frozen spans/labels differ; the missing inventory earns no credit.

Haiku's raw misses are S04-en, M05-zh-CN, A02-en, A02-zh-CN, C02-en, U01-en, U01-zh-CN and I02-en. Its two true Contradicted controls both become Not checked; zero false Contradicted does not mean successful contradiction recall. Sonnet's misses are C02-en and both U01 cases. Failed calculations and unresolved Citations stay Not checked. Both models over-refuse the English causal attribution against its frozen Supported gold; neither accepts the full-series U01 calculation attempts. No result was repaired by changing its gold.

| Native case duration / total requests | Haiku before → after | Sonnet before → after |
|---|---:|---:|
| Mean seconds | 4.747 → 7.946 | 7.283 → 14.760 |
| p95 seconds | 9.093 → 18.477 | 11.648 → 31.146 |
| Provider requests, including sorting | 259 → 452 | 279 → 527 |

These are per-case durations with actual internal calls, not per-provider-call latency. The rich sorter makes six bounded batches per view; before made one. The first full candidate is also retained: Haiku 23/52 with both sorting views failing, 485 requests and $0.090247380. No Sonnet run was made on that candidate. The final runs cost $0.090435540 and $1.412583600 respectively. Including both baseline runs and that failed candidate, known usage is **$2.330077335 of the $5 cap**, with zero unresolved exposure; all 2,002 request records are terminal and counted. These are usage-based accounting figures, not an invoice.

The published record contains all 360 native observations and 720 sorting rows from the five arms. Missing baseline part fields remain null. The observer's part-shape adapter replayed the original baseline byte-identically; only explicit arm selection changed, and the grading function stayed unchanged. UI mechanics and the four report-only Local-mode cases are separate from this cloud measurement.

## Integrity

Only operational wrapper metadata was removed. Every case, gold object, text, span, formula reference, Source and profile is unchanged.

| Published file | SHA-256 |
|---|---|
| cases.json | `f5f529f6f0eb39aec35368351e5e94227475cdd8ce2ea3713a7099c241e29aa6` |
| sources.json | `0abecb239359295e17cacc62327d5b70bc5f53e8b44fae5684b8946752fafe54` |

Original benchmark artifact hashes (including their original wrapper metadata): dataset `3b80d5233a61d5da3dd34b1c8719dd672a20eced54f02021354bca4009cb6997`; Sources `43bfa0ae2888a1cc735438992135a3777457b6ead96e5f4968b19e6bb870177f`. Published file hashes differ because of wrapper removal and formatting; measurement payloads are identical.
