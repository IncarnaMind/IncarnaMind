# The search-first check's gate (#2532)

Written and committed on 2026-11-14, before any paid request of this gate. The bars below are fixed. The one number they leave open, the margin for right sentences, is fixed by Bar 2's rule from Phase A's runs and written here before Phase B starts. A bar changed after a paid request makes a new gate.

## What is gated

The check this pull request builds, on a model listed in `src/core/providers/catalog/checkPaths.ts` (`SEARCH_FIRST`), in the flows the gate measures: Check this Note and a write's checks. Verify, the background watch, Check against Documents and Check these sentences keep today's check on every model until they are measured. An Answer's checks judge its sentences against their Citations in batches and make no search, so the path doesn't reach them; their timing is gated as unchanged.

1. **The app searches first.** A check of an uncited sentence searches the sentence's own words before its first request and hands the model those Passages as the Run's first search: a Passage that states the sentence word for word first, then the search's order, four in all, with a note to search again if they don't decide it.
2. **One reply for every part.** A sentence whose parts are known (Check this Note names them first) is answered part by part in one request, from those Passages, each part in a Run's reply form, figures on its Figures line, the records of all parts in the same reply. A part's reply is read as its Run's would be after the same search: it settles the part unless a turn check would send the Run back (to search again, to give its own words, a calculation, its Duty and Condition, its Figures line or its figures' sources), it can't be read, or it leaves the part not checked. A part with figures settles only when each figure is Supported or Contradicted from a quote: nothing is worked out in one reply, so a figure the Run might calculate goes on to the Run. That part, and only it, goes on to its Run, which starts from the same Passages. Every guard today's verdict has (the quote found, the quote stating its line, figures, units and scales, names) reads the first reply as it reads a Run's.
3. **A Note's searches as one batch.** Each sentence's own search starts as soon as the claims sort names the sentence, before its check has one of the six places, so the reranker takes the Note's searches one after another from the start. A search where a Passage states the sentence word for word isn't reranked: that Passage comes first without it.

Six checks at once stays. A model that hasn't passed keeps today's check: GPT-6.1 Sol and every other model until its own phase below.

## Arms

Both arms run in the same process, on one core per language, each Note a Note of its own, paired and alternated in time: in each round the arms take turns going first, the order turning from round to round.

- **`main`:** the branch with the path off for the model under test: `main`'s check, with no hand-off, no first reply, no search ahead, every search reranked. The unit tests show the path off sends what it sent before (`tests/core/searchFirstChecks.test.ts`, the "not listed" cases, and the existing check tests unchanged).
- **`search-first`:** the three steps above.

## The held-out set (`eval/speed/searchFirstCases.ts`, `eval/speed/searchFirstWritten.ts`)

Check this Note on a Note of 39 sentences in each language, over invented bike-share Documents written for this gate and read by no prompt before: rider terms, the company's year in numbers, and the second writer's Documents (a lost-property notice, an e-bike guide, a long depot handbook of near rules, group-ride terms with a defined limit, a monthly-pass guide, two tables).

