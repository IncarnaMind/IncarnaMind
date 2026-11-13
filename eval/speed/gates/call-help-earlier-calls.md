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

### The run read again, 2026-11-13: the set recorded both calls in the same minute

- **The set's flaw.** The runner recorded the earlier call and then the live call seconds apart. Both calls started in the same minute, under the same Note name ("Meeting, 13 November"), so their Transcripts had the same name and the same start. No reply could say when the earlier call was, and four "last time" replies say they can't tell the calls apart by date.
- **Bar 2, read strictly by hand:** 0 of 8 on both arms. Leaving "when" aside: main 3, the branch 7 of 8. The judge's 3 and 5 count "when" loosely.
- **The new false Supported** comes from the change through that flaw. The branch sends each call's start, both starts were the same minute, and the reply says so over another sentence's Citation. Its other unsupported sentence has a wrong Citation number.
- **Round 1's verdict stays failed.**

## Round 2, written 2026-11-13, before any of its runs

**Every number before round 2's pilot came from calls recorded in the same minute:** round 1's pilot, its run and their judging again, each under one Note name with one start. The pressure test that found the fault recorded its calls the same day, all named "Transcript · Meeting, 12 November"; its record gives no starts. Compare round 2 with them knowing this.

### What changed, and why

- **The cause, read from round 1's requests.** Every branch press already carried the Answer's rule in its system prompt: give an earlier call's line as said in that call, saying when, and cite it. The button's own instruction, after the Question, said instead: distinguish it from the transcript and cite it. Its form asks for a line said aloud, Citation markers at the end. The branch's five failing replies all distinguish the earlier call by the Citation alone, and the User doesn't say a Citation to the other side. Two of them also put the other side's words in the User's mouth: the buyer's procurement signer given as "our" rollout lead, "our board". Read from round 1 alone, that looked like a slip main never makes. It isn't: with the calls dated, 3 of main's 24 replies in round 2's pilot give the other side's earlier line as ours ("since our board requires it to stay in Europe"). The branch's bar for it stays none.
- **The wording.** The Answer's rule and the button's instruction now carry the same sentence, `EARLIER_CALL_RULE` in `src/core/answers/prompt.ts`: "A Transcript Passage marked call="earlier" is another call, named by its note and started: nothing in it was said in this call. Give its line only as said in that call, saying in the sentence itself who said it and when (the day that call started, or its time when it started the same day as this one), as in "When we spoke on Monday, you said …", and cite it; a sentence that can't say so leaves the line out." Its example is general words, no line of either set's cases or of any reply.
  - The system prompt's line during a call: "A Transcript Passage marked call="this" is this call's: say they or you said something only from call="this" lines." followed by that sentence.
  - The buttons' Documents line: "A Document fact was not said in this call: distinguish it from the transcript, cite it, and never invent one." followed by that sentence.
  - Main's arm (`calls-unmarked`) is sent neither, and its buttons' line is main's, byte for byte (`tests/core/callHelpEarlierCalls.test.ts`).
- **The marks are unchanged.** Every block a Transcript Passage is shown in carries them, the Folder's whole text (`<document-text>`, the block the model is told to answer from) included.
- **The earlier call is dated.** The runner records it on the core's clock set back, then the live call on today's, alike on both arms. Each case's dating is listed in `../earlierCallsRounds.ts`. `tests/eval/earlierCallsSet.test.ts` checks, for each dating, that the press is sent both Notes' names and both starts as recorded, with the live call at 3 pm on 13 November:
  - 6 days before: the earlier call "Meeting, 7 November", started "7 Nov 2026, 3:00 pm"; the live call "Meeting, 13 November", "13 Nov 2026, 3:00 pm".
  - 20 days before: "Meeting, 24 October", "24 Oct 2026, 4:00 pm" (the same instant in summer time); the live call as above.
  - The same day, 3 hours before: both Notes "Meeting, 13 November"; the earlier call started "13 Nov 2026, 12:00 pm", the live call "3:00 pm". The run refuses to start before 04:00, when the earlier call would fall on the day before.

### The pilot: main's path alone, on the first set dated 6 days back

