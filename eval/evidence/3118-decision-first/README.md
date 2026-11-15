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

The reading changed after this file was written. Points 1 to 3 above and the bars below describe the earlier build. Parts A and B were run on this one later ("The second run", below), and what was decided since is at the end of this file ("The owner's decision, the card and one fresh blind reading").

1. **One search, one request.** The sentence's 30 best Passages by the plain search (no reranker, no neighbouring Passages), with any it cites first, go to the decision model in one request with the two questions of each.
2. **A Mark from the decision model** where a score is clear of the line, the Passage asked about alone scores clear again, and a number of the sentence the Passage writes another way is the same amount by the model's own answer (0.92). A sentence with a figure can get one. The quote is the sentence of that Passage the model scores highest on the verdict's question; a heading, a table's row and a sheet's row are quoted as one line. Since the commit after part B, the Mark says that line as its quote only where the line, asked about alone, passes too ("In the check code since", below).
3. **Unsupported from the decision model** where every Passage scores under 0.25 on both questions and the sentence cites nothing. Since commit aed5b2c80, only after one more question ("Changed after part A again", below).
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
- **On commit aed5b2c80, 2026-11-15, the worst case run once** (five runs an arm, alternated; load 3.9 to 8.5):

  | | `main` | `decision` |
  |---|---|---|
  | First reading | | 0.5 to 0.5 (0.5) |
  | All readings in | | 0.9 to 0.9 (0.9) |
  | AI model's first Mark | 9.4 to 9.6 (9.4) | 9.8 to 9.9 (9.9) |
  | Last Mark | 60.0 to 60.4 (60.2) | 60.5 to 60.7 (60.6) |
  | Each sentence | | 0.3 to 0.5 s later, median 0.4 |

  **T4 is met on this build:** no sentence lands more than 1.5 s later than in `main` (the latest is 0.5 s) and the median sentence is 0.4 s later. The reading no longer uses the reranker, so every reading is in within a second and no check's search waits behind one. This host's scores only lean, so the run holds none of the one more request a sentence gets before it reads Unsupported; that request delays only the decision model's own Unsupported, never a Mark of the AI model. T1 to T3 were not run again with five runs an arm; the one scripted run of four on this build (above, "Changed after part A again") gave a last Mark at 54.0 and 53.8 s against 60.4 and 60.1 s, and the AI model's first Mark 0.4 s after `main`'s.
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

**Added after part A again and before part B, with no bar: the joined question.** Part A again gave 41 Unsupported from the decision model, 7 of them on sentences labelled Supported. For those 41 sentences one more question is counted, as it was fixed before this gate on other text and with nothing new: the 5 Passages the model scored highest on "states the sentence" are joined under their Documents' names and the two questions are asked of them once, read at the verdict's lines. Reported: of the 7, how many turn Supported; of the 34 right ones, how many turn anything. It is asked by the script outside the app, with that script's own search: for the pair of 120 the answers are those saved on 2026-11-15 before part A again ran; for the pair of 88 they are asked now, stop US$0.02. It measures a rule, not a build that has it. Part B is held until this row is read.

### Changed after part A again and before part B

Written on 2026-11-15, after part A again, its quote reading and the joined row (Results, below), and before part B's first request.

**1. The joined question is in the build (commit aed5b2c80).** A sentence every Passage scores under 0.25 on is asked about once more before it shows Unsupported: the 5 Passages the model scored highest on "states the sentence", joined as one under their Documents' names, the two questions, read at the verdict's lines. A score clear of a line there is a **first reading** on that side, and the sentence goes to the AI model's check; it is never a Mark from the decision model, because no single Passage was confirmed to hold it. Still under the lines, the sentence is Unsupported as before. A host that can't be asked gives no Unsupported.

- **Why:** part A again gave 41 Unsupported from the decision model and 7 of them sit on sentences labelled Supported, each one a summary of several Passages. The joined question turned 4 of those 7 Supported and none of the 34 right ones. 3 of the 41 stay wrong with it.
- **What it rests on:** the same 41 sentences it now runs on. It was fixed, wording and number of Passages, before this gate on other text; whether to adopt it was decided on these. Part B's Note is the first text the build with it is run on.
- **Checked free:** unit tests through the core (`tests/core/decisionFirst.test.ts`), and one scripted run of the four runs below (`=dry`, mixed Library, the host sure of every eighth sentence): the last Mark landed at 60.4 and 60.1 s in `main` and at 54.0 and 53.8 s in `decision`, every first reading within 1.0 s, 41 requests to the host a run. That host's scores never fall under the Unsupported line, so the run shows the build still runs as before, not the joined question's own time.
- Part A is not run again for it. The quote's unit is as part A again ran it.

