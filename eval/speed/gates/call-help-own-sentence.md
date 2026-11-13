# The gate for call help giving what it cites a sentence of its own (#2847)

Written and committed on 2026-11-13, before any run it gates. Ruled on #3003: a ✓ means the cited words say everything its sentence claims, so no ✓ stands beside a sentence that adds the reply's own advice, conclusion or "no". The fact keeps its ✓ when call help gives it a sentence of its own. The check then never reads the part it can't judge. On saved presses that was the shape of 46 of the 62 places the check got wrong, and of the three faults the check's second wording left ("…7 am to 5 pm, so not at night", "…and they agreed").

## The change

Only what call help is asked to write. The sentence check, the panel and the ✓ rule are `main`'s as they are.

- **Options** (say, answer, no, objection, next step, ask, follow-up, leading): what the User could say is at most two short sentences and 25 words in all, where it was one sentence of at most 25.
- **Short lines** (sum, check, facts, not covered, decisions, disagree): each line is at most two short sentences and 20 words in all, where it was one sentence of at most 20.
- **Both shapes add one rule:** "What the Documents or the call say goes in a sentence of its own, its Citation markers at that sentence's end. What is the User's own (advice, a conclusion, a "no", an offer or a plan the Documents don't state) goes in another sentence with no Citation marker. Never join the two with "so", "and", "but" or a comma, in any language."
- **The check button's task** gives a claim as it was said, cited to the transcript, then what the Documents say about it, cited to them, or that they don't say. It was "a claim, then whether the Documents support it, contradict it or don't say": a verdict in a sentence that cites one side.
- **The examples, in their own general words** (none of them a case's sentence):
  - English option: "★ We can't go below list for Enterprise. We can extend the pilot to 60 days [^1]". It was "…for Enterprise, but we can extend…".
  - Chinese option: "★ 企业版价格没法低于标价。我们可以把试用延长到 60 天 [^1]". It was "…低于标价，但我们可以…".
  - English line: "- The launch moves to 18 November [^1]. Support should hear this week". It was the cited half alone.
  - Chinese line: "- 上线推迟到 11 月 18 日 [^1]。这周要通知客服". It was the cited half alone.
- **A reading** (what they want) is unchanged: it already gives its moment, cited, on a line of its own.

### For a ruling: the check button's line

The committed task line (A) drops the verdict: the line gives the claim and what the Documents say, and the User works out "right" or "wrong". On a live call the User pressed that button to be told which, at a glance. The second wording (B, recommended in review) keeps the verdict as a sentence of its own with no Citation, the same rule as an option's "no". Nothing is changed until the ruling.

| | A, as committed | B, the verdict a sentence of its own |
|---|---|---|
| Task line | "Check the newest claims in the transcript against the User's Documents: each line gives a claim as it was said, cited to the transcript, then what the Documents say about it, cited to them, or that they don't say." | "Check the newest claims in the transcript against the User's Documents: each line starts with the verdict, a sentence of its own with no Citation ("Right.", "Wrong." or "The Documents don't say."), then what the Documents say, in a sentence of its own with its Citation. Restate the claim only as far as the line needs." |
| English example | "- They said the pilot is free for 90 days [^1]. The terms give 60 days [^2]" | "- Wrong. The terms give the pilot 60 days [^1]" |
| Chinese example | "- 对方说试用期免费 90 天 [^1]。条款写的是 60 天 [^2]" | "- 错。条款写的是试用期 60 天 [^1]" |

- **Under A,** both sentences are cited, and the check reads each against its own quote.
- **Under B,** only the Documents' sentence is cited. The verdict is never checked, as an option's "no" isn't, so a wrong verdict would show with no mark. "The Documents don't say." is a whole line with no Citation.
- **B needs the check button's own example lines,** where today every short-line button shares one. That is a change to the examples only, under the same switch.

### What is sent, against main

For the answer button in an English call, the `<help>` block differs in these lines and no other:

```
< - Each option is two lines: what the User could say, as they would say it aloud, one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote), its Citation markers at its end; then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.
> - Each option is two lines: what the User could say, as they would say it aloud, at most two short sentences and 25 words in all, with no quotation marks around it (the panel shows it as a quote); then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.
> - What the Documents or the call say goes in a sentence of its own, its Citation markers at that sentence's end. What is the User's own (advice, a conclusion, a "no", an offer or a plan the Documents don't state) goes in another sentence with no Citation marker. Never join the two with "so", "and", "but" or a comma, in any language.
< ★ We can't go below list for Enterprise, but we can extend the pilot to 60 days [^1]
> ★ We can't go below list for Enterprise. We can extend the pilot to 60 days [^1]
```

A short line's button changes its shape line the same way ("each one sentence of at most 20 words, its Citation markers at its end" becomes "each at most two short sentences and 20 words in all", followed by the rule). It also changes its example line. The check button's task line changes too. A Chinese call gets the same lines with the Chinese examples. A reading's instructions don't change.

### Main at the run

- **The gate's `main` must hold two changes**, and the run names the commit:
  - #3005 part 2 (how call help treats an earlier call's lines), which also changes what call help is asked;
  - the fix for a sentence-check reply that corrects itself (#3029), so a reply that holds a corrected answer is read by it on both arms.
- The branch takes `main` after both merge.
- Neither change touches an instruction sentence the other does. #3005 part 2 edits "A Document fact was not said in this call…". This change edits the option and line shapes, their examples and the check button's task. Both add a parameter to `meetingHelpInstructions`, a line to its doc comment and a parameter to the test helper, which merge by hand.
- After the merge:
  - `tests/core/callHelpOwnSentence.test.ts`'s hash of main's instructions is set again from that commit;
  - the record's reading of each check reply (`checkReplies` in `../arms.ts`) takes the check's own new reader;
  - every unit test of call help runs again before the run.

## Arms, models, judge and the runs' rules

- **Arms**, paired and alternated per cell as `../README.md` › Paired runs says:
  - `call-help-writing-as-before`, `main`'s writing, through the evaluation switch `callHelpWritingAsBefore`. It sends `main`'s instructions byte for byte for every button, language and found-ahead state (`tests/core/callHelpOwnSentence.test.ts`).
  - `today`, this branch.
  - Both arms judge with `main`'s sentence check as it is.
- **Models:** Claude Haiku 5.5, then Claude Sonnet 5.5, each as the Answers model with call help on Same as Answers. Sonnet runs only if every bar holds on Haiku.
- **Judge:** Claude Sonnet 5.5, never Claude Fable 5 or Claude Opus.
  - One request a press grades the reply against the expected answer.
  - A second reads each place on its sentence and quotes alone.
  - Its count of wrong ✓ goes beside the hand reading's, never instead. On the earlier trial it agreed with the hand reading on 58 of 78 places, and called advice and conclusions backed.
- **The yardstick for a wrong ✓ is the hand reading by place, blind to the arm.**
  - A script builds the reading file. It holds every place of both arms whose quote was found, shuffled together, unlabelled: the sentence, every quote it cites, and how many of its places show ✓. The same sentence with the same quotes is read once.
  - **Two readers fill their own copy** of the same file: the coordinator, and an independent reader who sees only that file. The bars count the coordinator's reading. The two readings' agreement, by label and by side (backed, unbacked, borderline), is reported beside them, with every item they differ on.
  - The key, which arm, press and place each item is, goes in a folder apart. Neither reader opens it until both readings are sent.
  - The labels are: right; claims nothing or restates; fault; own conclusion; own advice or plan; own no; call claim outside the quoted words; borderline.
  - Unbacked: fault, the three own labels and a call claim. Backed: right and claims nothing. Borderline counts in neither.
- **Each run:**
  - holds the lease of the key the lead names for its whole length, with that key's judge lease nested inside it;
  - reads the allowance first and starts only above 90%;
  - starts only at a 15-minute load of 24 or less;
  - sends at most four requests at once;
  - runs directly, never through the build queue, with its PID in a file from its start;
  - goes one after another with the other runs.
- **A run counts only with zero requests refused, failed or timed out**, the judge's included. A void run is kept and struck with its reasons. It is not run again before those are read.
- **A sentence-check reply the check couldn't read voids nothing.** The record keeps every check reply as the check read it (`checkReplies`). One that read fewer sentences than it was asked is listed apart, with its arm and the reply as written. Its places count as the User sees them: Not checked, with no ✓.

## Phases, each with its own stop

1. **The dev trial: fresh presses of known cases.**
   - **Presses:** 24 cases of `call-help-marks-3`, 12 English and their Chinese twins, one run each, on both arms and both models: 96 presses.
   - **Probes** (main's writing joined a cited fact to the reply's own part on these cases in the earlier gates): `answer-unknown`, `sum`, `no-price`, `say-outage`, `check-wrong`, `say-roof`.
   - **Positives beside them**, where a cited fact alone is the right reply: `answer-price`, `answer-relief`, `answer-two`, `check-right`, `ask-shops`, `answer-earlier`.
   - **What it decides:** the bars below are read and reported, and gate nothing. The instructions may change on what the trial shows. They are then frozen at a commit this file names before the gate, and the gate runs only on a yes.
   - **Before #3005 part 2?** Asked in the ruling. These cases hold no earlier call and the trial gates nothing, so it could run on today's `main`. The gate runs only after both changes above merge.
   - **Stop $1.40.** Without the judge's per-place request, which gates nothing here, about $0.92: the grade request stays.
2. **The gate: held-out presses.**
   - **The cases** are written blind to this change by someone else, put into `../callHelpMarks4.ts` at the run, and not opened before it. Its needs are listed below.
   - **Runs:** two of every case, both arms, Haiku and then Sonnet.
   - **Stop $3.20.**

### What the held-out cases need, to be checked before the run

- They are call-help presses in `CallHelpCase`'s format, not single sentences: the Documents, the call's turns, the expected answer and the lines it rests on.
- There are 15 English presses with a Chinese twin each, and at least 12 a language.
- **Buttons:** at least 8 a language with options (say, answer, no, objection, next step, ask), at least 3 with short lines (sum, check, facts), and no more than 2 readings (what they want), which this change leaves alone.
- **No bar's power rests on the short-line presses.** Bar 2 is read by cell over the probe presses, whatever their shape. G2 is an upper bound over every line of a cell. With 3 short-line presses a language, what the short-line shape does alone (6 presses a cell over two runs) is reported and gates nothing.
- **Probes of the named kind**, at least 6 a language: a press whose natural reply joins a cited fact to a short conclusion, a "no", advice or a verdict of the reply's own ("…, so …", "…, and they agreed", "…, which the sheet contradicts"). Their ids are given at the run.
- **Positives**, at least 6 a language: a press whose right reply is a cited fact with nothing of the reply's own.

## The bars, set before any run and never moved after

Counted per model, pooled over both languages and both runs (60 presses an arm in the gate) unless a cell is named. A cell is a model and a language. The hand reading is the coordinator's. Everything else is counted by the scoring script from the record and that reading.

1. **The change takes away wrong ✓.** The branch's presses with a ✓ beside an unbacked place are at most half of main's writing's, rounded down, and at most 1 where main's is under 4. This is #2847's bar 1a in form. Main's own spread between its two runs, its flips, is reported beside it; in #2847's third gate it was 7 presses on each model.
2. **The tacked-on part lands in the sentence with no Citation.** In each cell, on the probe presses over both runs, at most 1 cited place on the branch holds the reply's own conclusion, advice, "no" or a fault. Main's writing's count is reported beside it.
3. **What main's check still marks wrongly, on the branch's own replies**, as #2847's bar 1a reads it by place.
   - W0 counts the presses with a found place the hand reading calls unbacked. W1 counts those where such a place shows ✓. W1 is at most half of W0, rounded down, and at most 1 where W0 is under 4.
   - **The check's wording comes back** only if this bar fails. It is then measured on these presses.
   - With bar G5 it is also what closes #2847.

The guards, so the writer doesn't meet the rule by saying less:

- **G1, backed facts keep their ✓.** The branch's backed places with ✓ are no fewer than main's writing's, less the ✓'s own noise: at least 2, or main's count times the rate below, rounded up, whichever is larger. The rate is the share of places whose mark changed between two samples of the same check on the same replies: Claude Haiku 5.5, 19 of 264 places (7.2%); Claude Sonnet 5.5, 3 of 162 (1.9%).
- **G2, at most two short sentences, within the shape's length.** In each cell:
  - at most 2 of the branch's option lines or short lines run over two sentences;
  - at most 2 run over their shape's length, as the instructions say: 25 words for an option and 20 for a short line, or in Chinese 50 and 40 characters.
- **G3, the answer's grade, as #2847's bar 3 says.** In each cell: cited, judged right, and every Citation found. Each is no lower on the branch than on main's writing by more than the allowance:

  | Cell | Cited | Judged right | Every Citation found |
  |---|---|---|---|
  | Sonnet · English | 2 | 2 | 2 |
  | Sonnet · Chinese | 2 | 2 | 2 |
  | Haiku · English | 4 | 2 | 2 |
  | Haiku · Chinese | 4 | 8 | 4 |

  These come from three runs of main judged by Claude Opus 5.5; here Claude Sonnet 5.5 judges both arms alike.
- **G4, the time, as #2847's bar 4 says.**
  - **4a:** in every pair, the first request is the same on both arms but for the button's instructions, the `<help>` block (`sameSetup` and `sameOutsideHelp`).
  - **4b:** in each cell, for first words and for the reply's end, the branch is slower in a count of untied pairs that a one-sided sign test gives a chance under 1% fails the bar: at 30 untied pairs that is 22 or more, at 28 it is 21, at 26 or 27 it is 20.
- **G5, Chinese no worse than English beyond the run's own chance.** The branch's Chinese W1 is no higher than its English W1 plus its own flips. Its flips are the larger language cell's count of presses whose W1 differs between the two runs.
- **G6:** no press fails on the branch where main's writing finished it.

Every bar must hold on both models. A failed bar keeps the change from shipping, and the numbers go on #2847. Nothing ships from the dev trial alone.

### The ✓'s settle time: reported here, with the reading that can tell a tenth

On the sentence check's dev trial (#3003), the rule as before ran in two trials an hour apart, on the same 180 sentences. Two samples of one rule were apart by:

| Statistic | Claude Haiku 5.5 (119 pairs) | Claude Sonnet 5.5 (60 pairs) |
|---|---|---|
| The median of each sample | −2.9% | +5.6% |
| The median of paired ratios | +4.2% | 0.0% |
| The 20% trimmed mean of the paired log ratios | +4.5% | −0.6% |

Between two rules in the same run, the median of each arm and the median of paired ratios changed places between the two trials. On Haiku the median of each arm gave +6.2% and then +20.3%, the paired ratios +14.6% and then +7.2%.

- **The statistic:** the median of paired ratios, each pair pressed back to back with the order alternated, read with a 95% bootstrap interval. Pairing takes out a press's own speed, and the median takes out its slowest few.
- **How many pairs a tenth needs:** resampling one run's pairs gives that interval's half-width as about ±8% to ±15% at 60 pairs, ±6% to ±8% at 120, and ±2% to ±5.5% at 240, on either model. The trimmed mean is no narrower.
- **So a tenth can be read only on 240 pairs or more a model.** This gate has 60 a model. The ✓'s settle time is reported here with its interval and gates nothing. The time bars are #2847's 4a and 4b above.

## Size

Anthropic's prices don't change by the hour, so the hour's price is the list price. The estimates come from #2847's third gate's ledger: Claude Haiku 5.5 $0.78 for 120 presses, of which the judge took $0.71; Claude Sonnet 5.5 $2.01, of which the judge took $0.61. Adjusted for both arms now running the check, and for a judge on Claude Sonnet 5.5 at half Claude Opus 5.5's price with one more short request a press:

| Phase | Presses | Requests, Haiku | Requests, Sonnet | Estimate | Stop | Items to read blind |
|---|---|---|---|---|---|---|
| Dev trial | 96 | about 100, and 96 the judge's | about 120, and 96 the judge's | $1.00 ($0.92 without the per-place request) | $1.40 | about 175, by each of two readers |
| Gate | 240 | about 250, and 240 the judge's | about 300, and 240 the judge's | $2.55 | $3.20 | about 430 (Haiku's about 215 first), by each of two readers |

- The requests by model count the product's reply and check on the model under test. The judge's requests are all on Claude Sonnet 5.5.
- The items to read are about 1.8 a press, as on the saved presses.
- #2847 was at $4.11 of its $8 before this file. Both phases at their estimates bring it to $7.66.

## What can't be known before the run

- How often each model splits an option as asked, or writes the second sentence with a Citation after all.
- Whether an option with two sentences reads as well aloud in a second or two. The grade sees part of that, and nothing in the record sees all of it.
- Whether a shorter cited sentence passes the check more often, or the own sentence drops a fact the expected answer needs.
- How the check button's lines read without a verdict word, and whether the User misses it.
- How the held-out cases split between options and lines, until they are checked against what they need.
- Whether #3005 part 2 changes how often an option cites the call.
