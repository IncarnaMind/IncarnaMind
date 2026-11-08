# The gate for call help's Citations in Chinese (#2847)

Written and committed on 2026-11-08, before any run it gates, together with the slice it runs on (`../callHelpChinese.ts`) and before the change's code.

## The change

There are two parts. Both come from the sort on #2847, which read 89 Chinese presses with a false Supported.

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
