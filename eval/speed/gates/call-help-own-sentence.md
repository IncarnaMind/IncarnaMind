# The gate for call help giving what it cites a sentence of its own (#2847)

Written and committed on 2026-11-13, before any run it gates. Ruled on #3003: a ✓ means the cited words say everything its sentence claims, so no ✓ stands beside a sentence that adds the reply's own advice, conclusion or "no". The fact keeps its ✓ when call help gives it a sentence of its own. The check then never reads the part it can't judge. On saved presses that was the shape of 46 of the 62 places the check got wrong, and of the three faults the check's second wording left ("…7 am to 5 pm, so not at night", "…and they agreed").

## The change

Only what call help is asked to write. The sentence check, the panel and the ✓ rule are `main`'s as they are.

- **Options** (say, answer, no, objection, next step, ask, follow-up, leading): what the User could say is at most two short sentences and 25 words in all, where it was one sentence of at most 25.
- **Short lines** (sum, check, facts, not covered, decisions, disagree): each line is at most two short sentences and 20 words in all, where it was one sentence of at most 20.
- **Both shapes add one rule**, as frozen after the development trial (below): "What the Documents or the call say goes in a sentence of its own, its Citation markers at that sentence's end. Every fact in that sentence is in the words it cites: a second fact gets a Citation of its own, to the words that state it. What is the User's own (advice, a conclusion, a "no", an offer or a plan the Documents don't state) goes in another sentence with no Citation marker: it cites neither the question it answers nor the rule it rests on, and that rule is a cited sentence of its own. End the cited sentence with "." or "。" before the User's own part: joined by anything else (", so", ", but", "，", a dash, a semicolon) it is still the cited sentence. A "→" line never has a Citation marker."
  - The trial ran an earlier form: "…at that sentence's end. What is the User's own (…) goes in another sentence with no Citation marker. Never join the two with "so", "and", "but" or a comma, in any language."
- **The check button's line** starts with its verdict, "Right." or "Wrong." ("对。" or "不对。" in Chinese), a sentence of its own with no Citation. The Documents' fact follows in a sentence of its own with its Citation. Where the Documents don't speak to the claim, the line says so in one sentence with no Citation ("The Documents don't say …", "文档没有提到…") and cites nothing. It was "a claim, then whether the Documents support it, contradict it or don't say": a verdict in a sentence that cites one side.
  - The task line: "Check the newest claims in the transcript against the User's Documents. Each line starts with the verdict, "Right." or "Wrong." (in Chinese "对。" or "不对。"), a sentence of its own with no Citation; then what the Documents say, in a sentence of its own with its Citation. Where the Documents don't speak to the claim, the line says so in one sentence with no Citation ("The Documents don't say …"; in Chinese "文档没有提到…") and cites nothing. Restate the claim only as far as the line needs."
  - The Chinese words are "对。" and "不对。", the plain spoken way to say right and wrong, where "错。" alone reads curt on a line the User reads mid-call. "文档没有提到" says plainly that the Documents are silent. 无依据 and 与文档矛盾 stay the names of a check's results (`docs/agents/zh-CN.md`, one word for one thing).
  - The verdict is a word no check reads, as an option's "no" isn't checked: the hand reading counts a verdict that disagrees with its fact or the Documents (G7).
  - The check button has example lines of its own (below), where every other short-line button shares one.
