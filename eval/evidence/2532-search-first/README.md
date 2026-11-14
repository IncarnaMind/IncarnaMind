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
| A | Claude Haiku 5.5, the Anthropic key | `main` against `main`: the held-out Note, EN and ZH; the pilot, round 2, and round 3 only if round 2 counted and what is left covers round 2's own cost plus 5% | (sets it) | US$1.50 |
| B | Claude Haiku 5.5, the Anthropic key | `main` against `search-first`, EN and ZH, in this order: a full round (the held-out Note, the 10-sentence Note, a write, an Answer), a reduced round (the reduced set, below), a full round, then up to three more reduced rounds, then the list's readings (Bar 1). At least two full and two reduced rounds, or B stops and comes back. No room to run a void round again: after a void round, B stops and reports | the thresholds below, for B's rounds | US$3.00 |
| C | DeepSeek V4.1 Flash, the DeepSeek key, off-peak hours only, priced at the hour it runs | the reduced set, both arms, 3 rounds, EN and ZH, then the list's readings | Haiku's thresholds for 3 rounds, never under 2 | US$1.50 |
| D | GPT-6.1 Sol, the OpenAI key, after B passes | a priced pilot: six English sentences of the reduced set, two of each kind, both arms, ruling on no bar. The round (the reduced set, 1 round, both arms, EN and ZH) waits for the owner | Haiku's thresholds for its rounds, never under 2 | the pilot US$1.00; the round not set |
| E | Claude Sonnet 5.5, the Anthropic key, after B passes | the reduced set's wrong twins and absent sentences, `search-first`'s arm only, 1 round, EN and ZH, then ten readings on each path of each it Supports | (no right sentences) | US$1.50 |

**After the pilot** (the second reader's ruling on #2532, 2026-11-14), every phase fits inside its stop as written:

- **Stops:** a written stop is raised only by the owner, a re-run included. Waiting for the owner's yes, asked as one question, and not run before it: B's one re-run of a void round and any extra rounds on the gating row (US$3.00 asked to US$4.00); D's round (about US$4 asked to US$8.00); E, if `search-first`'s arm prices above its stop (US$1.50 asked to US$2.00).
- **A:** a void round's re-run comes out of the same stop and takes round 3's place. Fewer rounds never loosen a bar: the margin is the larger of `main`'s own spread and two standard errors, and round 1's two standard errors already set it in both languages.
- **The reduced set** (C, D, E): the gating row, the wrong twins and the absent sentences, 32 sentences in English and 37 in Chinese. On it, "right sentences" means the gating row, and Not checked may be no more than `main`'s plus 1 a language. The 10-sentence Note, the write and the Answer aren't read on DeepSeek or Sol; B reads them on Haiku, and each report says so.
- **D's pilot** measures Sol's real cache share and reasoning tokens, and prices the round.
- **E** reads what the plan gives it, the wrong twins and absent sentences, on `search-first`'s arm. None Supported: E holds, and `main`'s arm isn't needed. Each one it Supports is read ten more times on each path, alternated, and E fails if `search-first`'s count over those readings is more than `main`'s plus 3 (this replaced "three times on `main`" after Phase A). If B's measured cost of `search-first`'s arm prices E above US$1.50, E waits.
- **B's rounds** (the second reader's ruling after Phase A): a round starts only if what is left covers it at B's own measured price, with the list's readings (about US$0.05 a sentence) kept back first. The 10-sentence Note, the write and the Answer are read in the two full rounds; the gating row and the wrong sentences in every round, four to six times in all.
- **C and D** read wrong sentences by Bar 1's steps and use Haiku's thresholds for their own number of rounds, never under 2; their reports say the thresholds come from Haiku's own spread.
- **A split run** (a language at a time, as round 1 was) reports each part's own record.

