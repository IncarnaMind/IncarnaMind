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

## The held-out set (`eval/speed/searchFirstCases.ts`, `searchFirstWritten.ts`, `searchFirstLowRank.ts`)

Check this Note on a Note of 49 sentences in English and 54 in Chinese, over invented bike-share Documents written for this gate and read by no prompt before: rider terms, the company's year in numbers, the first unaware writer's Documents (a lost-property notice, an e-bike guide, a long depot handbook of near rules, group-ride terms with a defined limit, a monthly-pass guide, two tables) and the second unaware writer's (an 8-page field-service schedule and its definitions annex, in each language).

- **Right (28 English, 33 Chinese):** 4 word for word, 4 in other words, 3 with figures (one as written, one in other words, one worked out from two of the year's numbers); 7 from the first unaware writer (2 paraphrases, 2 among near rules, 1 on two pages, 1 across languages, 1 table cell); and 10 English, 15 Chinese kept from the second unaware writer by where their support ranks (below).
- **Wrong twins (13):** may for must, a negation, another place, the parties the other way round, a dropped condition, another period, four other figures, another scale, another currency, and a worked-out figure that doesn't hold.
- **Absent (8):** on the same topics, not stated.

**Who wrote which, and what they knew** (the report gives each writer's sentences apart, `writer` on each item):

| Sentences | File | Writer | Knew the path |
|---|---|---|---|
| 64 (32 a language): every wrong twin and absent sentence, and 11 right a language | `searchFirstCases.ts` | the builder of the path | yes |
| 14 (7 a language), right | `searchFirstWritten.ts` | a fresh Sonnet 5.5 writer, told nothing of the check's code or the path, asked for right sentences of kinds a first search can miss | no |
| 25 kept of 66 written (10 English, 15 Chinese), right | `searchFirstLowRank.ts` | a second fresh Sonnet 5.5 writer, told nothing of the check's code, the path or the rank rule, asked for near rules in a long Document, paraphrases, facts on two pages and sentences across languages | no |

Another writer's batch, asked for the same kinds, was discarded and not used: its brief had said what the sentences were for, which no writer may be told.

Fresh Sonnet 5.5 readers, shown the Documents and the sentences shuffled with no labels, agreed with every label: 78 of the first two files, and every kept sentence of the third.

**How the low-rank sentences were kept.** Out of the writer's sight, the search-only run (`INCARNAMIND_EVAL_SPEED_RANKS=candidates`: no model, the check's own search and reranker over the gate's Libraries) ranked every one of the 66. A sentence was kept when no Passage states it word for word and a line that states it ranks fifth or lower or isn't found, or its lines sit in two different Passages; and cross-language ones to at least two a language. It selects on the search, never on a verdict. The near rules and paraphrases all ranked first or second, so none was kept: the reranker found them. Each kept sentence's rank is its `keptAt`:

| Sentence | Kind | Rank of each stating line in its own search |
|---|---|---|
| l-en-tp-01 | two-pages | 4, 1 |
| l-en-tp-02 | two-pages | 1, 4 |
| l-en-tp-03 | two-pages | 1, 4 |
| l-en-tp-04 | two-pages | 1, 4 |
| l-en-tp-05 | two-pages | 3, 1 |
| l-en-tp-06 | two-pages | 3, 1 |
| l-en-cl-01 | cross-language | not among the 8 found |
| l-en-cl-02 | cross-language | not among the 8 found |
| l-en-cl-03 | cross-language | not among the 8 found |
| l-en-cl-04 | cross-language | not among the 8 found |
| l-zh-tp-01 | two-pages | 6, 1 |
| l-zh-tp-02 | two-pages | 1, 4 |
| l-zh-tp-03 | two-pages | 1, 4 |
| l-zh-tp-04 | two-pages | 1, not among the 8 found |
| l-zh-tp-05 | two-pages | 3, 1 |
| l-zh-tp-06 | two-pages | 1, 3 |
| l-zh-cl-03 | cross-language | not among the 8 found |
| l-zh-tp-07 | two-pages | 5, 1 |
| l-zh-tp-08 | two-pages | 1, not among the 8 found |
| l-zh-tp-09 | two-pages | 1, 7 |
| l-zh-tp-10 | two-pages | 1, 4 |
| l-zh-tp-11 | two-pages | 1, 4 |
| l-zh-tp-12 | two-pages | 6, 1 |
| l-zh-cl-06 | cross-language | not among the 8 found |
| l-zh-cl-08 | cross-language | not among the 8 found |

**Where every right sentence's support ranks** (`INCARNAMIND_EVAL_SPEED_RANKS=only`, on the frozen set): 46 of the 61 right sentences have every line that states them in the four Passages handed over (first or second, for every near rule and paraphrase). The 15 that don't are the gate's real test: 6 across languages (2 from the first unaware writer, 4 English ones from the second), not found by their own words, 3 more Chinese ones across languages, and 6 Chinese ones on two pages with a line ranked fifth to seventh or not found. The other 12 kept sentences on two pages have their two lines in two of the four Passages handed over.

**The gating row:** the right sentences whose support ranks low or is split (the 25 kept, and the 2 across languages from the first unaware writer): 11 in English, 16 in Chinese. Bar 2 is read on this row; the other right sentences are reported beside it.

**The frozen set's hash** (SHA-256 of `searchFirstCases.ts`, `searchFirstWritten.ts` and `searchFirstLowRank.ts`, in that order, joined): `4e63133541564da360a4f7f7c00656427e17fc513b14283369734c4fe33593d0`

## Free checks before any paid request

1. **Guards on the new path** (`INCARNAMIND_EVAL_SPEED_DRY=yes`): a scripted model that calls every part and every figure Supported, from the line that shares most of its words, on the frozen set, through both arms. Bar: sentence by sentence, the new path keeps no Supported mark that `main`'s path takes away.
2. **What the set can see:** the ranks above, measured before the freeze and again on the frozen set.
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

- **Estimate before the pilot,** for the 49- and 54-sentence Note, scaled from earlier Haiku check costs, not yet priced: A about US$0.62–0.82 a round, so US$1.9–2.5 for 3 rounds, past its stop; B about US$0.75–1.00 a round, so US$2.2–3.0 for 3 rounds, at its stop.
- **A priced pilot:** Phase A's first round is the pilot. Its spend a request and a sentence, and a fresh estimate of every phase, are written below before A's second round. If the pilot shows rounds 2 and 3 would pass A's stop, the gate stops after the pilot until the second reader sets a higher one.
- **If `main` against `main` breaks Bar 1** in Phase A, the gate stops there and the numbers are reported before B.
- **The Claude family** gets the path when Haiku passes B and Sonnet's read in E shows no new Supported on a wrong twin or an absent sentence, with right sentences within the margin. Opus follows Sonnet with no paid run of its own. Nothing runs on Fable.
- **If the path fails a bar** on a model: no ship for that model, and the numbers go to the lead and then the second reader before any second wording or second run.

## The void rule and the probe

- **Void:** an arm-round is void when any of its requests was refused, failed or timed out (a retried request counts), or any sentence's mark says it couldn't be checked for a failure, a rate limit, a time limit, credit or a cap. A void arm-round voids its round for both arms. The report lists every void round; the bars read only the rounds that count. A void round may be run again once, within the stop.
- **Probe:** before each round, one request of one token to the same key and model reads the key's rate-limit headers. The round starts only when more than 90% of every stated limit (requests, input tokens, output tokens) is left. When less is left, the probe reads again every 30 seconds for up to two minutes, since the round before can spend much of a minute's allowance itself (the pilot, below); if it still isn't, the run stops there. Only the numbers are logged: each limit's share left and its size.

## Bars (per model, both languages together unless said)

1. **No wrong sentence Supported more often:** on the held-out Note and the 10-sentence Note, no wrong twin or absent sentence is Supported in more rounds on `search-first` than on `main`, sentence by sentence, and their totals are no higher.
2. **Right sentences keep their Supported, beyond the repeat's noise:** on the held-out Note's gating row (the right sentences whose support ranks low or is split, above), in each language, `search-first`'s Supported over its rounds is at least `main`'s minus the margin. The other right sentences are reported beside it, not gated.
   - **The margin's rule, fixed now:** on the gating row, in each language, the larger of (a) the difference in its Supported between Phase A's two `main` arms over their 3 rounds, and (b) two standard errors of a 3-round total, from the sample standard deviation of the 6 rounds' counts (2 × sd × √3); the larger over the two languages, rounded up, at least 1. For scale, the pressure test's same 7 right sentences gave 4, 6 and 5 across three runs.
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
- On the held-out Note: each writer's sentences apart; each sentence's Supported count on each arm; on `search-first` whether its first reply settled it, or which parts went on to their Run and why; the share settled in one reply, by kind; and the issue's aim beside it: first marks within 3 s and done within 10 s on Haiku for a Note of 30 sentences.
- The #1624 budget on the 10-sentence Note: first verdict under 5 s and done under 15 s.

## Results

**Free checks on the frozen set** (2026-11-14, no request left this computer):

- **1, guards** (`DRY=yes`, 2 rounds, both arms): wrong twins and absent sentences Supported, `main` against `search-first`: English 12 + 12 against 12 + 12, Chinese 12 + 14 against 12 + 14; no sentence Supported in more rounds on `search-first`, by any writer. The gating row 12 against 12 in English, 26 against 26 in Chinese. By writer, right sentences Supported on both arms alike: the builder's 14 and 16, the first unaware writer's 10 and 8, the second's 12 and 24 (English and Chinese). Holds.
- **2, ranks:** as above, 46 of the 61 right sentences handed over in full, 15 not.
- **4, states:** in all 8 arm-runs, 0 sentences with no mark, 0 marks with no quote, 0 marked twice, 0 still checking.

**Phase A's priced pilot** (round 1, `main` against `main`, Claude Haiku 5.5, the Anthropic key, 2026-11-14):

- **How it ran:** the English half first. Then the probe before the Chinese half read the key's input tokens at 34% left, two seconds after the English half's own requests, and the run stopped as the rule said then. The Chinese half ran four minutes later, when the probe read 100%. 4 arm-runs, 0 void, no request refused or failed; every state cell 0.
- **Spend:** US$0.498 for the round (English US$0.243, Chinese US$0.255). Each arm checked 103 sentences, and the round made 750 requests: US$0.00223–0.00258 a sentence and US$0.00061–0.00073 a request. Each arm-run sent 2.2–2.4 million input tokens (0.63–0.75 million not from the cache) and 41–50 thousand output tokens in about a minute.
- **Clocks on `main`:** first mark 5.5 and 6.6 s in English, 7.4 and 8.1 s in Chinese; done 57 and 63 s, 69 and 66 s.
- **Bar 1, `main` against `main`:** wrong twins and absent sentences Supported 0 + 0 on both arms, in both languages.
- **The gating row, one round:** Supported 7 and 4 of 11 in English, 8 and 8 of 16 in Chinese. The margin is written here after round 3.
- **Fresh estimate:**
  - **A**, rounds 2 and 3: US$0.93–1.04, against US$1.00 left under its stop, so likely to reach it in round 3. The gate stops here until the second reader sets A's stop. US$1.60 in all covers rounds 2 and 3; US$2.10 also covers the one re-run of a void round that the void rule allows.
  - **B**, 3 rounds of the four flows: US$2.3–2.8, under its US$3.00, with no room to run a void round again. This assumes `search-first` spends 0.6–0.9 of `main`'s on a Note.
  - **C**, DeepSeek V4.1 Flash, as B: these tokens at its prices cost about 2.3 times Haiku's, so US$5.3–6.4 at the day price and US$2.6–3.2 off-peak: past its US$1.50.
  - **D**, GPT-6.1 Sol, the held-out Note, 2 rounds: at US$2 a million input tokens and US$10 a million output, about 20 times Haiku's, so US$13–16, before any reasoning tokens.
  - **E**, Claude Sonnet 5.5, the held-out Note, 1 round: at the same prices as D, US$6.7–8.0: past its US$1.50.
  - C, D and E were sized for a smaller Note. On this one, each needs a higher stop or a smaller run.
- **Changed after the pilot, in the evaluation's code only:** the probe's wait above, and the report's "Guards, any sentence" line is printed only on the scripted run that calls everything Supported. On a real model, right sentences differ from round to round, so the line flagged four Chinese right sentences on `main` against `main`. No prompt, instruction or rule of the check changed.

_Phase by phase as each finishes: then A, B and on._
