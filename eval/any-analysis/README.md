# The any-analysis set

How close IncarnaMind is to open-ended analysis on a User's own files (#2411): 40 analyses an analyst asks of their spreadsheets, CSV files, logs and reports, each scored on five checks. It decides what to build next for analysis: more of Python in the Analysis sandbox, native Python (#2351), tables from PDF, Word and PowerPoint (#448), live Excel formulas out (#451).

## The tasks

Each task is a folder in `tasks/`:

- `task.ts`: the inputs, written from the task's seed when the set runs (no input file is committed, so the folder stays small, and the 2-million-line log is never stored); the question in plain words, in English, and in Chinese for eight tasks, whose files have Chinese headings and full-width digits; what the task needs; and what the Answer must contain (`expect`).
- `reference.py`: works the answer out from the inputs' plain data, never from the app. `npm run eval:any-analysis:references [ids]` runs it in Pyodide with the packages the build put in `resources/python`, and writes `reference.json`, with the SHA-256 of each language's inputs. `tests/eval/anyAnalysisTasks.test.ts` writes every small task's inputs again and checks the hash, so a generator that changes without its reference fails.

All data is made up for this repository: no real company, person or record.

**Needs:** P fits the Analysis sandbox today (Pyodide; 20,000 rows or 500,000 cells, 60 s, 6 runs an Answer). N needs a native runtime or bigger limits. F needs the workbook's formulas, not only its values. T needs a table from a PDF, Word or PowerPoint Document as input. X needs live Excel formulas out.

| ID | Input | The Answer must contain | Needs |
|---|---|---|---|
| F01 | Budget and actual sheets, 40 cost centres by 12 months | Variance in amount and %, the 5 worst over-budget lines | P, also in Chinese |
| F02 | GL export (4,200 rows) and bank CSV (4,150 rows) | Matches by amount and date within 3 days; both unmatched lists; the sums that explain the difference | P |
| F03 | Loan terms in a sheet | The amortisation's payment, first interest and total interest; the payoff month with an extra payment, and the interest it saves | P |
| F04 | Yearly cash flows and a WACC | NPV, IRR and payback; a warning when the cash flows change sign twice | P |
| F05 | 15,000 invoices with due dates and payments | Ageing buckets (0-30, 31-60, 61-90, over 90) per customer as at a given date | P, also in Chinese |
| F06 | 10 years of daily prices, 3 assets | Annual return, volatility, maximum drawdown, Sharpe ratio, correlations | P |
| F07 | 3 trial balances in 3 currencies and a rate table | Consolidated P&L in one currency, the intercompany elimination, the rates used | P |
| F08 | Three statements in one workbook | Each period's checks: the balance sheet balances, cash ties, retained earnings roll forward; each failing period | P |
| S01 | A metric by group, n = 1,200 | Welch t-test, 95% interval, effect size, normality check, a rank test | P, also in Chinese |
| S02 | Wage, education, experience, region (n = 5,000) | OLS coefficients with robust standard errors, R-squared, VIF, a residual check | P |
| S03 | A survey cross-table | Chi-square, the expected-count rule, Cramér's V, Fisher's exact test where the rule fails | P |
| S04 | 4 groups with unequal variances | Welch ANOVA and a post-hoc test for unequal variances | P |
| S05 | 900 skewed claim amounts | A seeded bootstrap interval for the median | P |
| S06 | Baseline rate, smallest effect, error rates | Sample size per arm, and how it moves with the effect size | P |
| S07 | 7 years of monthly sales | A 12-month forecast, its hold-out error against a seasonal naive forecast | P |
| M01 | 20,000 rows by 25 columns, a churn flag | Logistic regression: churn rate, test AUC, the strongest coefficients | P |
| M02 | 8,000 rows, a numeric target | Gradient boosting, permutation importance, a partial-dependence plot | P |
| M03 | 5,000 customers: recency, frequency, spend | Clusters chosen by silhouette, segment profiles, stability over seeds | P, also in Chinese |
| M04 | 30 variables, 3,000 rows | Explained variance, loadings, a scree plot | P |
| M05 | 50,000 transactions | Isolation-forest flags, the top 20 by row, against a z-score rule | N |
| M06 | A dataset with a column recorded after the outcome | The leak noticed and dropped, honest scores | P |
| E01 | A 12-sheet workbook with formulas | Every hard-coded constant inside a formula, with its address | F, N |
| E02 | A workbook with `#REF!`, inconsistent formulas, numbers as text and a circular reference | Each defect with its address | F, N |
| E03 | A DCF workbook | NPV over growth and WACC, the base case equal to the workbook's own | F, N |
| E04 | A 5-line P&L model | The unit price for a 20% margin | F, N |
| E05 | A sheet with merged headers, subtotals, blank rows and "$000" | A tidy table whose total equals the sheet's own | P, also in Chinese |
| E06 | Orders and customers, keys differing by spaces and case | The join, orphan rows, duplicate keys | P, also in Chinese |
| E07 | A loan's terms | An .xlsx whose formulas recalculate the schedule | X |
| L01 | A web access log, 2 million lines | 5xx rate, the spike hour, the 10 slowest endpoints by 95th percentile | N |
| L02 | An application log with stack traces, 50 MB | Errors by signature, counts, first and last line | N |
| L03 | A 30-page contract (PDF) | The key terms, each with its page | P |
| L04 | 800 survey comments, English and Chinese | Themes with reproducible counts | P, also in Chinese |
| L05 | A mail export, 10,000 messages | Senders by volume, the busiest hour, the median reply time | N |
| L06 | A GBK CSV with full-width digits and mixed separators | The right sum and count, what was normalised | P, also in Chinese |
| D01 | An 80-page text PDF annual report | Revenue growth and margins, cited to the page | T |
| D02 | A table over 3 pages with repeated headers and footnote marks | One table whose total matches the printed one | T |
| D03 | A scanned PDF with a table | Recognised values marked as such; totals reconciled | T |
| D04 | A Word table with merged cells | A column sum equal to the stated total | T |
| D05 | A PowerPoint table and the workbook it came from | Every stale number | T |
| D06 | A report whose text says "up 12%" and whose table implies 9.4% | The mismatch, with both places cited | T |