- **Right (18):** 4 word for word, 4 in other words, 3 with figures (one as written, one in other words, one worked out from two of the year's numbers), and 7 the second writer added: 2 paraphrases, 2 among near rules of a long handbook, 1 whose support is two lines on different pages, 1 in the other language from its Document, and 1 table cell.
- **Wrong twins (13):** may for must, a negation, another place, the parties the other way round, a dropped condition, another period, four other figures, another scale, another currency, and a worked-out figure that doesn't hold.
- **Absent (8):** on the same topics, not stated.

Who wrote it, and what they knew: the 64 sentences in `searchFirstCases.ts` were written by the builder of the path, who knew it. The 14 in `searchFirstWritten.ts` were written by a fresh Sonnet 5.5 writer told nothing of the check's code or of the path, asked for the kinds of right sentence a first search can miss. Fresh Sonnet 5.5 readers, shown the Documents and the sentences shuffled with no labels, agreed with every label of all 78.

**Where each right sentence's support ranks** (free, no model, the search and reranker the check uses, `INCARNAMIND_EVAL_SPEED_RANKS=only`): of the 36 right sentences, 34 have every line that states them in the first Passage of their own search, so the hand-off gives them their support. The 2 written across languages are not found by their own words at all: a first reply over them can't see their support, so they test the path's real risk, a right sentence settling Unsupported.

## Free checks before any paid request

1. **Guards on the new path** (`INCARNAMIND_EVAL_SPEED_DRY=yes`): a scripted model that calls every part and every figure Supported, from the line that shares most of its words, on the frozen set, through both arms. Bar: sentence by sentence, the new path keeps no Supported mark that `main`'s path takes away.
2. **What the set can see:** the ranks above, before the freeze.
3. **The record:** for every verdict, the Passage its mark cites and whether the first reply settled it or it went on to its Run; every wrong sentence read Supported is listed with its Document and quote; the share that went on is reported.
4. **States no Note may be left in,** after every run: a sentence with no mark, a Supported or Contradicted mark with no quote, a sentence marked twice, a mark or part still checking. Each cell is printed, 0 included; a missing cell is an error.
5. **The rote dry run** (`INCARNAMIND_EVAL_SPEED_DRY=1`) of every phase's flows, end to end, at no cost.

## Phases, keys and stops

Every phase runs under the key's lease and the void rule below. The stop is the core's own monthly cap, so the first request past it is refused, between requests and not only between rounds. Nothing goes past a stop; a higher stop needs the second reader's yes before the next round.

| Phase | Model, key | Flows, rounds | Margin for right sentences | Stop |
|---|---|---|---|--:|
| A | Claude Haiku 5.5, the Anthropic key | `main` against `main`: the held-out Note, 3 rounds, EN and ZH | (sets it) | US$1.50 |
| B | Claude Haiku 5.5, the Anthropic key | `main` against `search-first`: the held-out Note, the 10-sentence Note, a write, an Answer; 3 rounds, EN and ZH | A's | US$3.00 |
| C | DeepSeek V4.1 Flash, the DeepSeek key, off-peak only | as B | the larger of A's and 2 | US$1.50 |
| D | GPT-6.1 Sol, the OpenAI key, after B passes | the held-out Note, 2 rounds, EN and ZH | the larger of A's and 2 | set after its first round is priced |
| E | Claude Sonnet 5.5, the Anthropic key, after B passes | the held-out Note, 1 round, EN and ZH, a mirror read | A's | US$1.50 |

- **A priced pilot:** Phase A's first round is the pilot. Its spend a request and a sentence, and a fresh estimate of every phase, are written below before A's second round.
- **If `main` against `main` breaks Bar 1** in Phase A, the gate stops there and the numbers are reported before B.
- **The Claude family** gets the path when Haiku passes B and Sonnet's read in E shows no new Supported on a wrong twin or an absent sentence, with right sentences within the margin. Opus follows Sonnet with no paid run of its own. Nothing runs on Fable.
- **If the path fails a bar** on a model: no ship for that model, and the numbers go to the lead and then the second reader before any second wording or second run.

## The void rule and the probe

- **Void:** an arm-round is void when any of its requests was refused, failed or timed out (a retried request counts), or any sentence's mark says it couldn't be checked for a failure, a rate limit, a time limit, credit or a cap. A void arm-round voids its round for both arms. The report lists every void round; the bars read only the rounds that count. A void round may be run again once, within the stop.
- **Probe:** before each round, one request of one token to the same key and model reads the key's rate-limit headers. The round starts only when more than 90% of every stated limit (requests, input tokens, output tokens) is left; otherwise the run stops there. Only the numbers are logged.

## Bars (per model, both languages together unless said)

1. **No wrong sentence Supported more often:** on the held-out Note and the 10-sentence Note, no wrong twin or absent sentence is Supported in more rounds on `search-first` than on `main`, sentence by sentence, and their totals are no higher.
2. **Right sentences Supported no fewer, beyond the repeat's noise:** on the held-out Note, in each language, `search-first`'s right sentences Supported over its rounds is at least `main`'s minus the margin.
   - **The margin's rule, fixed now:** in each language, the larger of (a) the difference in right sentences Supported between Phase A's two `main` arms over their 3 rounds, and (b) two standard errors of a 3-round total, from the sample standard deviation of the 6 rounds' counts (2 × sd × √3); the larger over the two languages, rounded up, at least 1. For scale, the pressure test's same 7 right sentences gave 4, 6 and 5 across three runs.
   - **The margin:** _written here from Phase A's report, before Phase B._
3. **Not checked no higher:** on the held-out Note and the 10-sentence Note, `search-first`'s Not checked over the rounds no higher than `main`'s by more than one sentence in 24 per language.
4. **Faster where it should be, later nowhere:**
   - on the held-out Note and the 10-sentence Note, in each language, `search-first`'s median last mark and end are sooner than `main`'s, and its median first mark no later than `main`'s by more than `main`'s own spread on that flow and language (its slowest round minus its fastest);
   - on a write and an Answer, `search-first`'s median first mark, last mark and end no later than `main`'s by more than that same spread.
5. **Held-out data stays held out:** no prompt, instruction or rule of this pull request changes after Phase A's first paid request. A change made after it needs a new set and a new gate.

A model is listed in `SEARCH_FIRST` only when Bars 1 to 5 all hold on it. A bar that fails keeps today's check for that model, and the reason is written here.

## Reported, not gated

- **Clocks,** from the User's action, medians of the rounds: the first mark (the first sentence the page shows as checked, a verdict or Not checked), the first verdict, the last mark (the last sentence the page shows as checked) and done (when the check ends).
- Per flow, language and arm: requests a sentence and of which kind; uncached input a sentence (input tokens less those read from the cache); dollars a sentence and a request; the seconds some search was running (the union of its reranks, their wait included); the reranks repeated; the load.
- On the held-out Note: each sentence's Supported count on each arm; on `search-first` whether its first reply settled it, or which parts went on to their Run and why; the share settled in one reply, by kind; and the issue's aim beside it: first marks within 3 s and done within 10 s on Haiku for a Note of 30 sentences.
- The #1624 budget on the 10-sentence Note: first verdict under 5 s and done under 15 s.

## Results

_Phase by phase as each finishes: the priced pilot, then A, B and on._