**2. Part B is four runs, not six: `main, decision, decision, main`.** The stop stays US$0.60.

- **Why:** this file expected about US$0.05 a run. The pressure test measured one `decision` run of the 33-sentence Note at US$0.114 (Claude Haiku 5.5 US$0.100 for the 20 sentences that reached it, the decision model US$0.015). A `main` run sends all 33, about US$0.165 at the same price a sentence. Six runs come to about US$0.84; four to about US$0.56.
- **B2 reads "both" for "all three":** no sentence carries its label in both `main` runs and misses it in both `decision` runs. With two runs an arm, a median is the mean of the two.
- **B1, B3 and B4** as written. Two runs an arm show less than three: the report says so beside each bar.
- The harness stops before a run once US$0.40 is spent by the app's count, so that a fourth run at a `main` run's price ends at or under the stop.
- **No rerun.** One answered request to each model first (a check of one sentence). If a run is void, part B ends there and is reported as it stands: the stop holds no second attempt.
- **Also saved, with no bar:** each Mark's quote in every run. The quotes under the AI model's Supported and Contradicted Marks in the two `main` runs are read blind the way A3 reads the decision model's (two fresh readers, as many decoys, a third on a split), to set today's check beside A3, and so are the decision model's own in the two `decision` runs, on the same sentences. A quote two runs both give is read once. Part B's Note is contracts; it holds few tables, so today's check on a table's quote stays unmeasured.

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

### Part A again, 2026-11-15, on commit c941ba5f3

The real Decider v1.2 in the app on the same four Notes: 366 requests, 5,974,015 input tokens, every request answered. US$0.120 at the listed price (the stop was US$0.18). The labelled Passage was among the 30 read for all 151 sentences whose label names one.

| What the decision model did | Pair of 120 | Pair of 88 | All |
|---|---|---|---|
| Marked Supported, right | 16 | 11 | 27 |
| Marked Supported, wrong | 0 | 0 | 0 |
| Marked Contradicted, right | 13 | 11 | 24 |
| Marked Contradicted, wrong | 0 | 0 | 0 |
| Marked Unsupported, right | 20 | 14 | 34 |
| Marked Unsupported, wrong | 3 | 4 | 7 |
| First reading Supported, the label's way | 31 | 21 | 52 |
| First reading Supported, not | 5 | 1 | 6 |
| First reading Contradicted, the label's way | 13 | 8 | 21 |
| First reading Contradicted, not | 0 | 1 | 1 |
| No reading | 11 | 11 | 22 |
| Not found in the Note | 2 | 0 | 2 |

| Label | A figure | Sentences | Marked, any verdict | First reading the label's way | The other way | None |
|---|---|---|---|---|---|---|
| Supported | yes | 74 | 29 | 38 | 0 | 7 |
| Supported | no | 21 | 5 | 14 | 0 | 2 |
| Contradicted | yes | 33 | 13 | 17 | 2 | 1 |
| Contradicted | no | 17 | 11 | 4 | 1 | 1 |
| Unsupported | yes | 17 | 11 | 0 | 1 | 5 |
| Unsupported | no | 34 | 23 | 0 | 3 | 8 |

| Bar | Result |
|---|---|
| A1 Wrong Mark | **Met.** 51 Supported or Contradicted Marks, 51 their label; 37 of them on a sentence with a figure. Zero wrong in 51 still allows a true share of up to 5.7 in 100 |
| A2 Figures | Retired for this run (above) |
| A3 The quote | **Not met.** Both readers accept the quote under 39 of the 51 Marks and reject it under 12 (9 Supported, 3 Contradicted). They agreed on every Mark, so no third reader was called; neither accepted any of the 51 decoys |
| A4 First readings | **Met.** 73 of 80 lean the label's way, 91 in 100 |

- **A3 missed is no ship as the gate is written.** All 12 Marks are their label. Both readers answered "neither" to each: the quote shown does not carry the verdict. By the quote's shape, counted by a script's rule on text the builder has not read:

  | Shape of the quote | Quotes | Accepted | Rejected |
  |---|---|---|---|
  | A table's row or cell (a tab, or under half of its characters are letters) | 7 | 3 | 4 |
  | Cut at the 200 characters the app stores of any check's quote (#2220) | 5 | 2 | 3 |
  | Any other | 39 | 34 | 5 |

  Three of the rejected table quotes are one number of three digits alone.
