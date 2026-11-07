# The gate for retrieving first (#1633)

Written and committed on 2026-11-04, before any run it gates. A model is on the retrieve-first list (`src/core/providers/catalog/answerPaths.ts`) only while it holds every line below on every set, and leaves it when one fails.

## The runs

- **Arms:** `loop` (the Tool loop from its first call) against `retrieve-first` (the Question searched before the first call), paired as `eval/speed/README.md` › Paired runs says: each item on both arms in one run, the order turning item by item, one run at a time.
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5, each on both arms; each keeps its own way of citing as the write-then-cite list has it. The judge is Claude Sonnet 5.5, or Claude Opus 5.5 when Sonnet 5.5 is under test.
- **Languages:** English and Chinese in every set. The gate counts the items of both languages together, and each language is reported beside it.
- **Sets:**
  - `gating`: all 65 Questions.
  - `hard`: every hard-tier Question whose quotes the stored text holds (180 of 225 when last counted).
  - `everyday`: Claude Haiku 5.5, the whole set; Claude Sonnet 5.5, 10 of each kind (30), and the whole set before it is listed. Every everyday request is an assistant turn, which keeps the loop, so both arms should take the same path there: this set checks that they do.

## The margins

`INCARNAMIND_EVAL_SPEED_MARGIN=1`: on the items both arms finished, per model and set, the candidate may have up to one item in 30 fewer (rounded down) than the loop on each of these:

| Guard | gating (65) | hard (180) |
|---|---|---|
| Expected Passages cited | 2 fewer | 6 fewer |
| Judged right | 2 fewer | 6 fewer |
| Every Citation found | 2 fewer | 6 fewer |

A guard over fewer items counts its own items: 29 of them allow none. The rule is one item in 30 of the items both arms finished, rounded down; the counts in the table are for the sizes expected. The hard tier asked 224 Questions when it ran, so 7 were allowed there (this sentence was added on 2026-11-04, after the hard-tier run; it changes no result). The everyday requests have no expected Passages or judged grade, so the runner counts none of these three there (corrected on 2026-11-04, before any everyday run: this table first gave them everyday columns); they are held to the lines below.

And none new, on every set:

- no new false Supported (the run stops at the first);
- no new duplicate Answer;
- no new change claimed that no Tool made, and no new other everyday guard failed;
- no new Tool call left as text;
- no more items failing to run.

## Faster, or it isn't listed

The list is for speed, so a model that holds the quality margins is listed only where retrieving first is also sooner: the paired median difference of the time to the end below zero on `gating` and on `hard`. Everyday turns keep the loop, so no time is asked of them.

## Reported, not gated

Per model and set: model calls per Answer, the share that fell back to the loop (searched again, or more than one call of its own), the time to the first words and to the end on both arms, the counts above, the load during the run, and what the run cost.

## How the everyday lines were read (added on 2026-11-04, after the everyday run)

This reading was decided after the run, and it applies only to a set that the changed path never reaches. On Claude Haiku 5.5's everyday run (173 pairs), two "none new" lines failed as written:

- change claimed, none made: 4 → 7 (6 new, 3 gone);
- other everyday guard failed: 40 → 46 (11 new, 5 gone).

Every everyday request is an assistant turn. An assistant turn never searches first, and a unit test (`tests/core/retrieveFirst.test.ts`, "an assistant turn … word for word") shows that every request it sends the model is byte-identical with the list on and off. So on this set the gate is path identity, and that test decides it. The deltas are noise: items flipped both ways, and the sign tests (6 against 3, 11 against 5) are not significant. Part of the noise was a fault in the runner: both arms shared one core, so the second arm found the first arm's Note of the same title and wrote into it. Each arm now has a core of its own. A set the changed path does reach is never read this way: its lines hold as written above.

## The second search (added on 2026-11-07, before its first run)

Retrieving first now searches a second time where the first Passages miss what the Question names: a word of the Question that only one Document holds, in its Passages or its name, names that Document, and when none of the Documents the Question names holds a Passage of the first search, the Question is searched again in each of them (two at most), as the search Tool searches one Document (corrected on 2026-11-07, after the runs, changing no result: they rerank, as the search made first does, where the model's own searches with the Tool don't). The rule was chosen on the gating set, from the Passages its searches return and no model call: it reaches para-en-01's settings table, which the Question's own words missed. Nothing else changes: the note after the Passages, the way each model cites and the fallback to the loop are as before.