- **Its question.** With the calls days apart, does main still give an earlier call's content as this call's in at least 4 of 24 button replies? If fewer than 4, the fault isn't shown on real dating, and part 2 goes back for a decision, with what it is then for, before any gate run. Otherwise main's rate sizes round 2.
- **The run.** The first set's 8 cases (spent as proof, so they can serve), every earlier call 6 days before its live one. Claude Haiku 5.5, `calls-unmarked` against itself, all 32 items once, with no judge (`INCARNAMIND_EVAL_SPEED_JUDGE=none`). The runner pairs every item, so each item has two samples. The first sample's 24 button replies are read by hand by two readers and decide the question; the second's are reported, for the rate.
- **It counts** only with none of its requests refused, failed or timed out.

### The pilot, read: 2026-11-13 04:42–04:53 UTC (commit 372b32326)

- **It counts.** 256 model requests, none refused, failed or timed out. Spent $0.091, so $0.558 of $1.50 with round 1.
- **The fault is shown on real dating.** Two readers read each sample's 24 button replies by hand. Neither reading is blind to the arm: there is one arm. They agree on 43 of the 48.

| Main's button replies | First sample (decides) | Second sample (for the rate) |
|---|---|---|
| An earlier call's content given as this call's, both readers | 8 of 24 | 5 of 24 |
| The same, either reader | 11 | 7 |
| Clear to both, neither marking it borderline | 6 | 3 |
| Put on "the Documents" or "the record", both readers | 2 | 3 |
| An earlier line of the other side given as ours, both readers | 3 | 1 |

- **Where it is, both readers.**

| | First sample | Second sample | Round 1's main, calls in the same minute |
|---|---|---|---|
| The earlier call said it first | 5 of 12 | 4 of 12 | 5 of 12 |
| The earlier call brings the changes | 3 of 12 | 1 of 12 | 10 of 12 |
| "What should I say?" | 4 of 8 | 2 of 8 | |
| "Answer their question" | 4 of 8 | 2 of 8 | |
| "Check what was said" | 0 of 8 | 1 of 8 | |
| English | 4 of 12 | 2 of 12 | |
| Chinese | 4 of 12 | 3 of 12 | |

  - Real dates alone take most of main's faults away in the order where the earlier call brings the changes, and leave the other order's as they were.
  - All but one fault are in the options of the two option buttons. The check lines give the earlier call by its date.
  - Each of the first sample's 8 "last time" replies gives the earlier call with its date and cites it, so bar 2 sits at its ceiling on main.
- **What it sizes.** At these rates main's expected count over round 2's 36 button presses (24 in the order where the earlier call said it first, 12 in the other) is about 11, so one Claude Haiku 5.5 run.
- **Where the rule was hard to read**, for round 2's readers:
  - The "→" line under an option counts as the reply's own words.
  - Past tense with no marker ("the twelve thousand we discussed", "still on the table").
  - An earlier fact assumed rather than stated ("the Eastbrook clinic delivery"), against one asked about ("whether the Eastbrook clinic should be the delivery point").
  - An earlier question of the other side turned into the User's own.
  - "The 7 November notes" and "文档中 11 月 7 日的会议": a record, or a meeting kept in the Documents.

### The cases

- A new set, `../callHelpEarlierCalls2.ts` (`EARLIER_CALL_CASES_2`), written blind to the change and its replies by another writer and checked, and put in that file only for the gated run. The file holds no cases until then, and a run of the set (`call-help-earlier-calls-2`) refuses to start without them. The results record the file's SHA-256.
- Three pairs of calls (e and f, g and h, i and j), each in English and Chinese and in both orders: 12 cases, ids like `en-e-then-f`.
- **Dated by pair:** e and f 6 days before the live call, g and h 20 days before, i and j the same day 3 hours before. On the same day the two Notes share their name, and only the start tells them apart.
- **Orders, by this list, not by the ids' letters.**
  - The earlier call said it first, and the live call asks something it seems to answer: e-then-f, g-then-h, i-then-j and j-then-i. The third pair is two-sided, so this is 8 of the 12 cases.
  - The earlier call brings the changes: f-then-e and h-then-g, 4 cases.
- Buttons as in round 1, "What should I say?", "Answer their question" and "Check what was said", plus the typed "What did they say last time?": 48 items.

### The bars

As committed for round 1, except as said here. Every count is given in all, by the order of the two calls and by language.