- **Unsupported shown where a Passage settles it: 7.** All 7 are labelled Supported and none cites; the labelled Passage was among the 30 read for each. Their highest score was 0.055 to 0.227; the 34 right ones had a median of 0.012 and a highest of 0.182, so no line on a single Passage's score parts them.
- **Confirming on the Passage alone** held back 33 sure first scores, 31 of them the label and 2 against it.
- **The joined question on the 41 Unsupported, no bar:** of the 7 wrong, 4 turn Supported and 3 stay neither; of the 34 right, none turns. Pair of 120, from answers saved before part A again: 1 of 3, and 0 of 20. Pair of 88, asked now: 3 of 4, and 0 of 14. 72 requests, all answered, US$0.011.

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

### Part B, 2026-11-15, on commit aed5b2c80

Four runs in one process, `main, decision, decision, main`, Claude Haiku 5.5 behind, 33 labelled sentences over their Documents and the mixed sample set. Every request answered in every run; none is void. US$0.530 at the listed price for both models (the stop was US$0.60), and US$0.005 for the one-sentence check before it.

| Run | Arm | Marks as labelled | Decision model's Marks | Of them not as labelled | First reading at | AI model's first Mark | Last Mark | Requests to the host | The AI model's cost | The decision model's cost | Both |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `main` | 27 | | | | 7.8 s | 43.9 s | | US$0.144 | | US$0.144 |
| 2 | `decision` | 28 | 12 | 0 | 2.3 s | 7.5 s | 34.0 s | 54 | US$0.104 | US$0.017 | US$0.121 |
| 3 | `decision` | 29 | 11 | 0 | 2.7 s | 9.3 s | 39.1 s | 49 | US$0.115 | US$0.015 | US$0.129 |
| 4 | `main` | 28 | | | | 6.9 s | 47.9 s | | US$0.136 | | US$0.136 |

| Bar | Result |
|---|---|
| B1 Wrong Mark | **Met.** 23 Marks from the decision model in the two runs, 0 not as labelled; 4 of them are Unsupported. Zero wrong in 23 still allows a true share of up to 12 in 100 |
| B2 The AI model's Marks | **Met.** 28 and 29 as labelled in `decision` against the lowest `main` run's 27. No sentence carries its label in both `main` runs and misses it in both `decision` runs; one is the reverse |
| B3 First readings | **Met.** The first reading showed at 2.3 and 2.7 s |
| B4 Cost | **Met.** US$0.121 and US$0.129 a check in `decision`, the two models together, against the highest `main` run's US$0.144 |

- **Two runs an arm.** The bars are read as written above; a difference of one sentence or one cent between the arms is inside what two runs can show.
- **Unsupported shown where a Passage settles it:** the AI model gave 5 and 3 in the `main` runs and 5 and 4 in the `decision` runs. The decision model gave none.
- **The quotes, read blind, no bar.** Under the AI model's Supported and Contradicted Marks in the `main` runs: 25 distinct quotes (42 Marks), both readers accept all 25. Under the decision model's in the `decision` runs: 10 distinct quotes (19 Marks), both accept all 10. No split; neither reader accepted any of the 35 decoys. All 35 quotes are plain sentences by the script's rule: none is a table's row or cell and none is cut at 200 characters. So on plain sentences today's check stands at 25 of 25 and the decision model at 10 of 10 here and 34 of 39 in part A again; **today's check on a table's quote, where A3 lost 4 of 7, is not measured.**

### Where the gate stands

| | Bar | Result |
|---|---|---|
| 1 | A1 no wrong Mark | Met, 0 of 51 |
| 1 | A3 the quote | **Not met**, 39 of 51 |
| 1 | A4 first readings | Met, 91 in 100 |
| 2 | B1, B2 | Met |
| 3 | T1 to T3 | Met on the earlier head |
| 3 | T4 | Met on this build (commit aed5b2c80): each sentence 0.3 to 0.5 s later |
| 4 | B4 | Met |

With A3 not met the decision model reads only where the User chose it, unless the owner decides otherwise with the 12 quotes in front of them.

### One more reported row: when the model's own score would withhold a quote

Written on 2026-11-15, before its first request. No bar, and no build has this rule: it measures one.

