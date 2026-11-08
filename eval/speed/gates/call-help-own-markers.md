# The gate for call help's Citations in Chinese (#2847)

Written and committed on 2026-11-08, before any run it gates, together with the slice it runs on (`../callHelpChinese.ts`) and before the change's code.

## The change

There are two parts. Both come from the sort on #2847, which read 89 Chinese presses with a false Supported: 46 from the fastest-model run (Claude Sonnet 5.5 and Claude Haiku 5.5, 23 each) and 43 from the form-kept runs (Claude Haiku 5.5).

1. **Call help gives a Citation only where the model wrote its marker.**
   - A record the model left unmarked is dropped. Today it is placed on the sentence or paragraph that shares the most words with it.
   - A sentence the model left uncited gets no Citation. Today it can get one from a quotation in it, or from a Passage sentence it is worded like.
   - Call help shows a found Citation as checked and runs no judgement of its sentence. So a Citation the core adds is a check the model never gave. A Meeting's filled-in facts already work this way (#2306).
2. **Each Citation marker goes right after the words its line states**, instead of at the end of each option or line.
   - A fact from another line takes that line's marker.
   - What the User would promise, offer or ask takes none.
   - An option that only buys time has none.
   - The form's examples follow this rule.

Nothing else changes: not the model, the Tools, the quote check or the panel.

## The runs

- **Arms:** `help-marks-as-before` against `today`, paired as `../README.md` › Paired runs says.
  - `help-marks-as-before` is main's path. The core places and adds Citations as before, and each request's form is reworded back to main's, word for word. A unit test holds that rewording.
  - `today` is this change.
- **The presses:** two parts.
  - The fresh Chinese slice `call-help-chinese`: 15 presses written for this gate.
  - The call-help set's 15 English presses (the `en-*` items of `call-help`), so that a change in English shows. They are not held out: earlier runs have seen them, and the sort on #2847 read their stored replies to compare. The change was not written against them.
- **Models:** Claude Sonnet 5.5, the issue's target, and Claude Haiku 5.5.
  - Each is the Answers model, and call help answers on it (Same as Answers).
  - They run on a direct Anthropic key. If the key runs out of credit, the run goes on with another direct Anthropic key on the same model, noted here with its time. It never moves to another route or model within this gate.
  - The judge is Claude Opus 5.5 for both arms.
- **Samples:** two runs of every press (`INCARNAMIND_EVAL_SPEED_RUNS=2`). False Supported is counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **A pilot** may run first, to see the change act: the call-help set's 15 Chinese presses, on Sonnet 5.5, one run. The sort has read those presses, so they are not held out. The pilot never touches `call-help-chinese`, and its numbers are reported on their own and not read by the bar.
- **Load:** a run starts only once the 15-minute load is 24 or less.
- **Spend:**
  - About $4.30 for the gate's 240 presses. A Sonnet press costs about $0.018, a Haiku press about $0.006, and the judge about $0.006 a press.
  - About $0.72 for the pilot.
  - The cap for this work is $6. The ledger stops a run before the next item once $5.90 is spent.

## The bar

Per model and language, a range is the lowest and highest count over the two runs. A pooled count is over both runs: 30 presses for each language, arm and model.

**It ships only if all of these hold:**

- **False Supported** (presses with a sentence that its found Citation doesn't state):
  - On Claude Sonnet 5.5, Chinese on `today`, pooled, is no higher than English on `today`, pooled.
  - On each model and in each language, `today`'s range does not sit above `help-marks-as-before`'s: its lowest is not above the other's highest.
- **Expected Passages cited, judged right and every Citation found:** on each model and in each language, `today`'s range does not sit below `help-marks-as-before`'s: its highest is not below the other's lowest.

**Reported plainly, not held:**

- Whether Chinese is no higher than English on Claude Haiku 5.5.
- The time to the first whole option and to the end (medians).
- Replies that showed nothing, and presses that failed to run.
- The pilot's numbers.
- Every press with a false Supported on either arm, sorted by kind as on #2847.
- The spend and the load.

If a line fails, the change doesn't ship as it is, and the numbers go on #2847 so that the next try starts there.

## Amendments, 2026-11-08, before any run of `call-help-chinese`

From the independent pre-review, made before the slice's first run:

- **Two expected answers named more than their Documents say.**
  - zh7-answer-unknown now names the nearby fact the Document gives: "冷链监控只写了传感器每台每月 45 元，没有写是否防水…".
  - zh7-no-term no longer says the price sheet gives 九五折 "only" for two years, which it doesn't: "价目表只写了两年合约月费打九五折，没有一年合约的折扣。"
- **The marker rule's wording changed** so that it doesn't keep a fact out of a question or an earlier offer: "A promise, offer or question the User would make now gets none, though a fact inside it, or what was said earlier in the call, gets its line's marker". The pilot had already started on the earlier wording ("what the User would promise, offer or ask gets none"). The gate's runs use this one.
- **What the judge reads.** It reads the whole sentence that carries a Citation against that Citation's quote, so a clause after a mid-sentence marker still counts. The second part of the change can move the bar only where the judge reads a marker as covering the words before it. The bar is unchanged.
- **What this gate doesn't measure.** A marker the model wrote with no record now loses its Citation instead of being matched to a line. A model on structured output (a local model with no Tools) that gives records without markers now shows no Citation where main placed them. Neither happens to the Tool-calling Anthropic models this gate runs; unit tests hold both.

## Second amendment, 2026-11-08, after the pilot and before any run of `call-help-chinese`

- **The pilot** (Sonnet 5.5, the call-help set's 15 Chinese presses, one run, the first rule's wording): false Supported 6 → 6, cited 15 → 15, judged right 15 → 14, every Citation found 15 → 15; $0.94, the judge $0.18; one-minute load 13.5 to 38.0. The core's part acted: main's arm put "早上出了问题找谁" on a → line again (zh-want), and the branch's arm didn't. But the branch's markers moved mid-sentence while their sentences still held a fact no quote stated: "今年的开通费是一次性 8,000 元 [1]，企业版 50 席位起还有九折优惠。" The judge reads the whole sentence, as the first amendment says, so moving a marker doesn't help while such a fact stays in the sentence.
- **So the rule now says what a cited sentence may hold**, as the Answers' own rule does ("A sentence with a Citation says only what its quote supports"): "A sentence with a Citation marker says only what its quotes state, beside what the User would promise, offer or ask now: put each marker right after the words its quote supports, give each other fact from the Documents or the call its own line's marker right after it, and leave out a fact or a conclusion that no quote states. An option that only buys time has no marker." The examples are as before.
- **A second pilot** may run on four of the call-help set's Chinese presses that the first pilot flagged on the branch (zh-answer-edition, zh-answer-unknown, zh-say-competitor, zh-say-records), with both arms on this branch (`today` twice), on Sonnet 5.5, to see the new rule act before the gate's spend. It never touches `call-help-chinese`.
- **Samples, within the cap:** the pilots cost more than estimated (about $0.025 a Sonnet press). So the gate runs two runs on Claude Sonnet 5.5, the issue's target, and one on Claude Haiku 5.5. For Haiku, a range is that one run's count. The bar is otherwise unchanged.

