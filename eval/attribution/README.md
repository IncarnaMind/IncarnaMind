# Source, speaker, context and time checks

The check can find a quote without retaining a separate result for the source, speaker or period its sentence asserts (#2003). These fixtures exercise those attributes under the same Check and its ordinary part rows.

`cases.json` contains 40 synthetic sentences: 20 English and 20 Simplified Chinese, with 48 Sources and 40 isolated scope profiles. The golds are 12 Supported, 16 Unsupported and 12 Contradicted. The ten explicitly reversed-context cases form the 9-of-10 contradiction bar. Correct attribution, preserved qualifications, historical periods and a fresh present-time statement guard against rejecting every case.

| Case family | Cases | Required behavior |
| --- | ---: | --- |
| Named source | 8 | Correct report; wrong report; missing name; duplicate names requiring a choice |
| Speaker | 6 | Correct named speaker; another named speaker; anonymous label |
| Context | 12 | Five reversed-context pairs and one preserved-qualification pair |
| Time | 14 | Historical period; newer conflict; old-only scope; file-date decoy; expired period; no period; fresh current statement |

The injected Check clock is `2026-10-29T12:00:00.000Z`. Present-time claims use the Source's stated period and the 12-month rule, never the file timestamps. Duplicate names and old-only present-time cases have Unsupported golds. An outside-scope newer notice stays unavailable to the model.

Each case retains its complete original assertion. The 28 required facet targets are literal UTF-16 ranges for the case's source, speaker or time focus; they are judged in that assertion's context. Native figure anchors identify occurrences, not values or invented figure ids. Neither is a second overlapping sentence row. Secondary attributes are not assigned a verdict merely by copying the parent gold.

Golds, rationale, proof references, fixture ids and expected targets are scorer data. They must never be included in a model request. Only the assertion, language, ordinary check context and the chosen profile's in-scope Source material are inputs. Import Sources through the normal core; map fixture ids to the actual random Document ids rather than presenting fixture ids as evidence.

The intended measurement uses Claude Haiku 5.5 and Kimi before and after the change, preserving every miss and recording all requests and latency. The baseline must include the landed parts implementation. Plain facts retain three requests; facets add none, and any additional scoped search is counted. Scripted cases test missing/malformed facet results, persistence, Undo and request accounting; they do not measure model quality.

Real-model runs are pending credit. No paid runner is enabled by adding these fixtures. The engine, older-reader protection, date-boundary and UI integration remain in progress.

`scoring.ts` builds an allowlisted Check input with imported Document UUIDs, and retains every returned result or missing result in the frozen denominators. A native-verdict hit is reported separately from scope, expected-Source and physical-quote checks. Decisive newer/context coverage is a separate conservative diagnostic; finding a short literal quote does not prove a context reversal. None of these helpers replaces semantic review or enables a model runner. The scripted tests cover input leakage, false evidence, missing results and blanket rejection at zero cost.

## Zero-cost adapter

Run the existing evaluation host against the dry entry point:

```sh
npx vitest run --config eval/vitest.config.ts eval/attribution/run.attribution.eval.ts
```

This command uses a scripted model with no external requests. It imports all 48 exact Source texts, calls public `checkClaim` for all 40 assertions with their actual imported UUID scope, and injects the frozen Check clock. Automatic tagging is disabled before import. It sends no gold, rationale, proof references or expected facet/figure targets to the model. The deliberately uninformative mock response tests loading and retention; its scores are not model-quality results.

Reports go to a new `test-results/attribution-eval` directory. Each completed case and its request traces are appended to `outcomes.jsonl`; `report.json` retains all 40 rows, every miss and actual returned parts, plus the full measured source head, source-diff hash and fixture hash. The fixture SHA-256 is `a62d633b30fdd0413498378f83472b526db0bd6c2092a82f6953cf112c64e4ce`.

`INCARNAMIND_ATTRIBUTION_ARM=before` labels a dry baseline; `after` is the default. Use the identical frozen fixture and adapter at the landed baseline and candidate heads. The manifest identifies the actual source; a dirty dry run cannot be presented as a clean measured candidate. This adapter is standalone Core measurement, not a Note/Verify or UI pipeline. It reports every observed sort request without inventing an amortized Note/Verify sort count. Sampling seed, temperature and output limits are recorded as actually sent; absent values stay null.

The observer wraps both SDK entry points, including unmatched setup requests, strict contradiction confirmations, errors, unfinished streams and cancellations. It retains raw synthetic Tool inputs/results, text replies, latency, input/output and separate cache-read/cache-write usage. Missing or invalid counts stay unknown; missing cache details are never zero-filled. Error records keep only an allowlisted error class and numeric status, without headers, credentials, options or whole Error objects. Per-language summaries show all 20 cases, requests per check, strict requests, total/mean/p50/p95 latency and native false Supported/Contradicted counts. Exact target-row presence is diagnostic; a parent verdict never supplies a missing facet verdict. Native and strict physical-evidence scores remain separate.

Frozen modification timestamps are applied before import. Portable file creation time cannot be assigned through the ordinary importer: reports retain the declared creation timestamp, actual file timestamps and imported Document metadata with `createdAtApplied: false`. Source bytes are never modified to fake metadata.

Paid execution is disabled: every mode except `dry` refuses before opening a host, and no credential/config loader is called. A funded host still needs explicit opt-in, exact model/source/data pins, one cumulative approved budget across both heads, conservative reservation before every generate/stream call, actual cache-write settlement and unreleased maximum holds for unknown usage. It must stop the arm on auth, out-of-credit or budget errors, preserve unstarted rows, and never retry a case for quality or switch providers. The app's monthly meter alone does not supply this experiment-wide guarantee. No paid cost forecast is inferred from the mock's token counts; those requirements remain a funding gate.