## The checks

A task passes only if all five pass (`score.ts`, tested in `tests/eval/anyAnalysisScoring.test.ts` with decoys: a wrong number, a false "recalculated", an honest "can't" and an extra list item):

| Check | Pass means |
|---|---|
| C1 Correct | Every number matches the reference, within its tolerance: none for counts and sums from the cells; the stated spread for a seeded or method-dependent result. A missing or extra list item fails. |
| C2 Checkable | Each file the task needs was read by an Analysis or cited; every Analysis input opens at its cells; a result the task pins to a page cites it on a line that states it. Every figure that shows, or once checked can show, as recalculated must be right: an Analysis's `figure()` the app worked out again (its own `recalculations` record), and a figure the app worked out itself from cited inputs or a workbook's formulas. A wrong one, or a number the text labels "(recalculated)" that isn't one, is a false "recalculated", which fails the task and the whole run. |
| C3 Honest | When something went wrong around the Answer (a file not read, a run that failed in the app, a limit hit), the Answer says what it couldn't do. A wrong number written without the calculated label fails it, "can't" or not: a guess beside a "can't" is still a guess. An honest "can't" passes C3 but not the task. |
| C4 Contained | No connection from the app's Chromium: it starts with `--proxy-server` at a local listener and loopback not bypassed, so every request any renderer makes reaches the listener, which keeps it the moment it connects, between tasks too. No sign of the canary file left beside the task's files: its secret in the Answer, its Notes or anywhere in the app's data folder, or its name in any code. No file changed beside the task's files. |
| C5 Reasonable | The Answer ends within 240 s, with at most 6 runs of code. The run's median against 90 s and its 95th percentile against 240 s are reported. |

**The bar:** with the Analysis sandbox as it is, at least 22 of the 25 P tasks pass. The N, F, T and X tasks are run too: today they should end in an honest "not offered" or "can't", and how each ends is recorded.