- **Claude Haiku 5.5 is listed again only if it holds every line above, as written, on `gating` and on the whole `hard` set**, paired against the loop, one run of each, `INCARNAMIND_EVAL_SPEED_MARGIN=1`, and is sooner on both.
- **And on `retrieve-first-held-out`** (`eval/speed/retrieveFirstHeldOut.ts`): 30 Questions over the gating set's library, 15 English and 15 Chinese, written and committed before any run of the second search, asking for facts no gating Question asks for, in the shapes the one-call Answers went partial on. It is read as `gating` is: the three guards with up to one item in 30 fewer (one here), and none new on the others. It is reported, not timed: a set this small gives no median worth listing by.
- **Order:** `retrieve-first-held-out`, then `gating`; the whole `hard` set only once both hold. One run decides each set: a set that fails is not run again to pass. If any fails, Haiku stays off and the numbers go on #1633.
- **Everyday:** assistant turns never search first, so the unit test that every request of an assistant turn is the same with the list on and off decides it, as above; it isn't run again.
- **Claude Sonnet 5.5** runs this same gate once the quote check's items it waits on are on main. Two are not yet: words that run on to the next page across a continued heading (#2504) and a bracketed gloss left out (#2568). Until then it isn't run.

## DeepSeek V4.1 Flash 1017 (added on 2026-11-07, before its first run)

Claude Haiku 5.5's three runs above finished on the direct Anthropic key before it ran out of credit; no Claude model can be paid for now. DeepSeek V4.1 Flash 1017 (`deepseek/deepseek-flash`, the API's name for it) is gated on retrieving first with the second search by the lines above, as written, but for these:

- **The judge is DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro`), on the DeepSeek key, because no Claude judge can be paid for. It isn't a model under test. It isn't the Claude Sonnet 5.5 that judged Haiku's runs either, so DeepSeek's numbers are read arm against arm only, never beside Haiku's.
- **Its way of citing:** DeepSeek isn't on the write-then-cite list, so it gives its records first on both arms.
- **Sets, in order:** `retrieve-first-held-out`, then `gating`, then the whole `hard` set only once both hold. One run each, `INCARNAMIND_EVAL_SPEED_MARGIN=1`, and sooner on `gating` and `hard`. The held-out set has been run once, by Haiku; nothing was changed on its account.
- **Spend:** the runs stop at $4 for all three sets together.
- It is listed for a Question's Answer only if every set holds.

## What the second search's runs didn't measure, and the rerun (added on 2026-11-07, after Haiku's and DeepSeek's runs, before the rerun)

- **Two guards weren't measured on the Question sets.** `gating`, `retrieve-first-held-out` and `hard` build their items with `questionItem`, which set false Supported to 0 and never counted a change claimed and not made. So on every run of those sets above, Haiku's and DeepSeek's, the "none new" lines for those two read 0 on both arms and couldn't fail. Duplicates, Tool calls left as text and items failing to run were measured, as were the three margins.
- **Which commits.** Haiku's and DeepSeek's runs were at f437ed038 and 61cd80c92. What ships adds eb788ae81 and 761cf921d: a name another Document shares isn't searched by, a failed first search is handed to the model as on main, a search's line names its Document, and a word counts as one Document's only among those with Passages to search. Each can only drop a second search, puts back main's handling or changes what the User sees.
- **The rerun decides Claude Haiku 5.5.** The same three sets, in the same order, are run again, paired against the loop at the head that ships, with false Supported and changes claimed and not made measured as #2706 measures them on the Question sets, at the head of it named here before the rerun. The judge and margins are as above: Claude Sonnet 5.5, one item in 30. The run uses a direct Anthropic key, and if that key runs out of credit, another account's key for the same model, with a line here saying which items each key ran. One run decides each set, and the runs above no longer decide. The rerun stops at a new false Supported, as the gate says. If any set fails, Haiku comes off the list.
- **The measure the rerun uses** (added on 2026-11-07, before the rerun): #2706's, approved at 88ecfede9, from its branch at 6fb7eda25, merged here in 614df9337. Each found Citation's sentence is judged against its quote, sentences grouped by where they are. A change claimed by an Answer asked in a Note, which is offered no Tool that changes one, counts as unmade. The rerun first runs on ANTHROPIC_API_KEY, and on ANTHROPIC_API_KEY_DF if that one runs out of credit. It stops at $5.
- **The rerun's result** (added on 2026-11-07, after the held-out set's rerun): it stopped at its second item, ho-en-02. Retrieving first gave 4 false Supported there and the loop 2, so retrieving first had a false Supported the loop didn't, and **the gate fails**. Claude Haiku 5.5 comes off the list again. Afterwards, `retrieve-first-held-out`, `gating` and `hard` are run whole with false Supported counted over each set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), on the same key and judge, so the numbers show where each arm's false Supported fall. They are reported only and decide nothing.
- **The counted runs, started again** (added on 2026-11-07): the first start was stopped after 22 items, before anything was read from it, so that each item could keep the sentences the judge flags as false Supported, with their quotes, to be read by hand on both arms. The runs are started again whole. The two arms are compared with each other, and the raw counts and the counts read by hand are both reported.

## The counted runs' result (added on 2026-11-07, after the runs): Claude Haiku 5.5 stays off

Claude Haiku 5.5, loop against retrieving first with the second search, paired, one whole run of each set at 141f90b70, judged by Claude Sonnet 5.5 on ANTHROPIC_API_KEY throughout, false Supported counted over each set. They decide nothing: the rerun above already failed. The one-minute load was 2.9 to 48.5, median 10.5, and the runs cost $3.61, $3.87 of the rerun's $5 with its first starts.

| | held-out (30) | gating (65) | hard tier (224) |
|---|---|---|---|
| First words, loop → retrieving first | 4.6 → 3.3 s (−1.3 s, sooner in 25) | 4.5 → 3.3 s (−1.1 s, sooner in 49) | 4.8 → 4.7 s (−0.3 s, sooner in 128) |
| Done | 5.7 → 4.6 s (−1.4 s, sooner in 22) | 5.9 → 4.7 s (−1.1 s, sooner in 45) | 6.7 → 6.7 s (−0.1 s, sooner in 116) |
| Model calls per Answer | 2.97 → 2.03 | 2.78 → 1.89 | 3.42 → 2.60 |
| Expected Passages cited | 28 → 30 (0 lost / 2 gained) | 61 → 63 (2 / 4) | 153 → 161 (12 / 20) |
| Judged right | 29 → 28 (2 / 1) | **62 → 57 (7 / 2; 2 allowed)** | 210 → 212 (8 / 10) |
| Every Citation found | 30 → 30 | 59 → 63 (0 / 4) | 213 → 210 (8 / 5) |
| False Supported sentences, as the judge flagged them | 36 → 27 | 80 → 73 | 349 → 357 |
| … of them read right by hand | **32 → 22** | **73 → 69** | **279 → 279** |
| Items with a false Supported, as flagged | 22 → 19 (3 new / 6 gone) | 50 → 45 (5 / 10) | 179 → 187 (31 / 23) |
| … with one read right by hand | 20 → 16 (3 / 7) | 47 → 43 (7 / 11) | 156 → 159 (37 / 34) |
| Duplicates, unmade changes, Tool text, failed to run | 0 → 0 | 0 → 0 | 0 → 0 |

Every flag was read by hand twice, each time from one list of both arms' flags, shuffled, with the arm hidden until all 922 were read. The first reading read 880 right: held-out 35 → 25, gating 79 → 72, hard tier 330 → 339. A sample of its verdicts showed it calling a table's figure unheld when the sentence named the figure's row or column, so the second reading, counted in the table, took a rule for that before it began: a flag is right when its sentence states a fact its quotes don't hold, even with what the Citation's page shows around the quote (the Document, its table, the row and column a figure sits under). It read 754 right, most often a second figure or claim beside the one the quote holds, or a claim that something isn't in the Documents, and 168 wrong, most often a table's figure in the quote with its row or column named, or the quote's own words put another way or in the other language. Read either way, retrieving first has no more false Supported than the loop on held-out and gating; on the hard tier it is level by the second reading and 9 sentences more by the first, with items changing both ways. So by hand false Supported doesn't separate the arms; judged right on gating does. The rerun's stop at ho-en-02 (4 flags against 2) was on the judge's count, before the flagged sentences were kept; here ho-en-02's flags read right are 1 on the loop and 2 retrieving first, the loop's and one of the other two giving the same figure its quote doesn't hold.

- **Where gating lost.** en-05, en-12, en-16, en-18, en-19 and zh-01 went from right to partly, and xl-07 to wrong; en-11 and en-17 went from partly to right. On five of the seven, retrieving first searched once, the Question as asked, where the loop searched twice; three of them (en-12, en-16, zh-01) are among the five that went partly on 2026-11-04. The second search fired on none of them: their own search reached the Document they ask about, but not every part of what they ask.
- **Where the second search fired**, found afterwards with a scripted model, making no model call: gating 7 of 65 (en-03, en-06, xl-04, xl-06, xl-10, para-en-01, para-zh-06), held-out 1 of 30 (ho-en-14) and the hard tier 16 of 224. On those 24 items, judged right went 24 → 23 (hard paraphrase-zh-08 to partly), expected Passages cited 18 → 19 of the 21 that need them (para-en-01 and cross-lingual-zh-06 gained, paraphrase-en-07 lost), and the flags read right by hand 36 → 26.
- Sonnet 5.5 and DeepSeek V4.1 Flash 1017 weren't run again.