1. **Never this call's.** Two readers count it by hand, blind to the arm, with the judge's count beside theirs.
   - A reply counts when it gives something only the earlier call holds as said, asked or wanted in this call, or as a settled fact, a requirement or where the other side stands, without its own words saying it comes from the earlier call.
   - From this round on, a reply that puts an earlier call's content on "the Documents" or "the record" instead of the earlier call also counts: a thing said in a call is not a record, and the User may repeat it to the other side as one. The count is given both ways, so the rounds compare.
   - Main's arm must show at least 4, and the branch none.
   - **Counted apart, beside it: an earlier line of the other side given as ours.** For example, the buyer's signer given as "our" rollout lead. The readers mark it per reply. The bar for it is none on the branch, with main's count reported.
2. **Last time still answered,** by the two readers. A reply is answered when it does all four:
   - gives what the earlier call held;
   - says it was then;
   - says when, by its day, or by its time when the two calls share a day;
   - cites the earlier call.
   On the branch, no fewer than main and at least three quarters (9 of 12), with the judge's count beside.
3. **No worse on this call,** by the judge's grade, as committed.
4. **No new false Supported,** repaired for this round and said before it runs:
   - the branch has no more items with a false Supported than main;
   - each of the branch's is read by hand and listed;
   - one the change caused fails the bar, whatever the count.
   Round 1's bar 4 stays failed as written.
5. **No more items failing to run.**

**Where the two readers differ.** A reply the two readers read differently goes to a third reader before the arms are known, who sees only the reply and the calls. Two of three readings decide, for a fault, for the kind counted apart, and for whether a "last time" reply is answered. The bars are read on that settled count, and each reply settled this way is listed with its three readings. A reply isn't counted against the change just because the readers differ: they differ on about 1 reply in 10, and with a bar of none one borderline reading would decide the round. Nor is a difference settled after the key is opened, when the arm is known.

**Frozen.** What the branch sends is frozen for round 2 at commit 372b32326. Later commits change only this gate's files and the evaluation's code. The results name both commits: the frozen one and the one the run used.

### Models, judges, keys

- **Claude Haiku 5.5 first, both arms:** one run of the 48 items, judged by Claude Sonnet 5.5. The pilot gives main about 11 expected over 36 presses, well over 6.
- **The Claude Sonnet 5.5 guard** runs only if every Haiku bar holds. It takes the pair dated 6 days back, e and f: its 4 cases' 12 button presses, both arms, one run (`INCARNAMIND_EVAL_SPEED_ITEMS` naming the 12).
  - Its judge can't be Claude Sonnet 5.5, a model under test, and no request goes to Claude Opus or Claude Fable. So the guard is judged by Claude Haiku 5.5.
  - Its bar 1, the kind counted apart and each of its false Supported are read by hand, as in the Haiku run. Only the grade (bar 3) rests on Claude Haiku 5.5, and the pull request says so.
- **One route, a second key.** Round 2 runs on a second direct Anthropic key with its own limit: its lock for each run's length, with the judge's nested inside, and its allowance read before each run. Round 1 and the pilot ran on the first key: the same provider, model and route; only the limit differs.

### Spend, from round 1's measured cost

Round 1's Haiku run measured, caching included: $0.0008 a button reply, $0.0034 a typed one, $0.002 a reply for the Sonnet judge. Claude Sonnet 5.5 is priced at 20 times Claude Haiku 5.5. With the same caching, that is about $0.017 a button reply.

| Step | Size | Estimate | Stop |
|---|---|---|---|
| Pilot | 32 items, main against itself, no judge | spent $0.091 | |
| Claude Haiku 5.5 run | 48 items, both arms, judged by Claude Sonnet 5.5 | $0.34 | $0.45 |
| Claude Sonnet 5.5 guard, only if every Haiku bar holds | 12 button items, both arms, judged by Claude Haiku 5.5 | $0.40 | $0.50 |

- **Each step's stop is on the ledger's total** (`INCARNAMIND_EVAL_SPEED_STOP_USD`), the one ledger for rounds 1 and 2:
  - the Haiku run's is $0.558 + $0.45 = $1.008;
  - the guard's is the ledger's total after the Haiku run + $0.50, never above $1.50.
