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

## First runs, 2026-11-07: Sonnet missed English "cited" on a bug, now fixed

The runs were made at 8aaadba53, over the 24 cases, three runs each, on the fixed call rig.

| Model, today → step | Language | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|---|
| DeepSeek V4.1 Flash 1017 | en | 1.36 → 1.10 s | 2.72 → 1.40 s | 2–4 → 3–5 | 9–11 → 10–10 | 6–8 → 7–8 | 11–12 → 12–12 |
| | zh-CN | 1.35 → 1.19 s | 2.66 → 1.49 s | 1–2 → 1–3 | 9–12 → 11–12 | 8–10 → 10–11 | 10–11 → 11–12 |
| Claude Sonnet 5.5 | en | 4.77 → 1.71 s | 4.78 → 2.41 s | 3–5 → 5–7 | **12–12 → 9–11** | 10–12 → 11–11 | 11–12 → 12–12 |
| | zh-CN | 4.94 → 1.82 s | 4.94 → 2.78 s | 3–6 → 2–4 | 12–12 → 12–12 | 10–11 → 12–12 | 12–12 → 12–12 |

- **DeepSeek:**
  - Every line held, and no case failed on either arm.
  - 71 of 72 presses took one call.
  - The 15-minute load passed 24 at the run's end, with other runs on this computer, so the run is reported and not gated.
  - Its spend was $0.29, judge DeepSeek V4 Pro.
- **Sonnet:** English "cited" fell below today's. Every other line held. One-minute load median 15.9; the 15-minute load passed 24 in the run's last minute. Spend $3.25, judge Claude Opus 5.5.
- **The cause, traced in the six English presses that lost the cited line:**
  - In five, the marker came after its sentence's full stop ("…every plan. [^4]"). It was matched against an empty sentence, so the Document's heading was quoted ("Integrations").
  - In one, "connectors" didn't match "connector", so a shorter line sharing fewer of the claim's words won.
- **The fix,** to how a marker finds its sentence and to no case:
  - a marker after the full stop belongs to the sentence before, as `markedSentence` already reads it;
  - a heading is never quoted;
  - words match with a plural "s" folded;
  - a marker whose Passage has nothing like its claim goes, rather than stand on another sentence's Citation.
- **Run again:** the 24 cases have now been seen by runs of the step. All three gates are run again on the fixed code over the same 24 cases, one at a time, each started at a 15-minute load of 24 or less. Read their result with that in mind. Spend: about $5 more, about $31 in all for this work.

## The fresh slice (added 2026-11-07, committed before any run on it)

The fix above came from the 24 cases, so a pass on them alone is weak evidence for it. `../callHelpFresh.ts` (`call-help-fresh`) holds 16 new presses, 8 English and 8 Chinese, written after the fix. No run, prompt or probe has seen them, and they share no case or Document with the sets before them.

- **Six kinds:** answer, say, ask, check, check-right and no.
- **Documents of their own:** fuel cards, route planning, security, support plans and the drivers' app.
- **What English "cited" is tested on here:** markers after a full stop, plurals and two lines of one Document.

How the runs go:

- **Order:** Sonnet runs on the 24 cases (the regression run, started before this slice was written) and on the fresh slice. Then Haiku on both, then DeepSeek on both.
- **One at a time,** each started at a 15-minute load of 24 or less. Three runs of every case, the same arms, judges and keys as above.
- **The bar** above holds on the fresh slice, per language, for a model to be listed. The 24 cases are a regression check: each of their lines is reported, and one that fails is said in the PR.
- **Spend:** about $9 more, about $35 in all, within this work's $40.

## Result, 2026-11-07: Claude Sonnet 5.5 listed; Haiku and DeepSeek left out

The runs were made at 5680e53a0 (the step) with the sets at d2ee5e5a4. Each was run alone, at a one-minute load median of 5.8 to 8.9, all under 15. Medians are over the three runs, today → the step; ranges are the runs' lowest and highest. No press failed on either arm.

**Fresh slice** (8 a language; this is what lists a model):