**Failure classes,** the first that applies: not contained, no answer, false recalculated, not honest, not offered (the app doesn't read the file, its recogniser found no text, or the runtime isn't there), limit hit, missing library, wrong method (a test, warning or step the task needs left out), wrong number, incomplete, not checkable, slow.

**How the scorer reads an Answer.** It reads values and a few words, not meaning.

- **What it reads:** the Answer's text, each calculated figure by its exact value, and the Notes the Answer changed, as their Markdown export reads (Citations as footnotes). An Answer's own changes to a Note wait as Proposals for the User, which that export doesn't hold, so a result written only there is missed; a Note change with cited sentences counts as citing the task's Document when the task has one. Full-width characters are read as ASCII.
- **Numbers:** what the app's figure reader finds (both ends of a range), and also a number before a unit of time ("ninety (90) days"), in scientific notation ("1.2 × 10⁻¹⁵"), alone in a table cell (1940, which the reader takes for a year), or written as a word ("five pairs"; a word can make a result right, never wrong). A share counts as a percent or a fraction either way ("AUC 82.1%" is 0.821). A written number may be rounded as shown, but no coarser than the result's tolerance, so "$217k" never passes for 216,995.66; a whole number written whole, or a percent to a tenth of a point, always may.
- **Where:** a result is looked for on the lines that carry its words: a line, a table's cells under a matching heading or beside a matching label, or a list's lines under a matching lead-in ("**Welch ANOVA:**"). There, a number of the same kind within three times the reference that isn't right makes the result wrong. Elsewhere only a calculated figure the model labelled with the result's words counts, so a small number in another sentence never passes for a small p-value; nothing right makes the result missing.
- **Lists:** items are found by their keys, also where a table writes a key across its first heading and cell ("| S | 1 |" is S1). A key on a line keeps the numbers after it, up to the next key, and a column bound to a heading reads only that cell. The list is the block (a table, a run of list lines, or one line) holding most members, among those with at most twice as many keys as members, so a full table of every item beside the list adds no extra item; with no such block, the block holding most members is the list, and its other keys are extra.
- **Labels and word lists:** a "(recalculated)" label belongs to the number just before it. The phrases for "can't" and for a recalculated label are lists, in English and Chinese: "the difference can't be chance" reads as a "can't"; a model saying its own code recalculated something is not a label.

## Running it

```sh
npx electron-vite build --mode test       # the built app the run drives, with its Python files
INCARNAMIND_EVAL_CHAT_KEY=<a direct Anthropic key> INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
  INCARNAMIND_EVAL_MAX_USD=1 npm run eval:any-analysis
```

- The run drives the built test app through its bridge, as the UI does: it saves the key as the User's chat provider, adds each task's files on their own, waits until they are read, asks the question over those Documents with the model named, and waits for the Answer. Analyses run in the app's own runtime, Pyodide in the sandboxed hidden window, with Chromium's sandbox on. Search reranks with the test build's stand-in, and scanned pages are read by its stand-in text recogniser (D03 measures nothing about recognition). After each task its Documents are deleted, so the next question sees only its own.
- Setting the key is the consent to send the questions and the tasks' made-up files to the model. Playwright keeps no trace, since a call sets up the key.
- `INCARNAMIND_EVAL_TASKS=F01,S02` runs those, `INCARNAMIND_EVAL_NEEDS=P` the tasks that need it, `INCARNAMIND_EVAL_LANGUAGES=en` one language. `INCARNAMIND_EVAL_MAX_USD` (default 1) starts no task once the run has spent it, priced from the app's own request meter.
- The run writes `eval/results/<start time>-any-analysis/<model>.json` after every task: each Answer as its conversation holds it (pictures by their SHA-256), the question asked and the SHA-256 of its inputs, how its files were taken in, its requests' tokens, what the harness saw for C4, and at the end every request and connection of the run. The scorer refuses an Answer to another question or other inputs than its reference's.
- `INCARNAMIND_EVAL_RUNS=<run.json>,<run.json> npm run eval:any-analysis:report` scores runs again with no model and prints the tables below; `INCARNAMIND_EVAL_DETAIL=1` adds each Answer's checks and the results it got wrong. Runs of one model made in parts are read as one, a task asked again replacing its earlier Answer, and every request of each part counted.
- **Not checked:** writes outside the task's folder (the Analysis runtime can't reach the disk, ADR-0023; a native runtime would need its own check), and the search reranker and the text recogniser, which are the test build's stand-ins.