- **The rule, fixed here:** a Mark's quote is "shown" when the quote, asked about alone with the two questions, passes the lines a Passage asked about alone must pass (stated 0.985 with the opposite under 0.895 for Supported; opposite 0.905 for Contradicted), and is not over 200 characters. Any other Mark would name its Document and place and claim no quote.
- **Asked:** the 46 quotes of part A again that are not cut at 200 characters, and the 10 distinct quotes under the decision model's Marks in part B. The 5 cut quotes of part A again count as not shown and are not asked. The script outside the app asks, with its own context for the sentence, and names the quote's Document without the page the app would send. Stop US$0.01; one answered request first; a run with a request refused, failed or timed out is void.
- **Reported, for part A again and part B apart:** shown or not shown, against accepted or rejected by the two blind readers whose answers are already in.
- **Beside it, from scores saved before this gate, no request:** the same four cells for the 139 quotes of the checks evaluation's set read blind on 2026-11-15. There the score is the line's in a request about all its Passage's lines, not the line asked alone, and the quote was a printed line, not a sentence.

**Result.** 115 requests with the one before it, all answered, no run void, US$0.001 at the listed price.

| Part A again, 51 quotes | Accepted by both readers | Rejected |
|---|---|---|
| Shown | 29 | 0 |
| Not shown | 10 | 12 |

| Part B, the decision model's 10 quotes | Accepted by both readers | Rejected |
|---|---|---|
| Shown | 9 | 0 |
| Not shown | 1 | 0 |

| The checks evaluation's set, 139 quotes, saved scores | Accepted by both readers | Rejected |
|---|---|---|
| Shown | 123 | 1 |
| Not shown | 12 | 3 |

- In part A again the rule withholds all 12 quotes the readers rejected, and 10 they accepted: 2 cut at 200 characters and 8 by the score. 29 of 51 Marks would show a quote, 22 would name the Document and place only.
- The rule was fixed before these requests, at lines measured for another question (a Passage asked about alone). Part A again's 51 are the text the rule was thought of on; part B's 10 and the 139 are not.

### In the check code since: a verdict whose line fails alone rests on its Passage

The rule of the row above is in the check. The card followed ("The owner's decision, the card and one fresh blind reading", below).

- **What the check does.** Once the confirming Passage's lines are scored, the line the model scores highest is asked about alone, under its Document's name without the page, as the row measured it. It is one more request for each verdict the decision model gives, sent after the lines' answer.
- **What the Mark keeps.** Where the line alone passes the lines a Passage alone must pass, nothing changes. Where it doesn't, or where it is longer than the 200 characters a check stores (never asked), the verdict stays the decision model's: the Mark says it rests on its Passage, and says no quote. Its receipt keeps the line, which places the Passage in its Document. Where the host can't be asked about the line, the sentence keeps a first reading and goes to the AI model, as after any request that fails.
- **What a User saw at that commit.** The card still showed the stored line. Three things do change for a Mark that rests on its Passage: a Contradicted one has no line of what the Document says on its card, the check record's Quote cell is empty beside the Document and the place, and a comment in an exported file names the Document and the place without the line.
- **Read by a second reader** who had not seen the change's reasoning. The record, the exported comment and the failed request above are that reading's findings, fixed here.
- **Not measured on this build.** No bar was run again. A3 is read again once the card shows no quote for such a Mark. T4's run is not touched: its host is sure of nothing, so no verdict is given and the extra request is never sent. A decision model's own Mark lands one request later than before: in the free run (`dry`, the scripted host at 350 ms a request, two runs of 4 such Marks, load 6.4 to 6.8) at 1.2 to 1.3 s, where the same run gave 0.9 to 1.0 s before this change, with 45 requests to the host where there were 41.
- **Saved by the runs.** Each Mark of a `real` or `dry` run says whether its quote is shown (`quoteShown`).

### The owner's decision, the card and one fresh blind reading

**The decision.** With A3 not met and its 12 rejected quotes in front of them, the owner decided that reading by default goes on with the rule above (a Mark whose line fails alone says no quote), once the card shows no quote for such a Mark and one fresh blind reading of the quotes the card then shows has passed. What follows was fixed before that reading's first request.

**The card.** A Mark that rests on its Passage shows no quote of the model's: the card names the Document and the place, and Open goes to the stored line. Nothing is offered that would write that line into a Citation (Add as Citation, Widen, Replace); a Citation the sentence already has on that place is still named. A first reading shows as a dashed ring in the meta ink, named "Likely supported" or "Likely contradicted" with the model it came from, and never counts as checked.

