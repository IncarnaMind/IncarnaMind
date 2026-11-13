# The gate for call help telling this call from an earlier one (#3005)

Written and committed on 2026-11-12, before any run it gates, with its cases (`../callHelpEarlierCalls.ts`), its runner (`../earlierCalls.ts`) and its report (`../earlierCallsReport.ts`). No run has read the cases, and none of their lines is in a prompt's examples; the instruction line below has no examples.

## What it gates

In the second pressure test of main, 5 of 69 Chinese call-help replies put an earlier call's words on the live call: "对方问的是留在欧洲" when only the earlier call had said Europe, and "我们的数据必须留在欧洲" offered as a line to say. Every press sends the earlier calls' Transcripts of the Note's Folder, named and dated exactly like this call's, so the model can't tell the calls apart, and the sources under a reply show two identical lines.

The change (commit 85799c87a), in what the model is sent:

- Every Transcript Passage of a call carries its call after its place: this call's `call="this" started="<date and time>"`, an earlier call's `call="earlier" note="<its Note's name>" started="<date and time>"`, the time from `src/shared/dates.ts`. Every block a Passage is shown in goes through the one formatting: `<live-transcript>`, `<found-in-documents>`, search results and a Folder's whole text.
- One instruction line in the system prompt during a call: "A Transcript Passage marked call="this" is this call's. One marked call="earlier" is another call, named by its note and started: it was not said in this call. Say they or you said something only from call="this" lines; give an earlier call's line as said in that call, saying when, and cite it."
- The help buttons' Documents line reads "A Document fact, or an earlier call's line (call="earlier"), was not said in this call", where it read "A Document fact was not said in this call".

And in what the User sees: a cited Transcript in the sources under a reply, in its chip's title and in an Answer in the assistant shows its call's start ("started 09:00", "开始于 09:00") when it is an earlier call's, or when another cited Transcript has the same name.

**Frozen.** What the branch sends is frozen at commit 85799c87a for this gate: its marking and its lines are not changed on what the pilot or the runs show. Later commits on the branch change only what the User sees and this gate's own files, or merge main, whose changes both arms take alike.

## The cases

- Two calls with the same buyer, each in a Note of its own in one Folder, both Notes named for the day, as the User's calls with one company pile up. The earlier call is recorded and stopped; then the live call records. Every name, figure and company is made up.
- Two pairs of calls, each in English and its Chinese twin, each in both orders, so each call is the earlier one once and the live one once: 8 cases.
  - First pair (a freight company): in one call the buyer says their data has to stay in Europe, that they want to start in January and that the budget is twelve thousand a year; in the other the buyer asks where their data would be stored, says they now start in March, and asks whether the budget can be fifteen thousand with onboarding.
  - Second pair (a group of clinics): in one call the buyer says the contract goes to a named person in procurement, that the tablets go to a warehouse, and that they want a two-year contract; in the other the buyer asks who would run the rollout, says the tablets now go straight to a clinic, and asks whether they could sign for three years.
- On each live call:
  - "What should I say?", "Answer their question" and "Check what was said" are pressed, as the panel presses them: the three general buttons sent the Folder's Documents found for the newest lines, an earlier call's Transcript among them ("Sum up so far" and "What do they want?" read this call alone and are sent no Documents). No reply may give what only the earlier call holds as said in this call.
  - "What did they say last time?" (上次他们说了什么？) is typed in the assistant on the live call's Note. The reply must give what the earlier call holds, as said then and saying when, cited to that call's Transcript.

## The arms

Paired as `../README.md` › Paired runs says, the order turning within each cell:

- `calls-unmarked`, main's path: the core's evaluation switch `callsUnmarked` sends and shows an earlier call's Transcript as before, and leaves out the new instruction lines. `tests/core/callHelpEarlierCalls.test.ts` holds that this arm's request is the branch's with the marks taken out, in English and Chinese.
- `today`, this branch.

## What is read, per item, from `report.json`

The judge reads each reply against both calls' lines and the earlier call's start (`../earlierCalls.ts`, its `JUDGE`):

