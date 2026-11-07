# The gate for call help that names its Passages in its markers (#2526)

Written and committed on 2026-11-07 with the second held-out set (`../callHelpHeldOut.ts`), before any run it gates. It holds the step to the bar of `call-help-records-first.md`: ranges over three runs, per language.

## Why this step

- On a direct key, Claude Sonnet 5.5 can't turn thinking off. Its least setting, `between_tools`, thinks after each Tool's result and not before the first reply (`call-help-records-first.md` › What was measured first).
- Call help already searches the Documents for the newest lines before its first request (`<found-in-documents>`). The time goes after that, to `cite`:
  - Sonnet gives its records first.
  - It thinks once `cite`'s result is back.
  - Then it writes the whole reply, about 4.4 s (English) and 4.7 s (Chinese) after the press.
- Two steps that kept `cite` in the reply each missed a line:
  - written first: Chinese false Supported rose;
  - records first, in one structured reply: Chinese judged right fell.

## The step

On a model listed for `call-help` (`MARKS_PASSAGES` in `src/core/providers/catalog/answerPaths.ts`), call help offers no `cite` Tool.

- **The reply:** each marker carries the number of the Passage it rests on, `[^3]` for P3. It cites from the Passages the press was given: the newest lines and the Documents found ahead.
- **The quote:** once the reply is written, IncarnaMind records each marker's quote. It takes the Passage sentence most like the marked sentence, of those the Citation check finds in that Passage. The record is then taken and checked as any record is.
- **The fallback:** search stays offered. A reply that needs more searches, as today, and marks the Passages it found the same way.
- **No rerank added:** the found-ahead search is unchanged. Each case's Library holds one or two short Documents, so ranking can't change what is found there.

Unit tests show the request offering no `cite`, the records IncarnaMind takes, and a marker that names no Passage taking none.

## The runs

- **Arms:** `today` against `help-marks-passages` (`../arms.ts`), paired, as `../README.md` › Paired runs says. `today` is `main`'s path: no model is listed.
- **The set:** `call-help-held-out`, 15 English and 15 Chinese presses written for this gate. No run and no prompt has seen them. They are heard on the fixed call rig (each turn once). The first set (`call-help`) has been seen by three steps, so it isn't run.
- **Models, each its own gate:**
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`) on its own key, judged by DeepSeek V4 Pro.
  - Claude Haiku 5.5 on a direct Anthropic key, judged by Claude Sonnet 5.5.
  - Claude Sonnet 5.5 on a direct Anthropic key, judged by Claude Opus 5.5.
  - The judge is the same for both arms.
- **Order:** first one press per model on the step's arm (a probe that the path runs), then three runs of every case per model (`INCARNAMIND_EVAL_SPEED_RUNS=3`). The arms' order turns case by case and run by run, and false Supported is counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **Keys:** a run that moves to the second direct key midway gets a dated line here: same model, another account. No run mixes routes.
- **Load:** a run starts only once the 15-minute load is 24 or less, and a run whose load went above 24 is run again.
- **Spend:** about $6.50 for the three gates: Sonnet about $4.30, Haiku about $1.70, DeepSeek about $0.40, plus the probes. The ledger stops a run before this work's total passes $33.

## Probes, and what changed after them (added 2026-11-07, before the gate's runs)

The probes ran on DeepSeek V4.1 Flash 1017 and spent about $0.30:

- 8 presses on six cases of this set: en2-answer-tablets, en2-no-price, en2-check-wrong, zh2-answer-total (twice), zh2-sum and zh2-answer-earlier;
- then 8 presses on the first set.

What they showed changed the step before any gate run. Each fix is general, not fitted to a case's wording:

- **One marker, one Passage.** A Passage named by claims resting on different sentences of it gets a marker for each.
- **One line, several facts.** A claim resting on several lines of one Passage gets a quote for each line that adds its own words, up to three. Before, a price, its discount and its fee under one marker were quoted from one line.
- **The id itself.** A marker written as the id, "[^P4]", is read as "[^4]". The rule now says "write [^3] to cite P3, never [^P3]".
- **calculate.** A `calculate` input that names a Passage by its marker number ("citation": 5 for P5) quotes that Passage's sentence holding its number. Before, it was refused as an unrecorded marker; once, the reply ended with nothing shown.

Those six cases have now been seen by a run of this step. So the bar below is read over the 24 cases no run has seen, 12 in each language, and only those 24 are run:

- en2: answer-total, answer-edition, answer-unknown, answer-earlier, answer-two, say-competitor, say-offline, want, sum, no-deposit, ask-store, check-right;
- zh2: answer-tablets, answer-edition, answer-unknown, answer-two, say-competitor, say-offline, want, no-deposit, ask-store, check-wrong, check-right, no-price.

Spend falls to about $5.20 for the three gates.

## The bar

A model is listed only if it holds every line below. Per language, from each run's per-case records (`report.json`), a range is the lowest and highest of the three runs' counts:

- **False Supported** (cases with a sentence its found Citation doesn't state): the step's range does not sit above today's; its lowest is not above today's highest.
- **Expected Passages cited, judged right and every Citation found:** the step's range does not sit below today's; its highest is not below today's lowest.
- **Done sooner:** the step's median time to the end, over its presses in that language, is below today's.
- **The first whole option sooner:** the step's median time to the first whole option, reading or line is below today's.

Both languages together:

- **None new:** no more Tool calls left as text, replies that showed nothing, replies written while the live text was behind, or cases failing to run, on the step's arm than on today's.

## Reported, not gated

- The first sign and the first words.
- Model calls, and how often the step's arm searched again.
- Markers that named no Passage the press was given.
- Each case with a false Supported, on either arm, with its sentence.