**The text.** The citation benchmark's records (`eval/citations`) that rest only on the six PDFs no run of this gate had loaded: 71 records (28 English, 43 Chinese). To have Contradicted sentences, a model lane wrote one wrong-figure variant for each single-fact and table-figure answer, changing the figure only; a second reader, given variants and true answers mixed and unmarked, read 33 of 33 variants as contradicted and 32 of 33 true answers as stated (1 unclear). 3 of the 36 answers hold no figure and got no variant. That makes 104 Notes and 111 sentences by the app's splitter: 71 labelled Supported, 33 Contradicted, 7 Unsupported. A Note is one paragraph, the record's question and then its answer, in a Search scope of its own PDF. 12 answers are a bare figure under three words; they stay as written.

**The terms.** One `replay` run in the app on commit 8099e501f, keyword search (the app's default). Bar: A3 as written, on the quotes the card shows, read against the verdict's side: none rejected by both readers. Two fresh readers who see a question, its sentence and a quote, and as many decoys (a sentence beside another Document's quote); a third reader on any split, before the key is opened. Reported, not a bar: the decision model's Marks against the labels. Stop US$0.10; one answered request first; a run with a request refused, failed or timed out is void; one run.

**Result.** 235 requests, all answered, US$0.042 at the listed price, after 4 answered requests of a probe (US$0.0007).

| The 111 sentences | Sentences |
|---|---|
| Not checked by the app (bare figures) | 2 |
| Checked, no Passage found by keyword | 7 |
| Read by the decision model | 102 |

| Of the 102 read | Sentences | As labelled |
|---|---|---|
| Supported from the decision model | 15 | 15 |
| Contradicted from the decision model | 15 | 15 |
| Unsupported from the decision model | 9 | 6 |
| First reading Supported | 47 | 47 |
| First reading Contradicted | 10 | 10 |
| No reading | 6 | |

| The 30 Supported and Contradicted Marks | Under Supported | Under Contradicted |
|---|---|---|
| The card shows a quote | 10 | 12 |
| The Mark rests on its Passage, no quote | 5 | 3 |
| Quotes both readers accept | 10 of 10 | 12 of 12 |

- **The bar is met**: no quote the card shows was rejected. The readers agreed on all 44 items, so there was no split and no third reader; neither accepted any of the 22 decoys.
- All 12 quotes under Contradicted are on the written variants.
- **The 3 Unsupported that are not as labelled** are all labelled Supported: en-022 and en-023 (multi-passage answers) and en-074 (a calculated answer). A Passage the label rests on was among those read for 95 of 95.
- The 7 with no Passage found: 6 wrong-figure variants of table figures (5 of them bare figures) and one English answer about a Chinese Document. The first reading searches with the sentence alone (#3136).
- The 12 bare figures: 2 not checked by the app, 5 with no Passage found, 4 a first reading Supported, 1 Supported from the decision model, resting on its Passage.
- **Keyword ran.** In a free run with embeddings on, 109 of the 111 reach the decision model (70 Supported, 32 Contradicted, 7 Unsupported by label), against 102 by keyword (69, 26, 7). A3's first reading (part A again) was on embeddings and this one is not, so the two are not a like-for-like repeat.

So reading by default is on in this build (`src/core/answers/checks/decisionChoice.ts`), for a User whose own AI model for checks already runs on the decision model's service and who hasn't said.

### Changed at the first read, after every run above

Two rules changed when the pull request was read, both to the careful side. No request was sent for either.

- **A final Supported needs no Passage leaning to the opposite.** Before, a Passage that states the sentence clear of its line gave Supported unless another said the opposite at 0.895 or over. Now another Passage at 0.5 or over (a first reading's line for the opposite) sends the sentence to the AI model unread, as two leaning Passages already did: the Documents disagree. Counted free on the saved records of the three measured runs, by each sentence's highest opposite score among the Passages read:

  | Run | Supported from the decision model | Of them with a Passage at 0.5 or over on the opposite | Their highest opposite score |
  |---|---|---|---|
  | Part A again, held-out Notes | 27 | 0 | 0.073 |
  | Part B, two runs | 0 | | |
  | The fresh reading | 15 | 0 | 0.017 |

  So the rule takes none of the 42 Supported Marks these runs gave, and no bar's count changes. It is not measured on text where Documents do disagree.
- **By default it reads only the checks that go to the service of the User's own AI model for checks.** Before, a run was read by default when its own AI model ran on the decision model's service, while Settings and Privacy went by the User's default model: a Note with its own model there was read behind a switch that showed off. Now both go by the User's default model's service, and a run is read by default only when it goes to that same service. Every run of this gate had one AI model, the default, so none is touched.

### Part M

Part M spent nothing (above).