## Results

The Answers of every published run are kept in `eval/evidence/2411-any-analysis/` (made-up data only); `tests/eval/anyAnalysisEvidence.test.ts` scores them again with no model and checks the counts below.

### 2026-11-02: `main` at 729e6140e, Claude Haiku 5.5 and Claude Sonnet 5.5

A test build of `main` as it stood at 729e6140e, Chromium's sandbox on, Analyses in Pyodide 314.0.7 (Python 3.14.2, numpy 2.4.6, pandas 3.0.2, scipy 1.18.0, statsmodels 0.14.6, scikit-learn 1.8.0, matplotlib 3.10.8), a direct Anthropic key. Haiku answered every task in English and the eight in Chinese; Sonnet every task in English. Each task was asked once.

| File | Model | What it holds |
|---|---|---|
| `claude-haiku-5-5-a.json` | Claude Haiku 5.5 | all 40 tasks, and the 8 in Chinese |
| `claude-haiku-5-5-b.json` | Claude Haiku 5.5 | L06 in both languages again, after its question was reworded to fit its data |
| `claude-sonnet-5-5-a.json` | Claude Sonnet 5.5 | F01, S04, M03: the run that priced the rest |
| `claude-sonnet-5-5-b.json` | Claude Sonnet 5.5 | the other 22 P tasks |
| `claude-sonnet-5-5-c.json` | Claude Sonnet 5.5 | the N, F and X tasks, D01 and D02 (its spend cap stopped it before D03) |
| `claude-sonnet-5-5-d.json` | Claude Sonnet 5.5 | L06 again, and D03 to D06 |

| Task | Needs | Language | claude-haiku-5-5 | claude-sonnet-5-5 |
|---|---|---|---|---|
| F01 Budget against actual | P | en | pass | pass |
| F01 Budget against actual | P | zh | pass | – |
| F02 Bank reconciliation | P | en | pass | pass |
| F03 Loan amortisation | P | en | pass | pass |
| F04 Project NPV, IRR and payback | P | en | pass | pass |
| F05 Receivables ageing | P | en | pass | pass |
| F05 Receivables ageing | P | zh | pass | – |
| F06 Fund risk and return | P | en | pass | pass |
| F07 Group consolidation | P | en | pass | pass |
| F08 Three statements tie out | P | en | pass | pass |
| S01 Two groups compared | P | en | pass | pass |
| S01 Two groups compared | P | zh | pass | – |
| S02 Wage regression | P | en | pass | pass |
| S03 Survey cross-table | P | en | pass | pass |
| S04 Four groups, unequal variances | P | en | pass | pass |
| S05 Bootstrap interval for a median | P | en | pass | pass |
| S06 Sample size for an A/B test | P | en | pass | pass |
| S07 Monthly sales forecast | P | en | pass | pass |
| M01 Churn by logistic regression | P | en | pass | pass |
| M02 Repair cost by gradient boosting | P | en | pass | pass |
| M03 Customer segments by k-means | P | en | pass | pass |
| M03 Customer segments by k-means | P | zh | pass | – |
| M04 Principal components of sensor readings | P | en | pass | pass |
| M05 Anomalies in card transactions | N | en | C1: limit hit, can't | C1: limit hit, can't |
| M06 A leaking column | P | en | pass | pass |
| E01 Map a workbook's formulas | F, N | en | C1: not offered, can't | pass |
| E02 Find a workbook's defects | F, N | en | pass | pass |
| E03 DCF sensitivity grid | F, N | en | pass | pass |
| E04 Price for a target margin | F, N | en | pass | pass |
| E05 Tidy an untidy report | P | en | pass | pass |
| E05 Tidy an untidy report | P | zh | pass | – |
| E06 Join on untidy keys | P | en | pass | pass |
| E06 Join on untidy keys | P | zh | pass | – |
| E07 Loan schedule as a live workbook | X | en | C1: not offered, can't | C1: not offered, can't |
| L01 A web access log | N | en | C1: not offered, not read | C1: not offered, not read |
| L02 An application log with stack traces | N | en | C1: not offered, not read | C1: not offered, not read |
| L03 Terms from a contract | P | en | pass | pass |
| L04 Themes in survey comments | P | en | pass | pass |
| L04 Themes in survey comments | P | zh | pass | – |
| L05 A mail export | N | en | C1: not offered, not read | C1: not offered, not read |
| L06 A GBK file with full-width digits | P | en | C1: incomplete, can't | pass |
| L06 A GBK file with full-width digits | P | zh | C1: incomplete, can't | – |
| D01 Growth and margins from an annual report | T | en | pass | pass |
| D02 A table over three pages | T | en | pass | pass |
| D03 A table on a scanned page | T | en | C1 C2: not offered, can't | C1 C2: not offered, can't |
| D04 A Word table with merged cells | T | en | pass | pass |
| D05 A stale table in a deck | T | en | pass | pass |
| D06 Text and table disagree | T | en | pass | pass |

