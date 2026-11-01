# Calculations evaluation

Whether a model asked for a figure gives it as a calculated figure (ADR-0021), reads the right inputs, and keeps a number a Document states as stated, measured per model and language (#441). Its results decide which models are offered the `calculate` Tool: the `calculates` fact in `src/core/providers/catalog/overrides.ts`.

## The Documents

All made up for this repository, with no real company, report or person in them, and free to redistribute under the repository's licence. `documents.ts` writes them into a temporary folder for each run, so no binary file is committed:

- **Northwind Instruments Annual Report 2025.pdf**: an income statement "in millions of US dollars" whose 2024 column is restated, a note giving 2024 revenue as originally reported, a segment table, a five-year summary, and an organic growth rate the chair states (9.8%) that the tables can't give.
- **Northwind Investor Day 2026.pptx**: a table slide of bookings by region, and a column chart of quarterly revenue read from its cached values.
- **Kestrel Foods 2025 results.pdf**: amounts in US$ millions.
- **青岚食品2025年度业绩快报.pdf**: amounts in 万元, for comparisons across currencies.
- **Reference exchange rates 2025.pdf**: the 2025 average and year-end US dollar rates, the only rates in the set.
- **云帆电子2025年年度报告摘要.pdf**: a 利润表 under "单位：万元", quarterly revenue for 同比 and 环比, and a growth rate on a comparable basis stated in words (百分之十二点四).
- **华拓物流2026年第三季度经营简报.docx**: a table, and a figure with a Word footnote ("1.2亿元¹") whose note names a one-off part of it.
- **Regional sales 2025.xlsx**: 1,200 rows of monthly sales by region and product, with currency and percent formats, a blank cell and two text cells where units should be, and a second sheet of list prices to join.
- **Customer survey 2026.csv**: 600 responses, a few of them malformed.

## The Questions

`cases.ts`: 80 Questions, 40 in English and 40 in Chinese, some asked across languages. Each lists every result it asks for, with its value in base units, a tolerance, the inputs it is worked out from (Document, page or slide, the line holding the number and the number as written) and the wrong values known readings give:

- growth, margins and shares, a change in percentage points, a CAGR, a change in 万元, a sum over a table's rows, an amount asked for in another scale (亿元, billions);
- traps: a restated year read as originally reported, a stated rate that must be quoted rather than worked out again (organic growth, 可比口径), 环比 read as 同比 and the reverse, a footnoted figure with its one-off part;
- across currencies: with the rates Document in scope, converted at the rate asked for (average or year-end); without it, four Questions that must be refused, giving only the amounts the Documents state;
- 8 Analysis Questions over the workbook and the survey (totals by region, a join with the prices sheet, a survey share, a trend), for the Analysis issues (#447, #448). They are scored apart and kept out of the bars.

Expected values are worked out in `cases.ts` in plain arithmetic over the inputs, never by the app's formula engine.

## Scoring

`score.ts`, tested in `tests/eval/calculationScoring.test.ts`. Each requested result of a Question is scored on its own, in this order: a calculated figure of the right value, a number written of the right value, a calculated figure or a number of a trap's value, a calculated figure that reads one of its inputs but comes to another value, and otherwise left out (or refused, when the Answer says it can't). A figure's unit must fit: a change in percentage points written "1.0%" is not right.

Per model, Tool arm and language, apart:

- **Completeness**: results given, right or wrong, of those asked for. A result left out or refused lowers it even when every figure given is right.
- **Figure correctness**: right results among those given.
- **Input correctness**: calculated figures whose every input is the Document, page, line, year and scale the result is worked out from, and no number in whose formula stands for an input (an exchange rate the model knew); RRI's count of years is fine.
- **Right where inputs are right**: calculated figures of the right value among those with the right inputs.
- **Tool coverage**: derived results given as calculated figures, of the derived results given.
- **Stated kept**: stated results given as stated.
- **Refused rightly**: Questions that must be refused that were, giving no amount the Documents don't state.
- **False checked**: calculated figures whose value or inputs are wrong. Each is listed, and it must be zero.
- **Speed**: seconds per Answer and per request to the model.

Each Question is asked in a new conversation, with its scope when it has one. With `INCARNAMIND_EVAL_CALC_RUNS` above 1, every run's results are kept and reported, a failed one beside those that went right.

Unchecked-figure detection (precision and recall of the marks on numbers worked out without the Tool) is not measured: Answers don't mark them yet (#442).

## Bars

For each cloud model, in each language, on the calculation Questions with the Tools on: Tool coverage at least 90%; figure correctness at least 95% among figures whose inputs are right; input correctness at least 85%; figure correctness above the same Questions' with the Tools withheld; no false checked figure. Reported, never gating.

## Running it

`npm run eval -- eval/calculations` runs it alone; `npm run eval` runs it with the other sets.

- **No chat model:** a scripted model (`oracle.ts`) answers every Question as the set says, searching for each input's line and handing it to `calculate`, with a fake embedder and reranker: no key and no network. The run fails unless every result comes out right with its inputs right and every refusal holds, so it checks the set against the app's own reading of the Documents. Its numbers measure no model.
- **A chat model:** set `INCARNAMIND_EVAL_CHAT_KIND`, `_MODEL` and `_KEY` (see `eval/README.md`); setting them is the consent to send the Questions and Passages to it. Searches rerank with the built-in model, as in the app, with embeddings off. Each Question is asked with the `calculate` Tool offered and again with it withheld: the run sets the model's catalog fact for each arm, in its own process only.
- `INCARNAMIND_EVAL_CALC_ARMS=on` or `off` runs one arm; `INCARNAMIND_EVAL_CALC_CASES=en-01,zh-05` only those Questions; `INCARNAMIND_EVAL_CALC_RUNS=3` each Question three times.
- A real model skips the Analysis Questions, since no Analysis runtime runs outside the app; `INCARNAMIND_EVAL_CALC_ANALYSIS=on` asks them anyway.
- The report goes into `eval/results/<start time>-calculations/`: `report.md` with the table, the usage and spend the core's meter recorded, the bars and every Answer's results, and `report.json` with every Answer's text and figures.

## Results

### 2026-11-01: Claude Haiku 5.5 and DeepSeek Flash, the 72 calculation Questions

One run of each Question with the Tool offered (on) and withheld (off), direct to each provider, scored with the scoring as committed after the pre-review (the Haiku run was scored again from its kept Answers with `rescore.ts`). The Analysis Questions were not asked.

| Model | Tools | Language | Complete | Right | Inputs right | Tool coverage | Refused rightly | False checked | s / Answer |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|
| Claude Haiku 5.5 | on | en | 41/41 | 41/41 | 39/39 | 39/39 | 2/2 | 0 | 9.7 |
| Claude Haiku 5.5 | on | zh | 36/36 | 36/36 | 34/34 | 34/34 | 2/2 | 0 | 9.5 |
| Claude Haiku 5.5 | off | en | 40/41 | 40/40 | – | 0/38 | 2/2 | 0 | 6.5 |
| Claude Haiku 5.5 | off | zh | 36/36 | 36/36 | – | 0/34 | 2/2 | 0 | 6.3 |
| DeepSeek Flash | on | en | 41/41 | 41/41 | 39/39 | 39/39 | 2/2 | 0 | 9.7 |
| DeepSeek Flash | on | zh | 36/36 | 35/36 | 33/33 | 33/34 | 2/2 | 0 | 8.4 |
| DeepSeek Flash | off | en | 40/41 | 39/40 | – | 0/38 | 2/2 | 0 | 8.5 |
| DeepSeek Flash | off | zh | 36/36 | 36/36 | – | 0/34 | 2/2 | 0 | 7.1 |

- Both models meet every bar but one with the Tool on: coverage, right where inputs are right, input correctness and no false checked figure. Neither is clearly more often right with the Tool than without it on this set (Haiku 100% both ways; DeepSeek 100% against 97.5% in English, 97.2% against 100% in Chinese). Here the Tool buys checked inputs and arithmetic, not more right numbers; a harder set is needed to show the difference.
- DeepSeek's one wrong result with the Tool: asked for Yunfan's reported growth in Chinese (zh-01), it gave the comparable-basis 12.4% the chair states. Without the Tool, in English, it gave the same for en-23.
- Both often set the trap's value beside the right one, labelled (the restated and reported 2024 revenue, reported and comparable growth); the report lists these as hedges.
- Claude Sonnet 5.5, hard check, three Questions with the Tool (en-20, zh-20, en-31): all five results right, from the right inputs.
- Spend, from the core's meter: Haiku $0.35 for both arms, DeepSeek ¥1.27 (about $0.18), Sonnet $0.21.
