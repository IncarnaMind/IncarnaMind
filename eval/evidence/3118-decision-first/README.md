# The gate of a decision model in front of the check (#3118)

Written and committed on 2026-11-15, before any paid request of this gate, and amended the same day, still before any paid request: B2's paired line, part A's table by label, what a zero means in numbers, and part M. The bars below are fixed. A bar changed after a paid request makes a new gate. Part T's numbers were measured free before then.

## What is gated

Check this Note with a decision model reading each sentence first (`src/core/answers/checks/decisionFirst.ts`), on the one model with measured lines: Decider v1.2 through OpenRouter (`src/core/answers/checks/decisionLines.ts`).

1. **The reading.** For each sentence that is one fact, the decision model is asked two questions of each Passage the check's search finds for the sentence or the sentence cites: does it state the sentence, and does it say the opposite.
2. **A Mark from the decision model** only where a score is clear of the model's line (stated 0.98, opposite 0.90, each by more than 0.005), the sentence has no figure, and the Passage holds a line near the sentence to quote. That sentence never reaches the AI model.
3. **A first reading** for any other score that leans (stated 0.80, opposite 0.50), and for every sentence with a figure: shown at once, and confirmed or changed by the AI model's check, which is asked nothing differently for it.
4. With no decision model chosen, nothing changes: the unit tests show the AI model's requests are the same with and without a reading (`tests/core/decisionFirst.test.ts`).

What the gate does not cover: any other decision model (none can be chosen until it is measured), and the screens.

## The build since 2026-11-15

The reading changed after this file was written. Points 1 to 3 above and the bars below describe the earlier build; **parts A and B have not been run on this one**, and the model still reads only where the User chose it.

1. **One search, one request.** The sentence's 30 best Passages by the plain search (no reranker, no neighbouring Passages), with any it cites first, go to the decision model in one request with the two questions of each.
2. **A Mark from the decision model** where a score is clear of the line, the Passage asked about alone scores clear again, and a number of the sentence the Passage writes another way is the same amount by the model's own answer (0.92). A sentence with a figure can get one. The quote is the sentence of that Passage the model scores highest on the verdict's question; a heading, a table's row and a sheet's row are quoted as one line.
3. **Unsupported from the decision model** where every Passage scores under 0.25 on both questions and the sentence cites nothing.
4. **No reading** where one Passage states the sentence and another says the opposite, both clear of their lines: the sentence goes to the AI model unread.
5. **A first reading** for any other score that leans, as before.

Two bars cannot be read on this build as they are written: **A2** (it marks sentences with a figure by design) and the first reading "for every sentence with a figure" of point 3 above.

**What a pressure test of this build gave**, in the app, on public test text only (`replay` and `real`, Decider v1.2, 2026-11-15). The 106 sentences are the half of the checks evaluation's set (`eval/checks`) the request's shape was worked out on, over that set's Folder (921 Passages, keyword search):

| | Count |
|---|---|
| A Passage the label rests on among the 30 read | 86 of 86 |
| Supported from the decision model | 47, all as labelled |
| Contradicted from the decision model | 24, all as labelled |
| Unsupported from the decision model | 21: 20 as labelled, 1 not (a figure its Document gives by a subtraction) |
| First readings | 14: 12 the label's way, 2 not (both calculations) |
| The 71 quotes that hold the label's own line | 68; the other 3 are another line of the same Document, 2 of them a PDF's line that cuts the sentence |
| Requests to the host | 269, all answered; 53 sentences in 6.5 s and in 5.4 s |

