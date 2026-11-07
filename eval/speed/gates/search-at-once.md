# The gate for searching at once (#2706)

Written and committed on 2026-11-07, before any run it gates. A model is on the searches-at-once list (`src/core/providers/catalog/answerPaths.ts`) only while it holds every line below.

## What it changes

On a model the list names, in an ordinary Answer's or the assistant's searches only:

- the instructions ask for every search in one step, and for a Question about what a Document says to be answered from what its searches find, not read page after page;
- a search the model makes in one Document hands the one search's 12 Passages, from up to four places in it, instead of the Tool's 6 from two.

It was shaped on eval:speed's question flow, the two Questions the every-flow table timed ("What does the Vantrell report say about emissions?" and its Chinese twin). It was shaped by probes of DeepSeek V4.1 Flash 1017's requests, four runs a language a variant: main took 5 rounds of searches and reads before it wrote (median), the variant 2. Those two Questions decide nothing here.

## The runs

- **Arms:** `today` (main's path, the list empty) against `search-at-once`, paired as `eval/speed/README.md` › Paired runs says.
- **Model:** DeepSeek V4.1 Flash 1017 (`deepseek/deepseek-flash`) on DeepSeek's own API. It cites first on both arms.
- **Judge:** Claude Sonnet 5.5, on a direct Anthropic key. If one key runs out of credit, another account's key for the same model is used, with a line here saying which items each key ran. The judge also reads each found Citation's sentence against its quote for false Supported, and a change an Answer claims, as the Question sets measure them since #2706.
- **Sets, in order:**
  - `search-at-once-held-out`: 20 Questions (`eval/speed/searchAtOnceHeldOut.ts`), 10 English and 10 Chinese, six in the other language from their Document's, each asking what one Document says on a topic. They were written and committed before any run of the path, and their quotes were checked on the stored pages.
  - `gating`: the gating set's 65 Questions.
- English and Chinese are counted together; each language is reported beside them. One run of each set decides it, and a set that fails isn't run again to pass.

## The bar

On the items both arms finished, `INCARNAMIND_EVAL_SPEED_MARGIN=1`, with the same tolerance every speed gate here uses for run-to-run noise:

- expected Passages cited, judged right and every Citation found no lower, within one item in 30, rounded down (none on the held-out set, two on gating);
- no new false Supported (the run stops at the first), duplicate Answer, change claimed and not made, Tool call left as text, or item failing to run;
- first words and done sooner: the paired median differences below zero on both sets.

## Reported, not gated

Model calls, searches and Document reads per Answer, the times on both arms by language, the load during the runs, and the spend. The runs stop at $8, of the $12 this work has.

## Before the first whole run (added on 2026-11-07)

The first start of the held-out run was stopped after its first item, before anything was read from it. Each item now keeps the sentences the judge flags as false Supported, with their quotes, and every flag is read by hand on both arms. The arms are compared with each other, never against zero, and both the raw counts and the counts read by hand are reported. The held-out run is started again whole. Since the measure's judge may be strict (it flagged 3 of 7 sentences on cite-first Answers in its first runs), false Supported is counted over each set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`) and doesn't stop the run. The bar's false-Supported line is then read this way, decided now, before the first whole run: over each set, `search-at-once` may have no more false Supported than `today`, counting only the flags that read right by hand. The raw counts are reported beside them.

## Result (added on 2026-11-07, after the runs): fails, no model listed

DeepSeek V4.1 Flash 1017, `today` against `search-at-once`, paired, one run of each set, judged by Claude Sonnet 5.5 on a direct Anthropic key; the runs cost $1.27.

| | held-out (20) | gating (65) |
|---|---|---|
| First words, today → search at once | 9.8 → 7.9 s (−0.6 s, sooner in 11) | 5.6 → 5.4 s (−0.3 s, sooner in 35) |
| Done | 13.5 → 10.9 s (−0.8 s, sooner in 10) | 7.3 → 7.3 s (**+0.3 s**, sooner in 28): not sooner |
| Model calls per Answer | 4.10 → 3.40 | 3.54 → 3.31 |
| Expected Passages cited | 20 → 20 | 63 → 64 (1 / 2) |
| Judged right | 20 → 20 | 62 → 63 (2 / 3) |
| Every Citation found | 17 → 20 | **62 → 58 (6 / 2; 2 allowed): fails** |
| False Supported sentences, read by hand (flagged by the judge) | **26 → 30** (43 → 56) | **68 → 77** (85 → 96) |
| Items with a false Supported read by hand | 14 → 16 | 49 → 45 |
| Duplicates, unmade changes, tool text, failed to run | 0 → 0 | 0 → 0 |

Every flag was read by hand from one list of both arms' flags, shuffled, with the arm hidden until all 280 were read: 201 read right (the sentence states something its quotes don't, most often a second claim beside the one its quote holds) and 79 wrong (mostly a table cell whose figure is in the quote, or the quote's own words in other words). The 15-minute load was 7.4 to 17.2. `hard` and `everyday` weren't run, as the bar says once a set fails.

On the question flow it was shaped on, the path took 2 rounds of searches and reads instead of 5 and was 5.8 s sooner to done (median of 8 Answers each), but that doesn't carry to these sets: Questions in a Note already search in one or two rounds, and the larger searches gave the model more to cite past.
