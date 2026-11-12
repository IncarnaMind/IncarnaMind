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

Both fields come before the verdict in the reply, so the model copies before it decides. An entry missing either field isn't read, as for every other field.

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

## The cases

- **Held-out check cases, written by someone else, blind to this change, and not seen before the gated runs.** They are written in English and Chinese, in these shapes, with a positive beside every negative:
  - #3003, a conclusion drawn from a quoted fact: 2 a language, each with a positive restating the fact.
  - #3003, a negative or a limit the Document doesn't give: 2 a language, each with a positive.
  - #3003, a promise, offer or plan added: 2 a language, each with a positive.
  - #2739's first kind, a detail from another line of the Document: 2 a language, each with a positive citing both lines.
  - #2739's first kind, a detail from another line of the call: 2 a language, each with a positive citing both lines.
  - Positives only: 2 a language stated by two quotes read together, and 2 a language whose sentence is in the other language from its Document.
  - That is 10 negatives and 14 positives a language, 48 sentences in all.
- **A fresh call-help slice, written the same way and blind:** 15 English presses, each with a Chinese twin, with `call-help-marks-3`'s mix of buttons, in a new domain, every case with its own Documents, Meeting and Note.
- **Answers' own cases:** the `gating` set's 65 Questions.

## The runs

- **Held-out check cases:** each sentence is judged by the batch check of each arm on each model, three runs. The Answer is scripted to the case's sentence and Citations; the check's request goes to the real model.
- **The fresh call-help slice:** as `call-help-checked-marks-3.md` runs, two runs of all 30 presses on each model, with the per-place record and judge above.
- **Answers' own cases:** one run of each arm on each model, Claude Haiku 5.5 first.
- **Shared keys:**
  - each run holds a machine-wide lock on its key for its whole length;
  - one smallest request reads the allowance first, and the run starts only above 90%;
  - the 15-minute load must be 24 or less at the start;
  - at most four requests at once;
  - the runs go one after another.
- **A run counts only if no request was refused, failed or timed out,** read from its own record. A void run is kept, struck with its reasons, and not run again before those reasons are read.
- **The DeepSeek half** of #3003's box (the held-out check cases on DeepSeek V4.1 Flash) runs only if the plan's reader says so.

## The bars, set before any run and never moved after

1. **The false passes fall, on the held-out check cases.** For each kind (#3003, #2739's first kind) and each model, pooled over both languages and three runs:
   - the branch passes at most half as many negatives as main, rounded down;
   - where main passes fewer than 4, the branch passes at most 1.
2. **The positives keep their verdict, on the held-out check cases.** For each model, pooled over languages and runs:
   - the branch passes at least 90% of the positive sentences;
   - it passes fewer than main beyond chance in no shape: a one-sided sign test on the case-runs where the arms differ fails at p < 0.05.
3. **#2847's bar 1a, on the fresh call-help slice, by place.** On each model, over the branch's own replies, both languages and both runs:
   - W1 is at most half of W0, rounded down, and at most 1 where W0 is under 4.
   - W0: presses with a place whose quote was found and which the judge finds unbacked.
   - W1: presses where such a place shows a ✓.
   - The count by Citation number is reported beside it.
4. **Chinese no worse than English beyond the run's own chance:**
   - On the fresh slice, on each model, the branch's Chinese W1 is no higher than its English W1 plus its own flips between the two runs.
   - On the held-out check cases, on each model, its Chinese false passes are no higher than its English plus one.
5. **The checks an Answer rightly keeps don't fall, on Answers' own cases.** Per Question, the number of Citations whose sentence the check passed and the judge finds backed, paired between the arms. A one-sided sign test on the Questions where the branch is lower fails at p < 0.01.
6. **#2847's other bars hold on the fresh slice as `call-help-checked-marks-3.md` states them:** 2 (kept ✓ at least a third), 3 (the reply holds), 4a and 4b (the same request, not slower), 5 (no press failed on the branch alone).

Every bar must hold on both models. A failed bar keeps the change from shipping, and the numbers go on #3003 and #2739.

## Reported, not gated

- The false passes and positives by shape and language.
- The judge's agreement with gates 2 and 3's Claude Opus 5.5 listings, on the sample above.
- What a press costs: requests and tokens per press, the check's among them.
- How long marks take to settle.
- Each place the judge finds unbacked that shows a ✓, with its sentence and quotes.

## Spend

At most $12 in all, held by one ledger and the runner's stop:

- Claude Sonnet 5.5's re-judging of the sample: about $0.20.
- Held-out check cases: about $0.10 on Haiku and $1 on Sonnet.
- The fresh call-help slice: about $0.50 on Haiku and $2 on Sonnet.
- Answers' own cases: about $2 on Haiku and $6 on Sonnet.
- The DeepSeek half, if asked for: under $0.05.