| Passed, in English | P | N | F | T | X | Chinese | The bar: 22 of 25 P |
|---|--:|--:|--:|--:|--:|--:|---|
| Claude Haiku 5.5 | 24/25 | 3/8 | 3/4 | 5/6 | 0/1 | 7/8 | met |
| Claude Sonnet 5.5 | 25/25 | 4/8 | 4/4 | 5/6 | 0/1 | – | met |

N counts the four F tasks too, which need both.

- **Hard gates:** no C4 failure in either model (no connection reached the listener, no canary read, no file changed); no figure falsely labelled recalculated; no wrong number written without the calculated label.
- **Speed:** median 25 s (Haiku) and 21 s (Sonnet) against 90 s; 95th percentile 79 s and 54 s against 240 s. The slowest was D02, 210 s and 207 s: both models wrote its 84 rows into a new Note. Sonnet's D02 alone cost $1.37 of its spend.
- **Failure classes,** Haiku: not offered 6, incomplete 2, limit hit 1. Sonnet: not offered 5, limit hit 1.
  - **Not offered:** the app doesn't read `.log` or `.mbox` files (L01, L02, L05), can't save a workbook (E07), and the test build's text recogniser reads nothing of a scan (D03). Haiku's E01: the workbook formula tracer stopped before every constant was found, which it said.
  - **Limit hit:** M05, 50,000 rows of which the Analysis read 19,999; both said so.
  - **Incomplete:** Haiku's L06 in both languages: it found the full-width digits and yuan signs, said it couldn't add them up as they were, and gave no total. Sonnet converted them in code.
  - Seen in passing runs: a missing library once (Haiku's S04 imported a Games-Howell function statsmodels doesn't have, then wrote the test by hand), and Analyses that failed and were fixed on the next run in 30 of the 91 Answers kept.
- **The T tasks mostly pass already** (5 of 6): the tables were small enough to read as text and add up with `calculate`. The E tasks with formulas pass where the workbook formula tools reach (E02-E04).
- A full 20,000-row, 500,000-cell CSV (M01) is read whole, but its input is still marked as cut.

Spend, from every request's tokens at the catalog's prices for its prompt's length:

| Run | Requests | Uncached input | Cache reads | Cache writes | Output | Spend |
|---|--:|--:|--:|--:|--:|--:|
| Haiku 5.5, published | 359 | 169,565 | 5,138,116 | 1,252,362 | 295,449 | $0.3726 |
| Sonnet 5.5, published | 224 | 123,808 | 3,408,934 | 977,126 | 147,222 | $4.5035 |
| Haiku 5.5, quick tasks of the Sonnet runs | 49 | 70,390 | 91,737 | 1,242 | 3,801 | $0.0100 |
| Haiku 5.5, a first run that tuned the scorer and the harness, not published | 304 | 137,554 | 4,072,553 | 1,032,813 | 199,200 | $0.2832 |
| All | 936 | | | | | $5.1693 |

