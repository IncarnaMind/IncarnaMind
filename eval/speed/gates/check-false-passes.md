# The gate for the sentence check's two false passes (#3003, #2739's first kind)

Written and committed on 2026-11-12, before any run it gates. The batch sentence check, behind an Answer's checks and call help's ✓, passes two kinds of sentence it shouldn't:

- **#3003:** a sentence that adds something no Passage says to a quoted fact: a conclusion drawn from it, a negative or a limit the Document doesn't give, or a promise, offer or plan.
- **#2739's first kind:** a sentence its cited words don't state, though another line of the Document or of the call does.

## The change

The batch's reply gains two fields, and loses `quoted`:

- `unstated`: the sentence's own words, copied as written, that no Passage states, or null.
- `uncited`: the sentence's own words that the words it cites don't say though another part of a Passage does, or null.

`supportOf` (`src/core/answers/checks/answerCheck.ts`) reads them:

- copied `unstated` words make the sentence unsupported, whatever verdict came with them;
- copied `uncited` words leave it unjudged, as `quoted: "other"` did.

Both fields come before the verdict in the reply, so the model copies before it decides. An entry missing either field isn't read, as for every other field. A copy that isn't the sentence's own words, its letters and digits in order with spaces, punctuation and symbols aside, is a misreading. That covers a paraphrase, another sentence's words, or text from nowhere. The sentence is then left unjudged, neither passed nor called unsupported, so stray text never decides it. The whole sentence copied is its own words, and makes it unsupported.

There is no new check, and no rule for call help alone. The same instructions judge an Answer's sentences and a call-help reply's. The instructions' examples are generic and are not the measured cases.

## Arms, models and judge

- **Arms, paired and alternated per cell:**
  - `check-rule-as-before`: main's batch rule, through an evaluation switch (`checkRuleAsBefore`) that sends main's instructions and reads `quoted` as main does;
  - `today`: this branch.
- **Models:** Claude Haiku 5.5 and Claude Sonnet 5.5, on a direct Anthropic key, each judging the sentences its own Answers or replies wrote.
- **The judge is Claude Sonnet 5.5**, never Claude Fable 5 or Claude Opus. #2847's gates 2 and 3 were judged by Claude Opus 5.5, so before the gated runs a sample of their saved replies is judged again by Claude Sonnet 5.5, at no new reply cost:
  - the sample is 30 branch presses of gate 3 per model, and gate 2's 60;
  - its agreement with the Opus listings is reported, by Citation number.
- Both arms of this gate are judged by the same judge, so its bars compare like with like. Its numbers are not compared with gates 2 and 3's, which stay as recorded.

## The yardstick by place (ruled on 2026-11-12, before any run)

1. **A press is a wrong-✓ press when at least one place shows a ✓ beside an unbacked sentence.** A place is one Citation number where it sits in the reply.
2. **The record keeps each place:** its sentence, its Citation, and the mark the app showed there. These are read from the app's own state: the stored Answer's Citations and the panel's own `sentencePassed`, never worked out again by the gate's code.
3. **The judge is asked per place,** with the place's sentence and every quote that sentence cites. It is not told which places show a ✓; the gate joins the judge's answer and the marks afterwards. This is the same in every arm, model and language.
4. **The count by Citation number is reported beside it** (a number is wrong when the judge finds any of its places unbacked and it shows ✓ on any line), so the earlier yardstick stays visible.
5. **A judge error to watch:** a sentence rightly stated by two quotes read together. The judge listed one such sentence in gate 3, and the held-out positives include that shape.

## Phases and stops (ruled on 2026-11-12)

Each phase starts only when the one before held and its numbers and spend are in, with its own stop set then. Only phase 1 is approved.

1. **The dev trial and the judge's sample, stop $1.50.**
   - **The dev trial.** It uses #2847's gates 2 and 3's saved replies on the branch's arm, which are dev material, not held-out.
     - All 180 presses are pressed again with their replies scripted as the model wrote them (`eval/speed/checkTrial.speed.ts`).
     - Only the check's requests go to a real model: each reply on the model that wrote it, under the rule before #3003 and under today's, the order turning per case.
     - That is about 360 check requests: 240 on Claude Haiku 5.5 and 120 on Claude Sonnet 5.5.
   - **The judge's sample.** Claude Sonnet 5.5 judges per place 30 of gate 3's saved presses per model, 60 requests. Its numbers listing is set beside Claude Opus 5.5's.
   - **Read against the yardstick by place on gates 2 and 3, by hand:**
     - how many wrong ✓ of the two kinds go;
     - how many right ✓ are kept;
     - what each field held where it took a ✓ away;
     - how many copies weren't the sentence's own words.
   - **Measured, paired under each rule, per model:**
     - the check's output tokens per sentence;
     - its request time;
     - how long after the reply's end the ✓ settle;
     - whether any batch reply was cut.
   - The instructions may be changed on what the trial shows. They are then frozen at a commit this file names, before the held-out cases are opened.
   - **The re-trial** (written on 2026-11-13, before it runs) is set out below. Phase 1 holds only if it holds.