- **That run had no Unsupported line**: any sentence no Passage leaned to was Unsupported. On a Note of 33 sentences (`eval/repeats`) it also marked 2 sentences Unsupported that are labelled Contradicted ("must" for the Document's "may", and the reverse).
- **The 0.25 line was set on those results**, not on new text: those three wrong ones, and a fourth sentence an earlier measurement missed the same way, had a highest score of 0.38 to 0.70; of the 20 right ones on this half, 18 were at 0.113 or under, the others at 0.238 and 0.492. By those scores the line sends all four and one right one to the AI model. It has not been run again since.
- The same Notes over a Folder without their Documents (869 Passages): no Supported or Contradicted, 104 Unsupported, 2 sentences with no Passage found left to the AI model.
- A Note of 33 sentences with Claude Haiku 5.5 behind: the decision model's Marks landed at 4.4 to 5.8 s, the AI model's first at 8.7 s and its last at 35.3 s; 50 requests to the host, all answered. With a host too slow to answer in 5 s, no reading shows and the check ends 5 s later than with no decision model (free run, scripted AI model).
- The quotes were compared with the labels' lines by a script, not read blind.
- **The quote's unit was changed after that run**, from a Passage's lines to its sentences (commit c941ba5f3), and the 71 sentences with a Supported or Contradicted were run once more: all 71 got the same verdict, 215 requests, all answered, US$0.052 at the listed price. 70 quotes hold the label's line (68 before); both quotes that were a PDF's cut line are now the whole sentence, and the one left is a table's row, quoted whole, where the label also names the table's heading.

## What the gate decides

Whether the decision model reads **by default** for a User whose check's AI model already runs on its host's service (ADR-0022's amendment for #3118), or only where the User chose it. It is on by default only if all four hold:

| | "Better" means | Bar |
|---|---|---|
| 1 | No wrong Mark from the decision model on the held-out Notes | A1, with A2 and A3 |
| 2 | Marks as labelled no lower than `main`'s on a real AI model | B1 and B2 |
| 3 | The Marks no later than `main`'s, but for the first by under a second | T1 to T4, measured free |
| 4 | What one check costs the User in all no higher than `main`'s | B4 |

If any of them fails, the model reads only where the User chose it, as designed before. A time or a cost a little over, with the rest met, goes to the owner with the numbers.

## Part A: what the decision model marks, against labels

`INCARNAMIND_EVAL_SPEED_DECISION_FIRST=replay` (`eval/speed/decisionFirst.speed.ts`): each labelled Note is written into the app and checked with Check this Note, the real decision model in front, and a scripted AI model behind it that never decides, so every Mark with a verdict is the decision model's.

**The Notes.** Four held-out Notes, two in English and two in Chinese, 208 sentences in all (a pair of 120 and a pair of 88), over the gating set's Documents (`eval/retrieval`). Each sentence carries the Mark its Documents give it, checked by a second reader when the Notes were written. They are kept outside this repository; the builder of this pull request has not read them and the run prints counts only. They are not new to the decision model: its lines were set on the pair of 88, and it was scored on the pair of 120 afterwards, both with a script outside the app. So part A shows that the app's own search, figure rule and quote rule give no wrong Mark on them; it is not a second test of the lines. The 33 sentences of part B were never put to the decision model before. Two practice Notes of the same make, which the builder may read, are run first with the host on this computer to try the run.

**Bars, on each Note and on all four together:**

| Bar | Passes when |
|---|---|
| A1 Wrong Mark | **0** sentences get a Mark from the decision model that isn't their label: Supported on a sentence labelled Contradicted or Unsupported, or Contradicted on one labelled Supported or Unsupported |
| A2 Figures | **0** sentences with a figure get a Mark from the decision model. The run counts a figure its own way, apart from the app's rule: any sentence with a digit |
| A3 The quote | Every Mark's quote, read blind, states the sentence (Supported) or says the opposite (Contradicted) |
| A4 First readings | At least **80 in 100** first readings lean the way of the label, on the four Notes together |

- **A1 or A3 missed is no ship**, unless the owner decides otherwise with the wrong Marks in front of them.
- **A zero is not a rate.** About 15 to 20 Marks from the decision model are expected on the 208 sentences. With none of them wrong, the true share of wrong Marks can still be as high as 14 to 18 in 100, about one in six or seven, at the usual 95 in 100 confidence. The report gives the bound for the number of Marks the run gave, and says no more than that.
- **A3's reading.** Each Mark's sentence, quote and Document name go to two fresh Claude Sonnet 5.5 readers, who are told nothing of the decision model, the labels or what gave the Mark. They are shuffled with as many decoys, each a Mark's sentence beside another Mark's quote; a reader who accepts a decoy is replaced by a fresh one. A Mark fails when both readers reject its quote; where they disagree a third reader, as fresh, decides before anyone opens the labels.
- **A4** is a floor, not the claim. Reported beside it: how many sentences got a Mark, how many a first reading, how many nothing, and the wrong first readings by kind of sentence.
- **One more table, counts only, with no bar,** for all 208 sentences and for each pair apart (the pair of 88 is the one the lines were set on): by label (Supported, Contradicted, Unsupported) and by a figure or none, how many sentences got a Mark, a first reading that leans the label's way, one that leans the other way, and none. And for the sentences whose scores alone are sure but a rule held the Mark back: how many, and how many of them are their label, by the rule that held them (a figure; no line to quote). The scores are read through the relay and put to the app's own lines. This table says whether each rule earns its place.

## Part B: beside `main`, on a real AI model

`INCARNAMIND_EVAL_SPEED_DECISION_FIRST=real`, `INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`: Check this Note on a Note of 33 labelled sentences (`eval/repeats`' English sets) over their Documents and the mixed sample set, with Claude Haiku 5.5 as the AI model.

**Arms**, in one process over one Library, alternated in time: `main, decision, decision, main, main, decision`.

- **`main`:** no decision model chosen. The check as it is on `main`.
- **`decision`:** Decider v1.2 chosen.

**Bars:**

| Bar | Passes when |
|---|---|
| B1 Wrong Mark | **0** Marks from the decision model that aren't the sentence's label, in every `decision` run |
| B2 The AI model's Marks | Marks as labelled in the `decision` runs: their median is no lower than the lowest `main` run. And no sentence carries its label in all three `main` runs and misses it in all three `decision` runs |
| B3 First readings | The `decision` runs' first reading shows within 3 s of the User's action, by their median |
| B4 Cost | What one check costs in all in the `decision` runs, the AI model's dollars plus the decision model's: their median is no higher than the highest `main` run |

The decision model's dollars are the input tokens its host counted, read through a relay on this computer, at the host's listed price (US$0.02 a million input tokens for Decider v1.2, output free); the app's own cost record holds only the AI model's. The report gives the two amounts side by side. The counts that decide parts A and B are in `eval/speed/decisionFirstScore.ts`, tried on made-up sentences in `tests/eval/decisionFirstScore.test.ts`.

**Reported, with no bar here:** when the AI model's first and last Mark land in each arm, and when the last first reading shows. Three runs an arm on a real model are too few to bar a time on; the time is barred free, in part T.

## Part M: the check alone on the same sentences, and the three shapes

`INCARNAMIND_EVAL_SPEED_DECISION_FIRST=replay-main`: Check this Note as on `main`, no decision model, Claude Haiku 5.5, once on the held-out pair of 120 sentences, each sentence's Mark against its label, counted as part A's table is. It runs after part A and has no bar: it is the other half of a comparison.

With parts A and M the three shapes of the check are scored on the same 120 sentences from two runs and no further request (`=shapes`, counts only):

| Shape | A sentence's verdict is |
|---|---|
| The AI model alone | part M's Mark: the check as it is today |
| The decision model alone | part A's Mark or first reading; nothing where it has neither |
| Both | part A's Mark or first reading where it has one and the sentence has no figure; part M's Mark elsewhere |

For each shape the report gives: right, Supported that is wrong, Contradicted that is wrong, Unsupported that is wrong, nothing shown, how many sentences reach the AI model, and what the shape costs from the two runs' own counts. Which shape is built is the owner's decision; this part gives the counts.

**Changed on 2026-11-15, before the shapes were scored: part M is not run afresh.** A run of the same check on the same pair of 120 sentences was saved on 2026-11-14: one run, `main` as it stood that day, Claude Haiku 5.5, US$0.415 by the app's count. The shapes are scored against it and part M spends nothing. One later merge touches the check's path (#3091, a table heading's unit), so the saved run is `main` of 2026-11-14 and not of today.

## Part T: time, measured free

`=dry`, `LIBRARY=mixed`: a scripted AI model at 3 s a reply and a decision host on this computer at 0.35 s a request, five runs an arm, alternated, 33 sentences. Two cases of the host:

- **As measured:** it is sure of every eighth sentence (`HOST_SURE_EVERY=8`), so the decision model marks 3 sentences in 33 and they never reach the AI model. The two proofs measured 7 to 9 in 100.
- **Worst:** its scores only lean, so no sentence is taken off the AI model.

| Bar | Passes when |
|---|---|
| T1 The last Mark | As measured: the `decision` runs' last Mark, by their median, is no later than `main`'s median |
| T2 Each sentence | As measured: the median sentence the AI model marks lands no later than in `main` |
| T3 The first Mark | As measured: the AI model's first Mark, by the `decision` runs' median, is no more than 1 s after `main`'s median |
| T4 Worst | With a host that is sure of nothing: no sentence's Mark, by the median of its runs, lands more than 1.5 s later than in `main`, and the median sentence no more than 1 s later. Run once on the final head with this computer's load under 12, and reported as it lands |

A check sends nothing to the AI model until its sentence is read, so that a sentence the decision model marks never reaches it. T3 and T4 bound what that costs: one reading, which is one search and one answer from the host. Sending the check's first request at once and cancelling it for a marked sentence would remove the wait and throw paid requests away; reading without the search would change what is read. Neither is built.

**Measured on 2026-11-14, before any paid request** (seconds from the User's action; range and median of five runs; this computer carried other work, load 6 to 17):

| Case | | `main` | `decision` |
|---|---|---|---|
| As measured | First reading | | 0.7 to 0.8 (0.7) |
| | All readings in | | 10.9 to 25.6 (12.6) |
| | AI model's first Mark | 9.4 to 10.0 (9.9) | 10.0 to 10.9 (10.3) |
| | Last Mark | 60.1 to 64.0 (61.0) | 54.8 to 58.8 (55.5) |
| | Each sentence the AI model marks | | from 6.1 s earlier to 0.7 s later, median 0.7 s earlier |
| Worst | AI model's first Mark | 9.4 to 9.7 (9.4) | 10.1 to 10.4 (10.3) |
| | Last Mark | 60.1 to 60.8 (60.2) | 61.0 to 61.6 (61.2) |
| | Each sentence | | 0.7 to 1.1 s later, median 1.0 |

- **T1 and T2 pass.** The whole check ends about 5 s sooner, because the sentences the decision model marks cost the AI model nothing.
- **T3 passes:** the AI model's first Mark lands 0.4 s after `main`'s median.
- **T4 is met in the run above and not yet shown on the final code:** with a model that marks nothing, each sentence's Mark landed 0.7 to 1.1 s later, the median sentence 1.0 s. That run came before the last change to the order of work (a reading a check waits for now goes ahead of other readings). The one worst-case session run since was on a computer under heavy other work (load 6 to 29) and is not a fair reading: there `main`'s own last Mark spread from 60.2 to 65.9 s, the AI model's first Mark landed 1.4 s later and the median sentence 1.8 s later. A busy computer stretches the wait, because a reading's search takes longer. The pull request gives T4 from its final head on a quiet computer, and the gate is not passed without it.
- **On the final head, 2026-11-15, run once** (five runs an arm, alternated; load 9 to 16 in the worst case and 6 to 21 as measured):

  | Case | | `main` | `decision` |
  |---|---|---|---|
  | As measured | First reading | | 0.7 to 1.9 (0.9) |
  | | All readings in | | 11.4 to 26.8 (12.9) |
  | | AI model's first Mark | 9.4 to 10.0 (9.6) | 10.1 to 12.7 (10.3) |
  | | Last Mark | 60.1 to 63.6 (61.4) | 55.0 to 61.4 (55.9) |
  | | Each sentence the AI model marks | | from 6.2 s earlier to 0.9 s later, median 0.7 s earlier |
  | Worst | First reading | | 0.7 to 1.4 (0.9) |
  | | All readings in | | 14.0 to 28.9 (20.8) |
  | | AI model's first Mark | 9.4 to 9.9 (9.7) | 10.5 to 11.9 (10.6) |
  | | Last Mark | 61.0 to 63.9 (62.1) | 62.0 to 65.2 (63.9) |
  | | Each sentence | | 0.9 to 2.6 s later, median 1.8 |

  **T1, T2 and T3 are met. T4 is not met:** with a host that is sure of nothing, 27 of the 33 sentences land more than 1.5 s later than in `main`, and the median sentence 1.8 s later against a bar of 1 s. The load was above the 12 the bar names for part of the run; the run is reported as it landed and was not repeated. Before the last change to the order of work the same case gave 0.7 to 1.1 s later (the table above), with every reading in by 10.3 to 12.9 s; after it the readings are in by 14.0 to 28.9 s.
- Only the first six checks wait for their reading: the readings of the rest are in before their turn. A check's search can also wait behind the one reading's search the reranker has started, which it cannot drop.
- A host that doesn't answer is waited for 5 s, once: then that check's readings end and the AI model checks every sentence. Of 13,179 answers measured from this host at 32 requests at once, half came within 0.3 s, 99 in 100 within 1.3 s, and the slowest after 3.6 s.

## Stops and the void rule

| Part | Expected | Stop |
|---|---|---|
| A | about 1,800 requests to the decision model, about US$0.05 | US$0.15 |
| M | one check of 120 sentences on the AI model, about US$0.30 | US$0.45 |
| B | six runs, about US$0.05 each for the AI model and cents for the decision model | US$0.60 |
| All | | **US$1.20** |

- Money is read from the provider's own credit count before and after each part, beside the app's count.
- **A run with a request that was refused, failed or timed out is void**, the AI model's or the decision model's, answered on a second try or not: it is kept apart, not counted, and run again inside the stop. One answered request to each model is made before each part.
- Models under test: Decider v1.2 and Claude Haiku 5.5. Readers: Claude Sonnet 5.5.
- A part that reaches its stop ends there and is reported as it stands.
- Since 2026-11-15 part M spends nothing (see part M), so the stops come to US$0.75.

## The second run, on the build since 2026-11-15

Written on 2026-11-15, before the second run's first paid request.

- **The build** is commit c941ba5f3. No change to the check follows it until both parts are reported.
- **Order.** Part A again, then part B. A Mark from the decision model that isn't its label in part A (A1) ends the run there, before part B.
- **The bars are as written, but for A2.** A2 tested the figure rule, which this build does not have. The first run's A2 stays recorded as not met. In the second run a Mark on a sentence with a figure is counted in A1 like any other, and the Marks are reported by a figure and none.
- **A3** reads the quote this build shows, the model's top sentence, in the same way: two fresh readers, as many decoys, a third reader on a split.
- **B1 as written** counts every Mark from the decision model that isn't the sentence's label, an Unsupported among them.
- **The Unsupported line is frozen at 0.25.** It was set on sentences of the checks evaluation's set and on four of `eval/repeats`, part B's Note among them. Part A's four Notes are the first text it is run on that it was not set on.
- **One more row, with no bar:** "Unsupported shown where a Passage settles it", the sentences labelled Supported or Contradicted that show Unsupported. In part A, those the decision model marked. In part B, each run's count in both arms, and in the `decision` arm by which model gave the Mark.
- **Part A's search** is the one the first run used: the gating set's Documents with embeddings on.

| Part | Expected | Stop |
|---|---|---|
| A again | 208 sentences at the US$0.00068 a sentence this build measured, about US$0.14 at the listed price | US$0.18 |
| B | as above | US$0.60 |

The void rule and the one answered request before each part are as above. A void run is run again only inside its part's stop.

## Results

### Part A, 2026-11-15

The real Decider v1.2 in the app on the four held-out Notes: 1,384 requests, 1,464,695 input tokens, every request answered. US$0.020 by the provider's credit count, US$0.029 at the listed price; the stop was US$0.15. 196 of the 208 sentences carry a label that is a Mark.

| What the decision model did | Pair of 120 | Pair of 88 | All |
|---|---|---|---|
| Marked Supported, right | 4 | 1 | 5 |
| Marked Supported, wrong | 0 | 0 | 0 |
| Marked Contradicted, right | 3 | 5 | 8 |
| Marked Contradicted, wrong | 0 | 0 | 0 |
| First reading the label's way | 67 | 43 | 110 |
| First reading the other way | 3 | 3 | 6 |
| No reading | 35 | 30 | 65 |
| Not found in the Note | 2 | 0 | 2 |

| Label | A figure | Sentences | Marked | First reading the label's way | The other way | None |
|---|---|---|---|---|---|---|
| Supported | yes | 74 | 3 | 58 | 0 | 13 |
| Supported | no | 21 | 2 | 15 | 0 | 4 |
| Contradicted | yes | 33 | 2 | 27 | 1 | 3 |
| Contradicted | no | 17 | 6 | 10 | 0 | 1 |
| Unsupported | yes | 17 | 0 | 0 | 1 | 16 |
| Unsupported | no | 34 | 0 | 0 | 4 | 30 |

| A sure score a rule held back | Sentences | Of them as labelled |
|---|---|---|
| A figure | 42 | 42 |
| No line to quote | 8 | 8 |

| Bar | Result |
|---|---|
| A1 Wrong Mark | **Met.** 13 Marks, 13 their label. Zero wrong in 13 still allows a true share of up to 21 in 100 |
| A2 Figures | **Not met.** 5 Marks sit on a sentence with a digit that the app's figure rule does not count as a figure. All 5 are their label |
| A3 The quote | **Not met.** Both readers reject the quote under 4 of the 13 Marks (1 Supported, 3 Contradicted) and accept it under 9. Neither reader accepted a decoy and they agreed on every Mark, so no third reader was called |
| A4 First readings | **Met.** 110 of 116 lean the label's way, 95 in 100. Of the 6 that don't, 5 are on sentences labelled Unsupported and 1 leans Supported on a Contradicted sentence with a figure |

- **A3 missed is no ship as the gate is written.** The four Marks are right; the line shown under them is not the line that states the sentence or says the opposite. The decision model scores a whole Passage, and the line is then picked by its words alone, the Passage's nearest line to the sentence.
- **The scores alone:** 63 sentences have a sure score (13 marked and 50 a rule held back), and all 63 are their label. Zero in 63 allows up to 4.6 in 100. On sentences with a figure, 47 sure scores and 47 their label: the figure rule held back no wrong Mark here.

### The three shapes, on the 114 sentences the two runs share

| Shape | Right | Supported, wrong | Contradicted, wrong | Unsupported, wrong | Nothing shown | Sentences to the AI model |
|---|---|---|---|---|---|---|
| The AI model alone | 83 | 1 | 0 | 11 | 19 | 114 |
| The decision model alone | 74 | 3 | 0 | 0 | 37 | 0 |
| Both | 86 | 2 | 0 | 9 | 17 | 94 |
| The decision model alone, with no reading shown as Unsupported | 100 | 3 | 0 | 11 | 0 | 0 |

- The last row is not a shape this build has: it reads the second row's 37 sentences with nothing shown as "no Passage supports it", so that a build that says so can be set beside it. 26 of the 37 are labelled Unsupported.
- The decision model alone counts its first readings as verdicts: its 3 wrong are first readings, not Marks. Its 37 with nothing shown are 26 sentences labelled Unsupported, 9 Supported and 2 Contradicted; this build gives no reading that says no Passage supports a sentence.
- Cost: the AI model alone was US$0.415 for the pair of 120. The decision model read all 208 sentences for US$0.029 at its listed price.

### Parts B and M

Part M spent nothing (above). Part B has not run: it waits for the choice of shape.
