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