2. **The held-out check cases.**
3. **The fresh call-help slice.**
4. **Answers' own cases.**

Each run names the commit of main its arms stand on, and whether it holds #2997, another pull request's guard on the quoted words' units, which also changes the Answer's check. Main is not merged between the arms of one phase.

## Phase 1's re-trial (written on 2026-11-13, before it runs)

**Why.** The first trial ran the first wording. Ruled since: no ✓ beside a sentence that adds advice, a conclusion or the reply's own "no", with one meaning in an Answer and in call help. So the instructions changed:

- `unstated` names advice and a refusal the reply makes of its own, beside a conclusion, a negative or a limit, and a promise, offer or plan;
- `uncited` says that a judgement on what someone said, citing only one of what was said and what answers it, is copied.

The instructions it runs are at commit 53ffb3261, on main ea2a33511, without #2997.

**The run.**

- The same 180 saved presses as the first trial, under both rules again, the order turning per case, on the same models, inside phase 1's stop of $1.50.
- Both rules run in the same hour, so the time bar pairs them on the same sentences.
- The rule as before is sampled a second time. How many places change their mark between its two samples is reported as the run's noise.

**The judge.**

- Claude Sonnet 5.5 reads each place of 60 saved presses, every case's first run in gate 3: 15 English and 15 Chinese a model.
- It reads each place on its sentence and quotes alone, in one request a press, with no grade.
- Its agreement with the hand reading is reported on the places both read. A fault, a conclusion, advice or a "no" of the reply's own, and a call claim outside the quoted words, count as unbacked. A right sentence and one that claims nothing beyond its quotes count as backed. Borderline places are left out.
- Under 9 in 10 agreement, the hand reading is this phase's yardstick, and the judge's question is set again before the held-out phase.

**The yardstick** is the first trial's 235 places read by hand, each with its kind.

**Held** means every one of these, read by place on this run's `today` arm (a place is one Citation number where it sits in one press's reply):

1. None of the 16 fault places shows a ✓. A fault place is a wrong ✓ of #3003's kind or of #2739's first kind under the rule as before, as the first trial's hand reading found it.
2. Of the 13 places whose sentence claims nothing beyond its quotes or restates them, at least 10 show a ✓. The borderline places are listed, and counted in neither 1 nor 2.
3. None of the 6 verdict places shows a ✓. A verdict place's sentence gives a verdict on a claim while citing one side only, and it kept a ✓ in the first trial.
4. Of the other 40 places with advice, a conclusion or a "no" of the reply's own, at most 3 show a ✓. Each one is listed with its sentence, and the counts are given by language and model.
   - The 4 places of the known call kind are listed apart and counted in no bullet. Each says what was said on the call outside the quoted words, and each kept a ✓ in the first trial.
5. Every place that shows a ✓ under today's rule and not under the rule as before, in this run, is listed with its sentence and read by hand.
6. The time bar, bar 7 below, holds on this run's pairs.
7. No request was refused, failed or timed out, the judge's included, as the run's own record shows.

If any one isn't met, phase 1 isn't held. The held-out phase doesn't start, and the list goes on #3003 for a ruling. Nothing in this definition changes after the run.

## The cases

- **Held-out check cases**, written by someone else, blind to this change, in English and Chinese, each sentence's language its own. They are not seen before the gated run.
  - Shapes 1 to 5, each with 4 negatives a language, each negative with its positive:
    1. a conclusion drawn from a quoted fact;
    2. a negative or a limit the Document doesn't give;
    3. a promise, offer or plan added;
    4. #2739's first kind, a detail from another line of the Document;
    5. the same, a detail from another line of the call.
  - Shapes 6 and 7, 4 positives a language each:
    6. stated by two quotes read together;
    7. a sentence in the other language from its Document.
  - That is 20 negatives and 28 positives a language, 96 sentences in all.
  - **Their format:** a JSON array, each case `{ id, shape, pair, polarity, language, documents, call?, sentence, cites: [{ in, quote }], added, statedBy?, why }`, read by `eval/speed/checkTrial.speed.ts`. Each case is pressed in call help as a reply of its sentence, its Citations to its quotes, and only the check's request goes to a real model.
- **A fresh call-help slice**, written the same way and blind (`eval/speed/callHelpMarks4.ts`, empty until the gated run):
  - 15 English presses, each with a Chinese twin;
  - `call-help-marks-3`'s mix of buttons, in a new domain;
  - every case with its own Documents, Meeting and Note.
- **Answers' own cases:** the `gating` set's 65 Questions.

## The runs

