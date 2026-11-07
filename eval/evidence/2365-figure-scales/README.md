# Figure scale pairs, live

The reports behind #2365's real-model evidence, produced by
`tests/live/figureScalePairs.live.test.ts`.

## The harness

- Eight cases: a control, a wrong table, a future scale and a currency control, in English and in
  Chinese.
- Through Core and the app's provider path (`saveChatProvider` and the real chat model), so the
  model's own quotes, `unitQuote`s and `calculate` calls are what is scored.
- It grades the **first recorded calculated figure** of each Answer: its value against the case's
  expected value or refusal, and the scale each input was read at; the report line shows the value,
  the input scales and the false-checked flag. A refusal is acceptable where the rows don't settle
  the scale; a wrong scaled value is a failure.
- Scope: it pairs one English and one Chinese case per control kind rather than a larger matrix, and
  it doesn't grade a number the model writes without the calculate Tool.
- The Documents are made up for this file; no real company, report or person. No key or token is in
  these reports.

## Runs

| File | State | Cases | Spend |
|---|---|---|---|
| `pre-fragment-fix.txt` | before the whole-line caption fix | 8, one wrong (EN wrong table: 900,000) | $0.0230 |
| `pre-merge.txt` | after that fix, before main's merge | 8, all acceptable | $0.0126 |
| `pre-currency-guard.txt` | after main's merge, before the bare-number currency guard | 8, one wrong (EN currency: £900,000,000) | $0.0124 |
| `final-c381a8a37.txt` | the reviewed FIX head, all eight acceptable | 8 | $0.0129 |
| `final-bf6caf571.txt` | the Delta FIX head (before the part-prefix guard, which doesn't touch these cases), all eight acceptable | 8 | $0.0130 |
| `final-12fdac05b.txt` | the pushed head, all eight acceptable | 8 | $0.0127 |

Total for the six runs: **$0.0866**. Each report ends with its run's requests, input and output
tokens and spend; that last line is the ledger.