| Model | Language | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | en | 4.12 → 1.48 s | 4.12 → 2.25 s | 2–2 → 2–4 | 8–8 → 7–8 | 8–8 → 7–8 | 8–8 → 7–8 |
| | zh-CN | 4.38 → 1.65 s | 4.38 → 2.54 s | 3–4 → 3–4 | 8–8 → 8–8 | 7–8 → 7–7 | 8–8 → 8–8 |
| Haiku 5.5 | en | **0.79 → 0.89 s** | 2.53 → 1.26 s | 1–3 → 1–3 | 6–7 → 7–8 | 6–8 → 6–7 | 7–8 → 7–8 |
| | zh-CN | 0.95 → 0.89 s | 2.48 → 1.32 s | 0–2 → 0–4 | 5–6 → 6–7 | 5–6 → 5–6 | 7–8 → 8–8 |
| DeepSeek V4.1 Flash | en | 1.43 → 1.04 s | 2.45 → 1.30 s | 1–2 → 1–3 | 4–8 → 7–8 | 6–6 → 6–7 | 8–8 → 8–8 |
| | zh-CN | **1.12 → 1.21 s** | 2.55 → 1.45 s | 1–2 → 0–2 | 6–8 → 7–8 | 4–6 → 5–6 | 8–8 → 7–8 |

**The 24 seen cases** (regression, 12 a language):

| Model | Language | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | en | 4.70 → 1.72 s | 4.70 → 2.44 s | 4–5 → 4–6 | **12–12 → 10–11** | 12–12 → 11–12 | 12–12 → 12–12 |
| | zh-CN | 4.88 → 1.75 s | 4.88 → 2.55 s | 3–4 → 1–5 | 12–12 → 12–12 | 10–11 → 11–12 | 12–12 → 12–12 |
| Haiku 5.5 | en | **0.91 → 0.93 s** | 2.78 → 1.34 s | 4–8 → 5–5 | 9–12 → 9–11 | 7–9 → 7–9 | 11–12 → 12–12 |
| | zh-CN | 1.00 → 0.94 s | 2.66 → 1.43 s | 4–6 → 4–6 | 10–11 → 11–11 | 7–10 → 8–9 | 11–12 → 11–12 |
| DeepSeek V4.1 Flash | en | 1.34 → 1.14 s | 2.59 → 1.39 s | 4–5 → 2–3 | 9–12 → 10–11 | 5–8 → 7–9 | 12–12 → 12–12 |
| | zh-CN | 1.35 → 1.19 s | 2.60 → 1.42 s | 0–4 → 1–3 | 10–11 → 10–12 | 9–11 → 9–11 | 11–12 → 12–12 |

- **Sonnet 5.5 is listed.** It holds every line on the fresh slice. The reply is one call in 48 of 48 presses, and the first whole option comes about 2.7 s sooner.
- **Sonnet's regression line.** On the 24 cases, English "cited" stayed below today's (10–11 against 12–12), all of it on en2-ask-store (three runs) and en2-answer-unknown (one).
  - In two presses, Sonnet wrote no marker on the claim that rests on the connectors line.
  - In two, one marker covered two facts, and the quote taken was the line most like the whole sentence (webhooks), not the connectors line.
- **Haiku 5.5 isn't listed.** Its first English option came later on both sets, though by 0.10 s and 0.02 s, and every quality line held. Haiku already writes its reply in its first request on today's path; the step saves it the `cite` round trip, about 1.3 s to done.
- **DeepSeek isn't listed.** Its first Chinese option came 0.09 s later on the fresh slice, as with step 4: it already writes its Chinese reply in its first request. Every other line held on both sets.
- **False Supported on the step's arm,** read in its replies:
  - a quote was taken from a line sharing only the Document's own name with the claim ("Driver app");
  - a claim listing three facts got quotes for two of them.
- **Spend:** these six runs, $6.02. With the first runs, the stopped ones and the probes, $10.24 for this gate; this work's ledger reads $31.64.