- **Held-out check cases:** each case on each model, under each rule, three runs.
- **The fresh call-help slice:** as `call-help-checked-marks-3.md` runs it, two runs of all 30 presses on each model, with arms `check-rule-as-before` (main since #3008) and `today`. The record and the judge are per place.
- **Answers' own cases, the same Answers under both rules:**
  - Each Question is answered once, by the real model, in the core of the arm whose turn it is first (the order alternated per Question).
  - The same Answer is then written in the other arm's core by a scripted model, with the same text and the same quotes, the way the dev trial replays a reply.
  - So both rules check the same sentences, and the judge reads each sentence once.
  - Check again can't do this: it judges only Citations left not checked, and nothing in the app's own path judges a judged Citation again.
- **Shared keys:**
  - each run holds a machine-wide lock on its key for its whole length;
  - one smallest request reads the allowance first, and the run starts only above 90%;
  - the 15-minute load must be 24 or less at the start;
  - at most four requests at once;
  - the runs go one after another.
- **A run counts only if no request was refused, failed or timed out,** read from its own record. A void run is kept, struck with its reasons, and not run again before those reasons are read.
- **The DeepSeek half** of #3003's box (the held-out cases on DeepSeek V4.1 Flash) runs only if the plan's reader says so.

## The bars, set before any run and never moved after

1. **The false passes fall, on the held-out check cases.** For each kind (#3003's shapes 1 to 3, #2739's shapes 4 and 5) and each model, pooled over both languages and three runs:
   - the branch passes at most half as many negatives as main, rounded down;
   - where main passes fewer than 4, the branch passes at most 1.
2. **The positives keep their verdict, on the held-out check cases.** For each model, pooled over languages and runs:
   - the branch passes at least 90% of the positive sentences;
   - it passes fewer than main beyond chance in no shape: a one-sided sign test on the case-runs where the arms differ fails at p < 0.05.
3. **#2847's bar 1a, on the fresh call-help slice, by place, as `call-help-checked-marks-3.md` states it:** on each model, over the branch's own presses, both languages and both runs:
   - W1 is at most half of W0, rounded down, and at most 1 where W0 is under 4.
   - **W0** is the rule #2847 was opened on, where a found quote alone gives a ✓. It is worked out at no cost on the same presses: those with a place whose quote was found and which the judge finds unbacked.
   - **W1** is the new rule on those presses: such a place shows a ✓.
   - **Reported between them, with no bar:**
     - main's count since #3008 (`check-rule-as-before`, on its own presses);
     - the ✓ themselves: of the places that show a ✓ under the new rule, how many the judge finds unbacked;
     - the count by Citation number.
4. **Chinese no worse than English beyond the run's own chance:**
   - On the fresh slice, on each model, the branch's Chinese W1 is no higher than its English W1 plus its own flips between the two runs.
   - On the held-out check cases, on each model, its Chinese false passes are no higher than its English plus one.
5. **The checks an Answer rightly keeps don't fall, on Answers' own cases, the same Answers under both rules.** Per Question, the number of Citations whose sentence the check passed and the judge finds backed is paired between the rules. A one-sided sign test on the Questions where today's rule is lower fails at p < 0.01.
6. **#2847's other bars hold on the fresh slice as `call-help-checked-marks-3.md` states them:**
   - 2: kept ✓, at least a third;
   - 3: the reply holds;
   - 4a and 4b: the same request, and not slower;
   - 5: no press failed on the branch alone.
7. **The check's time and room,** set on 2026-11-13 from phase 1's numbers:
   - at the median, a ✓ settles no more than a tenth later than under main's rule on the same sentences, on each model, in call help and in an Answer;
   - no batch reply is cut at its limit;
   - the 90th percentile is reported, with no bar.

Every bar must hold on both models. A failed bar keeps the change from shipping, and the numbers go on #3003 and #2739.

## Reported, not gated

- The false passes and the positives, by shape and language.
- The judge's agreement with gates 2 and 3's Claude Opus 5.5 listings, on phase 1's sample.
- What a press costs: requests and tokens, the check's among them.
- Each place the judge finds unbacked that shows a ✓, with its sentence and quotes.
- How often a copied field wasn't the sentence's own words.

## Spend, by phase

1. The dev trial, about $0.85: Haiku $0.12 and Sonnet $0.72. The judge's sample, about $0.30. **Stop $1.50.** The first run spent $0.66. The re-trial is about $0.55: the check about $0.48 and the judge about $0.07.
2. The held-out check cases, about $0.25 on Haiku and $2.90 on Sonnet: 96 sentences, each its own press, both rules, three runs, 576 check requests a model.
3. The fresh slice, about $0.50 on Haiku and $2 on Sonnet, with the judge per place.
4. Answers' own cases, about $1.50 on Haiku and $4 on Sonnet: each Answer generated once, checked under both rules, judged once.
5. The DeepSeek half, if asked for, under $0.05.