- **earlierAsThis**: the reply gives something only the earlier call holds as said, asked or wanted in this call, or as where the other side stands now, without saying it comes from the earlier call. It is the failure `earlier-as-this`.
- **thenWithWhen** ("last time" only): the reply gives at least one thing the earlier call holds as said in that call, and says when that call was, by its date, its day or its time.
- **grade**: for a button, right when what it gives the User to say fits this call's newest lines and isn't earlierAsThis; for "last time", right when it gives the earlier call's words as from that call, saying when. Partly and wrong as in the call-help set.
- **asThisCall**: the numbers whose sentence says the other side said, asked or wants something in this call.
- **unstated**: the numbers whose sentence states something its quote doesn't. Those that show ✓ count as false Supported.
- **cited** ("last time" only): a found Citation of the earlier call's Transcript.
- **places**, kept for every reply so the judge's reading can be checked against the record: each line or sentence with a Citation, the number it shows, the source line the panel shows for it (its Document, place and start), whose call its Transcript is (`this`, `earlier` or `other`), its quote, whether the quote was found, and whether it shows ✓.

## The pilot, before the gate's runs

- **Main's path only, on Claude Haiku 5.5:** the pilot pairs `calls-unmarked` with itself, so each of the 24 button presses (8 cases, 3 buttons) gives two of main's replies: 48. No branch reply is asked.
- **Read by hand:** every reply's `earlierAsThis` is read against its text and places, and where the hand reading differs from the judge's, both are written in the results here. The gate counts the judge's verdicts.
- **What it sets.** The report gives main's rate p over the 48 replies, and so main's expected count in a gate run of 24 presses an arm: 24p. The Claude Haiku 5.5 runs R are the smallest number for which 24p·R is at least 6, up to what the stop allows (below). If even the runs the stop allows can't reach an expected 3 (or p is 0), the gate stops after the pilot: the cases don't provoke the fault, and they are rewritten before the branch ever runs.

## The bars, per model, on the items both arms finished

1. **Never this call's.** Main's arm shows at least 4 `earlier-as-this` button presses and the branch none. With fewer than 4 on main the fault is **not shown**: that is no pass. It is said on #3005, and the choice between a larger run and shipping the marking on the scripted tests alone is brought for a decision with the cost of each; no run goes past the stop without it.
2. **Last time still answered.** The "last time" replies that give the earlier call's words as said then, with when (`thenWithWhen`), and are `cited`: on the branch no fewer than main's, and at least three quarters of them.
3. **No worse on this call.** The button replies graded right on the branch are no fewer than main's.
4. **No new false Supported.** No item has a false Supported on the branch and none on main.
5. **No more items failing to run.**

A bar that fails stops the gate there, and the change doesn't ship as it is. Every bar's counts are given in all and by the order of the two calls (the earlier call the one that brings the changes, or the one that said it first), since nearly all of main's fault in the pilot is in one order; the report's section prints both.

## Reported, not gated