- **Estimate before the pilot,** for the 49- and 54-sentence Note, scaled from earlier Haiku check costs, not yet priced: A about US$0.62–0.82 a round, so US$1.9–2.5 for 3 rounds, past its stop; B about US$0.75–1.00 a round, so US$2.2–3.0 for 3 rounds, at its stop.
- **A priced pilot:** Phase A's first round is the pilot. Its spend a request and a sentence, and a fresh estimate of every phase, are written below before A's second round. If the pilot shows rounds 2 and 3 would pass A's stop, the gate stops after the pilot for the second reader's ruling (below).
- **If `main` against `main` breaks Bar 1** in Phase A, the gate stops there and the numbers are reported before B. It did (below), and the second reader replaced Bar 1 and fixed one rule for its bar and the gating row's.
- **The Claude family** gets the path when Haiku passes B and Sonnet's read in E shows no new Supported on a wrong twin or an absent sentence, with right sentences within the margin. Opus follows Sonnet with no paid run of its own. Nothing runs on Fable.
- **If the path fails a bar** on a model: no ship for that model, and the numbers go to the lead and then the second reader before any second wording or second run.

## The void rule and the probe

- **Void:** an arm-round is void when any of its requests was refused, failed or timed out (a retried request counts), or any sentence's mark says it couldn't be checked for a failure, a rate limit, a time limit, credit or a cap. A void arm-round voids its round for both arms. The report lists every void round; the bars read only the rounds that count. A void round may be run again once, within the stop.
- **Probe:** before each round, one request of one token to the same key and model reads the key's rate-limit headers. The round starts only when more than 90% of every stated limit (requests, input tokens, output tokens) is left. When less is left, the probe reads again every 30 seconds for up to two minutes, since the round before can spend much of a minute's allowance itself (the pilot, below); if it still isn't, the run stops there. Only the numbers are logged: each limit's share left and its size.

## Bars (per model, both languages together unless said)

1. **Wrong and absent sentences, counted with a list** (replacing, after Phase A, "no wrong sentence Supported in more rounds on `search-first`, sentence by sentence", which fails an unchanged path about 4 times in 10):
   1. Over all of B's rounds, both languages together, count on each path the readings of a wrong twin or an absent sentence of the held-out Note that end Supported. The 10-sentence Note's sentences its Documents don't state are reported beside it.
   2. Then every such sentence that **either** path Supported at least once, in A or in B, is read ten more times on each path, alternated, within the hour, in a Note that holds only those sentences. Either path's Supported puts a sentence on the list, so the list can't favour an arm.
   3. Over 1 and 2 together, `search-first`'s count is no more than `main`'s plus K (below).
   4. The report lists each such reading by the kind of sentence, the path and the round.