- **Anything past $1.50, a rerun included, needs the owner's yes first.**

### Round 2's Claude Haiku 5.5 run, 2026-11-13 07:08–07:28 UTC: failed

The request was frozen at 372b32326. The run used af715cd6f, with the set file put in.

- **It counts.**
  - 48 items, both arms: 96 presses, all done.
  - The record holds 377 requests under them, all finished: 374 to Claude Haiku 5.5 and 3 local Transcript reads. All 96 judge readings came back, none failed.
  - The arms alternated: each went first in 24 pairs, 12 in each language.
  - It ran on the second direct Anthropic key, its allowance at 100% before and after on both models.
  - The set file's SHA-256: 2d70668d2087706c978b3c843fe6061aefec642d786446e0c1bdb11a36ffec95.
- **Spent** $0.366, the judge $0.22 of it, so $0.924 of $1.50 with the runs before it. The stop was $1.007.
- **The readings.** Two readers read the 72 button replies and the 24 "last time" replies blind to the arm. Both arms were shuffled together, without the Citations' source labels.
  - They agree on 88 of the 96, all 24 "last time" replies among them.
  - A third reader read the 8 button replies they differ on before the key was opened, seeing only the replies and the calls. Two of the three readings settle each one, as listed below.
- **What the first reader saw before reading.** While that reader counted the run's requests, a search printed four lines of the report's table by arm: judged right, another guard failed, failed to run. It showed no reply's arm. No final reading rests on that reader alone: the 88 agreed replies carry the second reader's reading too, and the third reading decided the 8.
- **What the scorer saw.** While the scorer checked the record before the readings, a search of theirs printed three of the judge's listed replies with their arms. The scorer reads none of the replies, and no reading rests on them.

**Bar 1, never this call's: fails.** The branch shows 10 by round 2's way and 9 by round 1's, and the bar is none. Main shows 21, so the fault is shown (at least 4).

| | main, round 2's way | the branch, round 2's way | main, round 1's way | the branch, round 1's way | the judge, main | the judge, the branch |
|---|---|---|---|---|---|---|
| All, of 36 | 21 | 10 | 15 | 9 | 9 | 8 |
| The earlier call said it first, of 24 | 16 | 9 | 13 | 9 | 8 | 8 |
| The earlier call brings the changes, of 12 | 5 | 1 | 2 | 0 | 1 | 0 |
| English, of 18 | 11 | 3 | 9 | 3 | 5 | 3 |
| Chinese, of 18 | 10 | 7 | 6 | 6 | 4 | 5 |

- Round 2's way also counts a reply that puts an earlier call's content on "the Documents" or "the record": main 6, the branch 3.
- The branch's 9 by round 1's way, by button: "Answer their question" 6 of 12, "Check what was said" 2 of 12, "What should I say?" 1 of 12. They are mostly answers that use a fact the earlier call holds, and this call hasn't changed, with no word that it is from before.
- In 9 of the branch's 10, the line at fault cites the earlier call's Transcript. The tenth, en-i-then-j-say, has no Citation.
- **en-g-then-h-check, main's.** Its Citations couldn't be asked for: the model's reply reached its output limit of 450 tokens. The press finished, and the panel showed its lines without Citations: no number, no ✓, no source and no error. It is counted as the User saw it. Under bar 1 its text puts the earlier call on "the 24 October notes", so it counts by round 2's way and not round 1's (settled by the third reading).

**Counted apart, an earlier line of the other side given as ours: fails.** Main 3, the branch 4; the bar is none on the branch.

| Cut | main | the branch |
|---|---|---|
| The earlier call said it first | 2 | 4 |
| The earlier call brings the changes | 1 | 0 |
| English | 3 | 1 |
| Chinese | 0 | 3 |

**Bar 2, last time still answered: holds.** All four, by the settled readings: main 8 of 12, the branch 11 of 12 (at least 9 needed, and no fewer than main). The judge's count beside: main 8, the branch 11.

| Cut | main | the branch |
|---|---|---|
| The earlier call said it first | 4 of 8 | 7 of 8 |
| The earlier call brings the changes | 4 of 4 | 4 of 4 |
| English | 4 of 6 | 6 of 6 |
| Chinese | 4 of 6 | 5 of 6 |

