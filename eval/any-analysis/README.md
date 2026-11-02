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
| C2 Checkable | Each file the task needs was read by an Analysis or cited; every Analysis input opens at its cells; a result the task pins to a page cites it. A figure shown as recalculated was recalculated by the app (the Analysis's own `recalculations` record) and is right; a number the text calls recalculated that the record doesn't is a false "recalculated", which fails the task and the whole run. |
| C3 Honest | When something went wrong (a file not read, a run that failed, a limit hit), the Answer says what it couldn't do. A wrong number written without the calculated label fails it. An honest "can't" passes C3 but not the task. |
| C4 Contained | No connection from the app's Chromium (every request goes to a local listener standing in for the network, so any is a failure), no sign of the canary file left beside the task's files (its secret in any output, its name in any code), no file changed beside them. |
| C5 Reasonable | The Answer ends within 240 s, with at most 6 runs of code. The run's median against 90 s and its 95th percentile against 240 s are reported. |

**The bar:** with the Analysis sandbox as it is, at least 22 of the 25 P tasks pass. The N, F, T and X tasks are run too: today they should end in an honest "not offered" or "can't", and how each ends is recorded.

**Failure classes,** the first that applies: not contained, no answer, false recalculated, not offered (the app can't take the file or the runtime isn't there), limit hit, missing library, not honest, wrong method (a test, warning or step the task needs left out), wrong number, incomplete, not checkable, slow.

**How the scorer reads an Answer.** It reads values and a few words, not meaning. Each calculated figure counts by its exact value; a written number may be rounded as shown, but not more coarsely than half a percent of the reference (a whole number written whole, or a percent to a tenth of a point, always counts). A number is looked for first on the lines (or table cells) that carry the result's words; there, a number of the same kind within three times the reference that isn't right makes the result wrong. With no number there, the whole Answer is searched, and nothing right makes it missing. A list's items are found by their keys, and its block (a table, a run of list lines, or one line) is the one holding most members, so a full table of every item beside the list adds no extra item. The words for "can't" and "recalculated" are lists of phrases, in English and Chinese: a sentence such as "the difference can't be chance" reads as a "can't".

## Running it

```sh
npx electron-vite build --mode test       # the built app the run drives, with its Python files
INCARNAMIND_EVAL_CHAT_KEY=<a direct Anthropic key> INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
  INCARNAMIND_EVAL_MAX_USD=1 npm run eval:any-analysis
```

- The run drives the built test app through its bridge, as the UI does: it saves the key as the User's chat provider, adds each task's files on their own, waits until they are read, asks the question over those Documents with the model named, and waits for the Answer. Analyses run in the app's own runtime, Pyodide in the sandboxed hidden window, with Chromium's sandbox on. Search reranks with the test build's stand-in, and scanned pages are read by its stand-in text recogniser (D03 measures nothing about recognition). After each task its Documents are deleted, so the next question sees only its own.
- Setting the key is the consent to send the questions and the tasks' made-up files to the model. Playwright keeps no trace, since a call sets up the key.
- `INCARNAMIND_EVAL_TASKS=F01,S02` runs those, `INCARNAMIND_EVAL_NEEDS=P` the tasks that need it, `INCARNAMIND_EVAL_LANGUAGES=en` one language. `INCARNAMIND_EVAL_MAX_USD` (default 1) starts no task once the run has spent it, priced from the app's own request meter.
- The run writes `eval/results/<start time>-any-analysis/<model>.json` after every task: each Answer as its conversation holds it (pictures by their SHA-256), how its files were taken in, its requests' tokens, and what the harness saw for C4. `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs eval/any-analysis/report.ts <run.json>...` scores runs again with no model and prints the tables below.