2. **Right sentences keep their Supported, beyond the repeat's noise:** on the held-out Note's gating row (the right sentences whose support ranks low or is split, above), each language by itself, both rules hold. The other right sentences are reported beside it, not gated.
   - **Rule 1, the count:** the row's Supported is counted over all of B's rounds together, full and reduced, and `search-first`'s is at least `main`'s minus the language's margin (below).
   - **Rule 2, sentence by sentence:** a sentence Supported on `main` in every round and on `search-first` in none is lost. More than one lost in a language fails the row. The reverse, Supported on `search-first` in every round and on `main` in none, is reported beside it.
   - **Replaced after Phase A by the one rule below,** and kept here as the record. The margin's rule: on the gating row, in each language, the larger of (a) the difference in its Supported between Phase A's two `main` arms over their counted rounds, and (b) two standard errors of a 3-round total, from the sample standard deviation of their rounds' counts (2 × sd × √3); the larger over the two languages, rounded up, at least 1. For scale, the pressure test's same 7 right sentences gave 4, 6 and 5 across three runs.
   - **Rule 3, free, before B's first request** (answered under Results): from A's own records, how often `main` beside `main` fails rules 1 and 2 (the false-fail rate), and how often the rules catch a path that loses a third of the row (the power). Both are written here and sent before B. If three rounds catch too little, extra rounds on the gating row alone are priced; they are above B's stop, so they wait for the owner.
   - **The margin by that rule: 5,** from Phase A's three rounds: English, a difference of 4 between the two `main` arms (19 and 15) and two standard errors of 4.20; Chinese, 0 (27 and 27) and 4.38. Read as the ruling's two binomial standard errors of one round's count, it would be 4 (3.32 and 3.97, against the differences 4 and 0).
   - **One rule for K and the margins** (the second reader's, after Phase A; simulated from A's records of `main` beside `main`):
     - **The plain threshold** is the smallest that `main` beside `main` passes 19 times in 20; **the strict threshold,** 99 times in 100.
     - A bar past its strict threshold fails. Two bars past their plain thresholds fail. One bar alone between the two isn't settled: it is measured once more on three fresh reduced rounds and read over all its rounds, and if it isn't measured again it counts as failed. That money is above B's stop.
     - The bars this rule reads: Bar 1's count, and the gating row's count in English and in Chinese. Rule 2 above, more than one lost in a language, fails by itself.
     - **The thresholds,** in sentence-readings over the rounds (K: `search-first`'s Supported wrong readings less `main`'s; a margin: `main`'s Supported gating-row readings less `search-first`'s), plain / strict:

       | Rounds of each arm | K | English margin (11 sentences) | Chinese margin (16 sentences) |
       |--:|--:|--:|--:|
       | 4 | 3 / 5 | 5 / 8 | 7 / 10 |
       | 5 | 3 / 6 | 6 / 9 | 8 / 11 |
       | 6 | 4 / 6 | 7 / 9 | 9 / 12 |
       | 3 (C) | 3 / 5 | 5 / 7 | 6 / 9 |
       | 2 | 3 / 4 | 4 / 5 | 5 / 7 |
       | 1 (D's round) | 3 / 4 | 3 / 4 | 3 / 5 |

     - **How they were simulated** (`main` beside `main`, 20,000 runs for each number of rounds): each gating sentence's chance of Supported is drawn from its Jeffreys posterior over A's 6 arm-rounds, or taken as its share in A; each wrong sentence's chance is drawn from a posterior pulled toward the pooled rate (1 of 252 in A) by a prior worth 1, 2 or 10 readings, or taken as its share. The list holds the wrong sentence A Supported and every one the simulated rounds Supported, read ten more times on each arm. Each threshold is the largest over those models. K comes almost wholly from the list's readings of the one wrong sentence A Supported.
     - **What the rule does,** with these thresholds: for 4, 5 and 6 rounds, `main` beside `main` passes 88%, 89% and 91% of the time, isn't settled 9%, 9% and 6%, and fails 2.4%, 1.8% and 2.4%. A path that never Supports a third of the gating row passes 2.0%, 1.4% and 0.7%, and fails 94%, 96% and 98%. A path that Supports wrong sentences five times as often as `main` passes 23%, 21% and 25%, isn't settled 12%, 17% and 11%, and fails 65%, 62% and 64%: today's rate is so low (1 in 252) that five times it is still rare. On C's 3 rounds, `main` beside `main` passes 90%, isn't settled 8% and fails 1.8%. Rule 2 alone (more than one lost) fails `main` beside `main` 82% of the time on 1 round and 9% on 2, against 0.5% on 3 and none on 4 to 6, so it decides nothing below 3 rounds.
3. **Not checked no higher:** on the held-out Note and the 10-sentence Note, `search-first`'s Not checked over the rounds no higher than `main`'s by more than one sentence in 24 per language; on the reduced set, no more than `main`'s plus 1 a language.
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
  - **A**, rounds 2 and 3: US$0.93–1.04, against US$1.00 left under its stop, so likely to reach it in round 3. The gate stopped here for the second reader, whose ruling (above, under Phases) raised no stop and fitted every phase inside its own.
  - **B**, 3 rounds of the four flows: US$2.3–2.8, under its US$3.00, with no room to run a void round again. This assumes `search-first` spends 0.6–0.9 of `main`'s on a Note.
  - **C**, DeepSeek V4.1 Flash, as B: these tokens at its prices cost about 2.3 times Haiku's, so US$5.3–6.4 at the day price and US$2.6–3.2 off-peak: past its US$1.50.
  - **D**, GPT-6.1 Sol, the held-out Note, 2 rounds: at US$2 a million input tokens and US$10 a million output, about 20 times Haiku's, so US$13–16, before any reasoning tokens.
  - **E**, Claude Sonnet 5.5, the held-out Note, 1 round: at the same prices as D, US$6.7–8.0: past its US$1.50.
  - C, D and E were sized for a smaller Note. On this one, each needs a higher stop or a smaller run.
- **Changed after the pilot, in the evaluation's code only:** the probe's wait above, and the report's "Guards, any sentence" line is printed only on the scripted run that calls everything Supported. On a real model, right sentences differ from round to round, so the line flagged four Chinese right sentences on `main` against `main`. No prompt, instruction or rule of the check changed.

**Phase A** (3 rounds, `main` against `main`, Claude Haiku 5.5, 2026-11-14):

- **Spend:** US$1.459 of its US$1.50: rounds 1, 2 and 3 cost US$0.498, US$0.480 and US$0.481. Round 3 ran because round 2 counted and the US$0.522 left covered round 2's cost plus 5%. 12 arm-runs, 0 void, no request refused or failed; every state cell 0. Round 1 ran a language at a time; rounds 2 and 3 ran whole, the probe waiting 30 and 60 seconds between languages.
- **The key's limits a minute,** as the probe now logs them: 500,000 input tokens, 580,000 tokens, 80,000 output tokens, 1,000 requests. One arm-run sends 0.63–0.75 million input tokens that aren't from the cache, in about a minute.
- **Bar 1 breaks on `main` against `main`.** In round 3, `main#2` marked a wrong twin Supported: `en-tyre-condition`, a sentence that drops a condition its source sentence carries, citing the source sentence. Wrong twins and absent sentences Supported: English 0 + 0 on `main`, 1 + 0 on `main#2`; Chinese 0 + 0 on both. One sentence is Supported in more rounds on one arm of today's check than on the other, and its total is higher, so the gate stops here, before B, as written above.
  - **Bar 1's own false-fail rate,** from A: today's check marked 1 of 252 wrong sentence-rounds Supported. Drawing that rate from its Jeffreys posterior, two arms of today's check over B's 3 rounds and the held-out Note's 42 wrong sentences break Bar 1 as written 45% of the time, and its totals alone 27%. The 10-sentence Note's wrong sentences add to that.
- **The gating row, rounds 1 to 3:** English `main` 7, 7, 5 and `main#2` 4, 6, 5 of 11; Chinese `main` 8, 8, 11 and `main#2` 8, 9, 10 of 16. The other right sentences: English 40 and 41, Chinese 41 and 45. Not checked: English 20 and 19 of 147 sentence-rounds, Chinese 16 and 12 of 162.
- **Clocks on `main`, medians:** first mark 5.1 and 6.8 s in English, 7.4 and 7.0 s in Chinese; done 57.0 and 58.4 s, 68.2 and 66.4 s.
- **Rule 3, from A's records** (each gating sentence's chance of Supported drawn from its Jeffreys posterior over A's 6 arm-rounds; B's two arms drawn for its rounds; 20,000 runs; plug-in chances give the same within a few points):

  | B's rounds, margin | `main` beside `main` fails rule 1 or 2 (English, Chinese, either) | Catches a third of the row's sentences never Supported | Catches every row sentence's chance cut by a third |
  |---|---|---|---|
  | 3, margin 5 (written) | 2.8%, 6.9%, 9.5% | 65%, 91%, 97% | 52%, 80%, 90% |
  | 3, margin 4 (the ruling's reading) | 5.7%, 11%, 16% | 74%, 94%, 99% | 65%, 86%, 95% |
  | 4, margin 6 | 2.3%, 6.5%, 8.6% | 70%, 94%, 98% | 62%, 87%, 95% |
  | 5, margin 6 | 3.7%, 8.6%, 12% | 80%, 97%, 99% | 76%, 94%, 99% |
  | 6, margin 7 | 2.9%, 7.0%, 9.7% | 83%, 98%, 100% | 81%, 96%, 99% |

  Rule 2 alone fails `main` beside `main` in under 0.5% of runs, and catches 41% (English) and 69% (Chinese) of a third lost on 3 rounds. For more rounds, the margin's two standard errors are taken over that many rounds (2 × sd × √rounds).
  - **Three rounds catch too little in English:** about half to two thirds. Six rounds reach about 81–83% in English and 96–98% in Chinese. The gating row alone costs US$0.025–0.048 a `main` arm-run, so about US$0.10–0.17 a round for both arms and both languages, if `search-first` costs 0.6–0.9 of `main`'s: three extra rounds, US$0.31–0.51. That is above B's stop, so it waits for the owner.

_Phase by phase as each finishes: then B and on._
