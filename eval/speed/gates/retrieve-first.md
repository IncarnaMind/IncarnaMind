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