- Main's and the branch's `earlier-as-this` by button and language, and each such reply with its places.
- **The check not knowing whose call a quote is from** (#3005's sixth box, for later): on both arms, the places that show ✓ beside a sentence saying the other side said, asked or wants something in this call (`asThisCall`) while its quote is an earlier call's line.
- Every void, failure and the requests each run made.

## Models, judge, keys

- **Claude Haiku 5.5 is the proof,** as 4 of the 5 wrong replies were seen there: the pilot, then R runs of all 8 cases (24 button presses and 8 "last time" questions an arm a run).
- **Claude Sonnet 5.5 is the guard** that the change doesn't hurt elsewhere, run only if every Haiku bar holds: one run of the first pair's 4 cases (`INCARNAMIND_EVAL_SPEED_ITEMS` naming their 16 items), cut from 8 cases to fit the stop. As a guard its bar 1 needs no main count: it holds when the branch shows none, so the report's "not shown" with the branch at none reads as holding there.
- **Meant and ran.** The issue names DeepSeek V4.1 Flash 1017 as the second model. This gate runs Claude Sonnet 5.5 in its place, because DeepSeek's key has no credit to spare.
- Each model is the Answers model, with call help on Same as Answers.
- **The judge is Claude Sonnet 5.5** for the pilot and both models (`INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-sonnet-5-5`). No request of this gate goes to Claude Opus or Claude Fable.
- **One route and one key:** the first direct Anthropic key. Each run (the pilot is one) holds the key's lock for its whole length, one lock a run. Before each run, one smallest request reads the key's allowance from its rate-limit headers; the run starts only above 90%, and the figure is recorded with it.

## Voids, load and the stop

- A run counts only if none of its requests was refused, failed or timed out, read from every request's outcome in `report.json`. Otherwise it is void: kept, struck here with the reason, run again, and its numbers not read. A judge's call that throws fails its item and voids the run too. The report prints "Void" at the top of a model's part when any of this holds.
- The runs go strictly one after another, each at a 15-minute load of 24 or less, and the record keeps the one-minute load at its start and end.
- **Spend, estimated a reply:** a Claude Haiku 5.5 button reply under $0.001 (the call-help marks gate measured its presses at about $0.0006 with their checks), a typed question about $0.002, a Claude Sonnet 5.5 button reply about $0.013 and a typed one about $0.025 (catalog prices: Haiku $0.10 and $0.50, Sonnet $2 and $10 a million tokens in and out), and the Sonnet judge about $0.003 a reply.
  - The pilot: 48 replies, about **$0.19**.
  - A Claude Haiku 5.5 run of the gate: 8 cases, 3 buttons and a question each, both arms: about **$0.27**.
  - The Claude Sonnet 5.5 guard: 4 cases, both arms, one run: about **$0.61**.
- **The stop is $1.50 for everything, the pilot included,** held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD=1.50`. Before the gate's runs, these estimates are scaled by the pilot's measured spend a reply against its estimate. Then:
  - R of at most 2: the Haiku runs and the Sonnet guard fit ($0.19 + $0.27R + $0.61).
  - R of 3 or 4: the Haiku runs fit, and the guard doesn't; the Haiku proof isn't cut, and the guard is brought for a decision.
  - R above what fits: as many runs as fit, if they reach an expected 3; otherwise the gate stops after the pilot.
- A void run's rerun must fit the same stop, or it needs a new yes.

## Free first

Before any paid request:
- `tests/eval/earlierCallsSet.test.ts` runs the set on scripted models. Each of the 8 cases, English and Chinese, records the earlier call, stops it and records the live one in one Folder. It then runs its four items, the typed question cited to the earlier call. Each button press is sent this call's lines in `<live-transcript>` and the earlier call's in `<found-in-documents>`, "Check what was said" included. On one case run on both arms, the branch's request marks the earlier call's Passages as an earlier call's and main's arm sends them as before. The judge's reading, `cited`, the places and the failure are read as this file says.
- `tests/eval/earlierCallsReport.test.ts` reads literal rows: bar 1 holding, not shown and failing; bar 2's floor and its need for when and a Citation; a void; the reported ✓ count and listing; and the pilot's rate and runs.

## Results

### The pilot, 2026-11-13 03:08–03:18 UTC (commit 4e63e3bc9)

- **It counts.** 156 model requests, none refused, failed or timed out. The allowance was 99.9% before and after; the 15-minute load was 5.75 at the start and 8.44 at the end. Spent $0.14, the judge $0.08 of it: $0.0029 a reply against the estimate of $0.004.
- **Main's rate.** The judge counted 23 of main's 48 button replies as `earlier-as-this` (47.9%). A hand reading counted 29 (60.4%). Either way a run of 24 presses an arm expects well over 6 on main's arm, so R = 1.
- **By order (the judge's count).** When the earlier call is the one that changes what the other said ("we'd start in March now"), 21 of 24. When the earlier call said it first, 2 of 24. The model takes an earlier call's lines about a change for the newest.
- **Where the judge and the hand reading differ: 8 replies.**
  - The judge passed seven that the hand reading counts: en-a-then-b-answer (first), zh-a-then-b-say (second), zh-a-then-b-answer (both), en-a-then-b-say (second), en-a-then-b-answer (second), en-c-then-d-check (second).
  - The judge counted one that the hand reading passes: zh-c-then-d-say (second).
  - A second reader took four of the seven as firm: en-a-then-b-answer (first), zh-a-then-b-say (second) and zh-a-then-b-answer (both). Each gives an earlier call's requirement as settled, or as the other side's position now, cited to the earlier call, with no word that it was said then. The other three are borderline. Both readers pass zh-c-then-d-say (second).

### The judge sharpened, 2026-11-13, before the gate run

**Why the change.** All four firm misses are one form: an earlier call's requirement stated as a settled fact, in the User's voice. That is the form the issue was opened on, a line offered to say. The replies the judge did count put a question or a want on the other side. The judge's line named "said, asked or wanted in this call" first, and "where the other side stands now" only after it. And it read the Citation's label in `<citations>`, "(the earlier call)", as the reply saying where the line came from, though the User sees only a number. Counted as it was, the branch could pass bar 1 with that form still in its replies.

**What changed.**
- `earlierAsThis` now also counts something only the earlier call holds given as a settled fact, a requirement or where the other side stands, in anyone's voice, the User's included.
- It holds unless the reply's own words say it comes from the earlier call. A Citation, or the call its quote is from, doesn't say that. The words are general: none of the cases' or the pilot's sentences or names.
- What the branch sends is unchanged, frozen at 85799c87a.

**Judged again (`../earlierCallsRejudge.speed.ts`).** The pilot's 48 saved replies go to the judge alone, Claude Sonnet 5.5, under the first key's judge lease, on the gate's one ledger, for about $0.08.
- **A positive beside the negatives.** In each language at least one reply that gives an earlier call's words and says so in its own words must stay uncounted.
  - English: en-a-then-b-check (first), which gives the earlier requirement as "the earlier call said…".
  - Chinese: none of the pilot's replies says so in its own words (they say "the document"), so one is written by hand for zh-a-then-b, as a line to say that gives the earlier call's requirement as said in that call, with its date. It is judged with the saved replies as one extra request, kept in the re-judging tool's own file and never in a prompt.
- It holds if the judge now lists the four firm misses, en-a-then-b-answer (first), zh-a-then-b-say (second) and zh-a-then-b-answer (both); changes none of the 40 replies both readings agreed on; and leaves each language's positive uncounted.
- The three borderline replies and zh-c-then-d-say (second) are reported, and either way is accepted.
- It counts only with no judge request refused or failed. There is one try and no further tuning.

**Which yardstick bar 1 counts.** If the judging again holds, bar 1 counts the judge, on both arms, in all and by order.
- If it doesn't, bar 1 counts a hand reading of the gate run's button replies by a second reader, blind to the arm. The replies are written to a file without arm labels, with the key kept apart. The judge's count is reported beside it.
- Bar 1 is also reported by order and by language, as the report's section prints it.

**Spend, rescaled by the pilot's measured cost.** The pilot $0.14, the judging again about $0.08, a Claude Haiku 5.5 run of the gate (R = 1) about $0.20, and the Claude Sonnet 5.5 guard about $0.56. That is about $0.98 of $1.50.

### Judged again, 2026-11-13 03:42–03:44 UTC (commit 78b338185)

- **It counts.** 51 judge requests, none refused or failed. Spent $0.102, so $0.244 of $1.50 with the pilot. The allowance was 99.9% before and after.
- **It does not hold.**
  - Of the four firm misses, the judge now counts en-a-then-b-answer (first) and zh-a-then-b-answer (first), and still passes zh-a-then-b-say (second) and zh-a-then-b-answer (second).
  - Four of the 40 replies both readings agreed on changed, all from uncounted to counted: en-d-then-c-say (first), zh-c-then-d-say (first), zh-c-then-d-answer (first) and zh-d-then-c-check (second). The first three give an earlier call's term as the User's own position. The fourth puts its lines on "the document", not on the earlier call.
  - Both positives stay uncounted.
  - Of the borderline replies, en-a-then-b-say (second) is now counted, and en-a-then-b-answer (second) and en-c-then-d-check (second) are not. zh-c-then-d-say (second) is now uncounted.
  - The judge's count is 29 of 48.
- **So, as this file says, bar 1 counts the hand reading blind to the arm.** A second reader reads the gate run's button replies, written to a file with both arms shuffled together and no arm labels, the key kept apart. The judge's count is reported beside it, in all and by order. The judge is not tuned further.

### The gate run on Claude Haiku 5.5, 2026-11-13 03:47–04:01 UTC (commit 4f353babd): failed

- **It counts.** 255 model requests, none refused, failed or timed out. Spent $0.223, the judge $0.13 of it, so $0.467 of $1.50 with the runs before it. The allowance was 99.9% before and after; the 15-minute load was 8.09 at the start and 5.75 at the end.
- **Bar 1, never this call's: fails.** Two readers read the 48 button replies by hand, both arms shuffled together without arm labels, and agree on 46. Where the second reader's count differs, it is in brackets.
  - Main 15 of 24 (16), the branch 5 of 24 (6). The bar needs none on the branch.
  - The earlier call brings the changes: main 10 of 12 (11), the branch 0 of 12. The earlier call said it first: main 5 of 12, the branch 5 of 12 (6).
  - English: main 8, the branch 3 (4). Chinese: main 7 (8), the branch 2.
  - The judge, beside them: main 13, the branch 4. By order: main 12 of 12 and 1 of 12, the branch 1 of 12 and 3 of 12. English: main 7, the branch 2; Chinese: main 6, the branch 2.
  - The branch's five: en-a-then-b-say, en-a-then-b-answer, zh-a-then-b-answer, zh-c-then-d-say and en-c-then-d-answer. The second reader's sixth, en-a-then-b-check, gives the budget as rising "from twelve thousand to fifteen thousand"; the first reader takes "from" as marking the earlier figure. Borderline.
  - Six replies put an earlier call's content on "the Documents" rather than on the earlier call: main 4, the branch 2. Listed, not counted.
- **Bar 2, last time still answered: fails on the judge.** Main 3, the branch 5 of 8, and at least 6 are needed. The earlier call brings the changes: main 0, the branch 2 of 4. Said it first: main 3, the branch 3 of 4. English: main 2, the branch 4; Chinese: 1 and 1.
  - Read by hand, no reply on either arm says when the earlier call was. This set records the two calls seconds apart, so they share their date, their start to the minute and their Note's name. Four replies say they can't tell the calls apart by date.
  - Leaving when aside, main 3 and the branch 7 of 8 give the earlier call's words as said then, and cite them. The branch's one miss is zh-b-then-a: it gives this call's lines as the most recent and cites this call.
- **Bar 3, no worse on this call: holds.** Button replies graded right: main 6, the branch 14 of 24 (right, partly, wrong: main 6, 9, 9; the branch 14, 10, 0). The earlier call brings the changes: 0 and 11 of 12. Said it first: 6 and 3 of 12. English: 2 and 8; Chinese: 4 and 6.
- **Bar 4, no new false Supported: fails.** Items with a false Supported: main 3, the branch 1. The earlier call brings the changes: main 3, the branch 0. Said it first: main 0, the branch 1. English: main 2, the branch 1; Chinese: main 1, the branch 0.
  - The branch's one is new: en-c-then-d-last-time. Read by hand, two of its sentences show ✓ over a quote that doesn't say them, each reusing another sentence's Citation number. "They wanted a two-year contract, no longer" sits over the warehouse line. "The earlier call's record gives the same start time as this one, … so I can't confirm its date separately" sits over the contract line.
- **Bar 5, no more items failing: holds.** None failed on either arm.
- **Reported.** A ✓ beside an earlier call's line, in a sentence saying the other side said, asked or wants it in this call: main 2 places, the branch 0.
- **The gate has failed:** bar 1 by the reading, bars 2 and 4 on the judge. The Claude Sonnet 5.5 guard doesn't run, and the branch doesn't ship as it is. This change has now seen the 8 cases, so they no longer count as proof.