- **With and without the three replies whose text names a call's start time.** All three are the branch's:
  - zh-g-then-h-last-time: "通话开始于 2026 年 10 月 24 日";
  - en-j-then-i-last-time: "started at 4:24 am on 13 November, earlier the same day";
  - en-i-then-j-last-time: "started at 4:22 am the same day".
  Only the branch is sent start times, so a reader could have taken them for the branch's.
- Without them, main is 8 of 12 and the branch 8 of 9, so the bar holds both ways. The judge's count without them is the same.

| Cut, without the three | main | the branch |
|---|---|---|
| The earlier call said it first | 4 of 8 | 4 of 5 |
| The earlier call brings the changes | 4 of 4 | 4 of 4 |
| English | 4 of 6 | 4 of 4 |
| Chinese | 4 of 6 | 4 of 5 |

They are "last time" replies, so bar 1 doesn't change without them.

**Bar 3, no worse on this call: holds,** on the judge's grade. Button replies graded right: main 15, the branch 24 of 36 (right, partly, wrong: main 15, 19, 2; the branch 24, 9, 3).

| Cut | main | the branch |
|---|---|---|
| The earlier call said it first, of 24 | 8 | 12 |
| The earlier call brings the changes, of 12 | 7 | 12 |
| English, of 18 | 5 | 13 |
| Chinese, of 18 | 10 | 11 |

**Bar 4, no new false Supported: fails on the count.** Items with a false Supported: main 1, the branch 2, so the branch has more than main.

| Cut | main | the branch |
|---|---|---|
| The earlier call said it first | 0 | 1 |
| The earlier call brings the changes | 1 | 1 |
| English | 0 | 1 |
| Chinese | 1 | 1 |

The branch's two, for the reading by hand of whether the change caused them:
- **en-f-then-e-answer.** "Our installers can work after 10pm, so we can schedule the install plan around your closing time" sits over this call's line "Your installers can only come in after ten at night". The restriction is given as a capability. The quote is this call's line, not an earlier call's.
- **zh-j-then-i-answer.** "我们目前每本说明书发货前由桐垭经销点的邬敏过一遍" sits over the earlier call's line "每本说明书发货前，都由我们桐垭经销点的邬敏看一遍". The other side's earlier line is given as ours and current. It is cited to the earlier call, and its words are found, so it shows ✓.
- en-g-then-h-check shows no ✓, so it has none.

**Bar 5, no more items failing: holds.** None failed to run on either arm, in any cut. en-g-then-h-check ran and showed its reply.

**Settled by the third reading.** For each reply: the marks of the first, second and third readings, then the settled one. "as this call's" is bar 1 by round 1's way, "Documents" what round 2's way adds, "ours" the kind counted apart.
- zh-h-then-g-check, main. Documents: no, yes, yes; settled yes. As this call's: no by all three.
- en-g-then-h-check, main. Documents: no, yes, yes; settled yes. As this call's: no by all three.
- zh-g-then-h-check, the branch. As this call's: yes by all three. Documents: no, yes, yes; settled yes.
- en-j-then-i-say, main. As this call's: yes by all three. Ours: no, yes, yes; settled yes.
- en-e-then-f-answer, the branch. As this call's: yes by all three. Ours: no, yes, yes; settled yes.
- zh-f-then-e-check, main. Documents: no, yes, yes; settled yes. As this call's: no by all three.
- en-f-then-e-answer, main. As this call's: yes, no, yes; settled yes.
- en-e-then-f-answer, main. As this call's: no, yes, yes; settled yes.

**Reported.**
- A ✓ beside an earlier call's line, in a sentence putting it on this call: main 0 places, the branch 0.
- One judgement of text beside a Citation wasn't decided, against 7 in round 1 and 9 in the pilot.

**Round 2 has failed.** Bar 1 fails on the branch (10 by round 2's way, 9 by round 1's), the kind counted apart fails (4), and bar 4 fails on the count. Bars 2, 3 and 5 hold.
- Where the earlier call brings the changes, the branch shows none by round 1's way. Main shows 2 there now that the calls are dated.
- Where the earlier call said it first, the branch shows 9 of 24 and main 13 of 24.
- The Claude Sonnet 5.5 guard doesn't run, and nothing ships from the branch as it is.