- **The examples, in their own general words** (none of them a case's sentence):
  - English option: "★ We can't go below list for Enterprise. We can extend the pilot to 60 days [^1]". It was "…for Enterprise, but we can extend…".
  - Chinese option: "★ 企业版价格没法低于标价。我们可以把试用延长到 60 天 [^1]". It was "…低于标价，但我们可以…".
  - English line: "- The launch moves to 18 November [^1]. Support should hear this week". It was the cited half alone.
  - Chinese line: "- 上线推迟到 11 月 18 日 [^1]。这周要通知客服". It was the cited half alone.
  - The check button's English lines: "- Wrong. The terms give the pilot 60 days [^1]", "- Right. The contract renews each January [^1]", "- The Documents don't say anything about training".
  - Its Chinese lines: "- 不对。条款写的是试用期 60 天 [^1]", "- 对。合同每年一月续签 [^1]", "- 文档没有提到培训".
- **No example's content is in a case.** Every example line (options, readings, short lines and the check lines, in both languages) was compared with the 24 dev-trial cases and the rest of `call-help-marks-3`, and with `call-help-marks`. Each line's subjects, figures, dates and names were searched for in the cases' Documents, turns and expected answers.
  - None of them appears in a case.
  - Shared are only the verdict words themselves (the check cases' expected answers start "Wrong:" or "不对："), and common words used about other things ("included" in "included in the service plan", "your team" in "Can your team work on the roof").
  - A first wording of the "don't say" line, about whether training "is included", was dropped for that overlap.
  - The held-out slice is checked by whoever holds it, who isn't this file's writer.
- **A reading** (what they want) is unchanged: it already gives its moment, cited, on a line of its own.

### What is sent, against main

For the answer button in an English call, the `<help>` block differs in these lines and no other:

```
< - Each option is two lines: what the User could say, as they would say it aloud, one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote), its Citation markers at its end; then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.
> - Each option is two lines: what the User could say, as they would say it aloud, at most two short sentences and 25 words in all, with no quotation marks around it (the panel shows it as a quote); then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.
> - What the Documents or the call say goes in a sentence of its own, its Citation markers at that sentence's end. Every fact in that sentence is in the words it cites: a second fact gets a Citation of its own, to the words that state it. What is the User's own (advice, a conclusion, a "no", an offer or a plan the Documents don't state) goes in another sentence with no Citation marker: it cites neither the question it answers nor the rule it rests on, and that rule is a cited sentence of its own. End the cited sentence with "." or "。" before the User's own part: joined by anything else (", so", ", but", "，", a dash, a semicolon) it is still the cited sentence. A "→" line never has a Citation marker.
< ★ We can't go below list for Enterprise, but we can extend the pilot to 60 days [^1]
> ★ We can't go below list for Enterprise. We can extend the pilot to 60 days [^1]
```

A short line's button changes its shape line the same way ("each one sentence of at most 20 words, its Citation markers at its end" becomes "each at most two short sentences and 20 words in all", followed by the rule). It also changes its example line. The check button also changes its task line and gets its own example lines; in a Chinese call:

```
< What they need: Check the newest claims in the transcript against the User's Documents: each line is a claim, then whether the Documents support it, contradict it or don't say.
> What they need: Check the newest claims in the transcript against the User's Documents. Each line starts with the verdict, "Right." or "Wrong." (in Chinese "对。" or "不对。"), a sentence of its own with no Citation; then what the Documents say, in a sentence of its own with its Citation. Where the Documents don't speak to the claim, the line says so in one sentence with no Citation ("The Documents don't say …"; in Chinese "文档没有提到…") and cites nothing. Restate the claim only as far as the line needs.
< - At most three short lines, each starting with "- ", each one sentence of at most 20 words, its Citation markers at its end.
> - At most three short lines, each starting with "- ", each at most two short sentences and 20 words in all.
> - What the Documents or the call say goes in a sentence of its own, … (the rule above)
< - 上线推迟到 11 月 18 日 [^1]
< - Dana 跟服务商确认日期
> - 不对。条款写的是试用期 60 天 [^1]
> - 对。合同每年一月续签 [^1]
> - 文档没有提到培训
```

An English call gets the same lines with the English examples. A reading's instructions don't change.

### Main at the run

- [x] **The fix for a sentence-check reply that corrects itself (#3029) is on `main`** (#3031), so such a reply is read by its corrected answer on both arms. `main` at 5fe364b78 was merged into the branch on 2026-11-13. It changed the sentence check, the same for both arms, and not call help's instructions: the hash of main's instructions holds unchanged.
- [ ] **#3005 part 2** (how call help treats an earlier call's lines, which also changes what call help is asked) has merged or been put down.
- `main` is merged into the branch again first, and the run names its commit.
- If that merge changes call help's instructions beyond #3005 part 2's own rule, that is said on #2847 before the gate.
- Neither change touches an instruction sentence the other does. #3005 part 2 edits "A Document fact was not said in this call…". This change edits the option and line shapes, their examples and the check button's task. Both add a parameter to `meetingHelpInstructions`, a line to its doc comment and a parameter to the test helper, which merge by hand.
- After each merge:
  - `tests/core/callHelpOwnSentence.test.ts`'s hash of main's instructions is set again from that commit when main's instructions changed;
  - every unit test of call help runs again before the run.
- The record reads each check reply with the check's own reader (`checkReplies` in `../arms.ts`), a corrected answer included.

## Arms, models, judge and the runs' rules

- **Arms**, paired and alternated per cell as `../README.md` › Paired runs says:
  - `call-help-writing-as-before`, `main`'s writing, through the evaluation switch `callHelpWritingAsBefore`. It sends `main`'s instructions byte for byte for every button, language and found-ahead state (`tests/core/callHelpOwnSentence.test.ts`).
  - `today`, this branch.
  - Both arms judge with `main`'s sentence check as it is.
- **Models:** Claude Haiku 5.5, then Claude Sonnet 5.5, each as the Answers model with call help on Same as Answers. Sonnet runs only if every bar holds on Haiku.
- **Judge:** never Claude Fable 5 or Claude Opus, and never the model under test, which the runner refuses.
  - One request a press grades the reply against the expected answer: Claude Sonnet 5.5 on the Haiku half, and Claude Haiku 5.5 on the Sonnet half.
  - In the gate, a second request reads each place on its sentence and quotes alone. Its count of wrong ✓ goes beside the hand reading's, never instead. On the earlier trial it agreed with the hand reading on 58 of 78 places, and called advice and conclusions backed.
  - The dev trial sends no per-place request: it gates nothing, and the hand reading is its yardstick.
  - **The judge's grade on the Sonnet half is a weaker model's.** In the dev trial it, and the false Supported it counts, are reported and gate nothing.
  - **In the gate, only G3's "judged right" rests on the grade.** Bars 1 to 3, G1, G5 and G7 rest on the hand reading. G2 and "cited" and "every Citation found" in G3 are counted from the record, G4 from its times, and G6 from its outcomes.
  - **So on the gate's Sonnet half, Claude Haiku 5.5's grade is checked by hand, blind to the arm.** Before the key is opened, a seeded draw (seed 2847) takes 10 pairs from the Sonnet half, 5 in each language. Both answers of each pair go into the sample, 20 answers, shuffled and unlabelled, with the case's expected answer beside each. The hand reading grades each one right or not.
  - If the hand grade and Haiku's differ on more than 2 of the 20, G3's "judged right" on Sonnet is unread and goes back for a decision. Otherwise Haiku's grade stands. Two is the allowance in each Sonnet cell of G3. A grade wrong on more answers than that could move a cell's count by the allowance on its own.
  - The judge's false Supported count gates nothing, on either half.
- **The yardstick for a wrong ✓ is the hand reading by place, blind to the arm.**
  - A script builds the reading file. It holds every place of both arms whose quote was found, shuffled together, unlabelled: the sentence, every quote it cites, and how many of its places show ✓. The same sentence with the same quotes is read once.
  - **Two readers fill their own copy** of the same file: a first reader, and an independent second reader who sees only that file. The bars count the first reader's reading. The two readings' agreement, by label and by side (backed, unbacked, borderline), is reported beside them, with every item they differ on.
  - The key, which arm, press and place each item is, goes in a folder apart. Neither reader opens it until both readings are sent.
  - The labels are: right; claims nothing or restates; fault; own conclusion; own advice or plan; own no; call claim outside the quoted words; borderline.
  - Unbacked: fault, the three own labels and a call claim. Backed: right and claims nothing. Borderline counts in neither.
  - **A second part of the file holds every line of a check button's reply,** on both arms, with its case named so its Documents can be read, and the words it quotes. Each line is read as: its verdict agrees with the fact beside it and the case's Documents; it disagrees with either; or it gives no verdict.
  - Neither part names an arm, or the Document or call a quote comes from.
- **Each run:**
  - holds the lease of the key it is given for its whole length, with that key's judge lease nested inside it;
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
   - **Before #3005 part 2:** these cases hold no earlier call, and the trial gates nothing. The wording may change on it once, and is then frozen.
   - **False Supported counted over the set** (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`), as a trial that gates nothing does, never stopping at the first.
   - **Where it runs:** on a second direct Anthropic key with its own limit, in a pause between other lanes' rounds. It holds that key's lease, with its judge's lease nested inside, since the models under test and the grade's judges are all on it. `LANE_NAME=bonito-2847-dev`, the allowance read first, a PID file from its start, run directly, and nothing else of this lane's alongside.
   - **Its dry mode** builds each half's settings with the runner's own plan (`INCARNAMIND_EVAL_SPEED_PLAN=1`) and exactly the run's environment, sending nothing. A judge that is a model under test, or an item that isn't in the set, fails it.
   - **The first run is void** (2026-11-13, 04:53–04:57Z), for two faults of its script:
     - false Supported stopped the Haiku half after 14 of 24 items;
     - the Sonnet half judged itself and never started.
     Its $0.073 counts inside the stop, and its presses are not used.
   - **The rerun is the whole trial again,** all 24 items on both models, fresh presses: about $0.75 (the Haiku half $0.13, the Sonnet half $0.62). The phase then totals about $0.82, inside the $1.40 stop.
   - **If the phase ends above about $1.09,** what is left of #2847's $8 no longer covers the gate's estimate and a tenth more, and the gate's size goes back for a decision before it runs.
   - **What ran:** the Claude Haiku 5.5 half whole. On the Claude Sonnet 5.5 half, six Chinese rows were hit by the provider's failed requests and are left out, both presses of each. That half is not a run: its 18 clean rows are read for the trial only. Two readers read it blind to the arm. The phase spent $0.89.
   - **The one wording change the trial allowed** was made after the trial's reading, read by a second reader, and frozen at 344fec2bd: the rule above. It adds three things:
     - every fact in a cited sentence is in the words it cites;
     - the User's own part cites neither the question nor the rule;
     - the cited sentence ends with a full stop before the User's own part.
     Nothing else in what is sent changed, and the as-before arm sends `main`'s text as it did.
   - **A Haiku-only look follows** on the same 24 development cases: both arms, one run, Claude Haiku 5.5 graded by Claude Sonnet 5.5, false Supported counted, stop $0.18. It rules on no bar and cannot change the wording. The wording is frozen from here to the gate.
2. **The gate: held-out presses.**
   - **The cases** are written blind to this change by someone else, put into `../callHelpMarks4.ts` at the run, and not opened before it. Its needs are listed below.
   - **Runs:** two of every case, both arms, Haiku and then Sonnet.
   - **It starts only if what is left of #2847's $8 covers its estimate and a tenth more,** about $2.80. Its stop is then $3.20 or what is left, whichever is smaller. If less is left, its size goes back for a decision first.

### What the held-out cases need, to be checked before the run

- They are call-help presses in `CallHelpCase`'s format, not single sentences: the Documents, the call's turns, the expected answer and the lines it rests on.
- There are 15 English presses with a Chinese twin each, and at least 12 a language.
- **Buttons:** at least 8 a language with options (say, answer, no, objection, next step, ask), at least 3 with short lines (sum, check, facts), and no more than 2 readings (what they want), which this change leaves alone.
- **No bar's power rests on the short-line presses.** Bar 2 is read by cell over the probe presses, whatever their shape. G2 is an upper bound over every line of a cell. With 3 short-line presses a language, what the short-line shape does alone (6 presses a cell over two runs) is reported and gates nothing.
- **Probes of the named kind**, at least 6 a language: a press whose natural reply joins a cited fact to a short conclusion, a "no", advice or a verdict of the reply's own ("…, so …", "…, and they agreed", "…, which the sheet contradicts"). Their ids are given at the run.
- **Positives**, at least 6 a language: a press whose right reply is a cited fact with nothing of the reply's own.

## The bars, set before any run and never moved after

Counted per model, pooled over both languages and both runs (60 presses an arm in the gate) unless a cell is named. A cell is a model and a language. The hand reading is the first reader's. Everything else is counted by the scoring script from the record and that reading.

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
- **G7, a verdict no check reads.** The branch's check lines whose verdict disagrees with the fact beside it, or with the case's Documents, are no more than main's writing's, per model over both languages and both runs.

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
- **One stop:** if the whole interval lies above a tenth slower on either model, the change goes back for a decision before it merges.

## Size

Anthropic's prices don't change by the hour, so the hour's price is the list price. The estimates come from #2847's third gate's ledger: Claude Haiku 5.5 $0.78 for 120 presses, of which the judge took $0.71; Claude Sonnet 5.5 $2.01, of which the judge took $0.61. Adjusted for both arms now running the check, and for a judge on Claude Sonnet 5.5 at half Claude Opus 5.5's price with one more short request a press:

| Phase | Presses | Requests, Haiku | Requests, Sonnet | Estimate | Stop | Items to read blind |
|---|---|---|---|---|---|---|
| Dev trial | 96 | about 120, and 48 the judge's on Sonnet | about 120, and 48 the judge's on Haiku | $0.75, with the void run's $0.073 about $0.82 | $1.40 | about 175, and its check lines, by each of two readers |
| Gate | 240 | about 250, and 240 the judge's | about 300, and 240 the judge's | $2.55 | $3.20 | about 430 (Haiku's about 215 first), by each of two readers |

- The requests by model count the product's reply and check on the model under test. The judge's requests are on the other model: Claude Sonnet 5.5 judges the Haiku half, and Claude Haiku 5.5 the Sonnet half.
- The items to read are about 1.8 a press, as on the saved presses.
- #2847 was at $4.11 of its $8 before this file. Both phases at their estimates, the void run included, bring it to $7.48. The gate's start rule above keeps it inside the $8.

## What can't be known before the run

- How often each model splits an option as asked, or writes the second sentence with a Citation after all.
- Whether an option with two sentences reads as well aloud in a second or two. The grade sees part of that, and nothing in the record sees all of it.
- Whether a shorter cited sentence passes the check more often, or the own sentence drops a fact the expected answer needs.
- How the check button's lines read without a verdict word, and whether the User misses it.
- How the held-out cases split between options and lines, until they are checked against what they need.
- Whether #3005 part 2 changes how often an option cites the call.
