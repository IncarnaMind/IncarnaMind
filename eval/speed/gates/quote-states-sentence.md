# A Citation's quote states its sentence (#2739)

Written and committed on 2026-11-08, before any run it gates. Citing first, the default path on every model since #2727, about a quarter to a third of the found Citations in Claude Haiku 5.5's Answers show a quote that doesn't state their sentence: 45 of 177 and 54 of 176 over #2727's two whole runs of the gating set, read by hand. Of those, 10 and 11 quote another claim. The change shows a found quote as the whole sentence of its Units that holds it (`src/core/answers/wholeSentences.ts`), and `cite` tells the model once when two of its records give one quote. It also has the assistant's sentence check (#2311) leave a sentence its quoted words don't state without a green check, which a Question asked in a Note doesn't run, so these runs don't measure it.

## The runs

- **Arms, paired** as `eval/speed/README.md` › Paired runs says, each arm first in half the pairs of each cell: `quotes-as-given`, main's way (the core's evaluation switch `quotesAsGiven`: found quotes shown as the model gave them, and nothing said of two records with one quote), against `today`, this branch's. Both cite first: no model is on either list beside the catalog.
- **Set:** `gating`, the 65 Questions. #2727's two whole runs of it on main, and the quotes flagged in them, were read to find the cause, and the widening rule was tried on those flagged quotes before this file. These runs are new runs; the fixtures in `tests/core/quoteStatesSentence.test.ts` use made-up Documents.
- **Models:** Claude Haiku 5.5, then Claude Sonnet 5.5, each on a direct Anthropic key. **Judge:** Claude Sonnet 5.5 for Haiku's runs, Claude Opus 5.5 for Sonnet's, never a model under test.
- **Two whole runs a model** (`INCARNAMIND_EVAL_SPEED_RUNS=2`), false Supported counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), `INCARNAMIND_EVAL_SPEED_MARGIN=1`. Each run starts only at a 15-minute load of 24 or less.
- **Reading by hand:** every flagged sentence of both arms, against its quotes, as #2727 read them. A flag is right when the sentence states something its quotes don't; a right flag is also marked when its quote is about another claim than its sentence's.

*Added on 2026-11-08, before the runs below: the first Claude Haiku 5.5 run was stopped at its sixth Question, en-05, where the first arm's Answer failed on the organisation's rate limit for that key. It spent under $0.10 and is not counted. Both models' runs start again, whole, on the second direct Anthropic key, one route for every run.*

*Added on 2026-11-08, after Claude Haiku 5.5's two whole runs at 4961c9ce8 and before any run of the change this line describes. Lines 1 and 3 held: flags read right, main 28.3% and 30.0% of found Citations, the branch 17.5% and 13.1%. Line 2 failed in the first run: 11 of 171 found Citations quoted another claim (6.4%), and 10 of 183 (5.5%) in the second, against main's 7.2% in both. Most of them were two records given one quote, which `cite` only advised against. It now asks the model to fix that, once for each quote, and the Answer never owes it at its end. The gating set has now been seen. Claude Haiku 5.5's two whole runs are repeated on the changed code with the same bar, and Claude Sonnet 5.5's runs follow on it. A Sonnet run started before this was stopped after four Questions ($0.21) and is not counted.*

*Added on 2026-11-08, after Claude Haiku 5.5's reruns at dda42cdf5 and before Claude Sonnet 5.5's runs. Asked as a fix, the note failed line 3: judged right fell from 128 to 118 over the two runs (4 fewer allowed), and quotes about another claim stayed. The note goes back to advice, the behaviour of Haiku's first two runs at 4961c9ce8, and those runs stand as the Haiku result: lines 1 and 3 hold, and line 2 fails in one run (6.4% against main's 7.2%). Claude Sonnet 5.5's two whole runs follow on this code, with the same bar.*

## The bar, per model, over the items both arms finished

1. **Quotes that don't state their sentence** (flags read right, over found Citations): on Claude Haiku 5.5, both of the branch's runs below 20%, clearly under main's 25–31%. On both models, the branch's two runs sit below main's two, and the mean gap is more than either arm's own difference between its runs.
2. **Quotes about another claim:** below 6% of found Citations in each of the branch's runs.
3. **No worse than main:** expected Passages cited, judged right and every Citation found, each with up to one item in 30 fewer, by the runner's guards; and items with a false Supported, as the judge counts them, no more than main's over the two runs.
4. **Reported, with no bar:** the time to the end (done) and to the first words, as the paired median difference; model calls; how often `cite` told the model two records shared a quote.

If line 1 or 2 fails, the change doesn't ship as it is, and the numbers go on #2739. If line 3 fails, the guard that failed is named on #2739 with its items, and the change is fixed before a new gate.

## Spend

At most $10 for every run of this gate and its live check, held by `INCARNAMIND_EVAL_SPEED_STOP_USD=10` and one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`). Claude Haiku 5.5's runs go first. Claude Sonnet 5.5's second run starts only when the ledger leaves at least what its first cost; if it doesn't, it isn't run, and the pull request says so and gives Sonnet's one run.
