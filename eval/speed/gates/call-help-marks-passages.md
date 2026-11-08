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

## Second look: how a quote is picked (added 2026-11-08, committed before any run on its set)

The trust review at 7e7f5b555 found the picker could give a Citation on weak evidence, in a flow that runs no claim check, so the green mark is the User's only verdict:

- "Yes, Enterprise is $39 a seat" was quoted from "Enterprise plan: $45 per seat" and shown found;
- a line sharing one word with the claim, only the Document's name, or a heading written without "#" was quoted;
- a short line sharing fewer of the claim's words beat a longer one sharing more (en2-ask-store).

### What changes

A quote is taken only from a line that holds the claim; `src/core/answers/markedPassages.ts` says how. In short:

- **Figures:** every figure a sentence gives in digits is in a quote taken for its markers, or none of them is recorded and the sentence shows uncited. A figure said in the call may stand beside one a quote holds ("your Android 10 phones won't run it: it needs Android 11 or later").
- **Words:** the first quote holds at least two of the claim's words, a CJK character counting half of one. Words of the Document's name are no evidence. A heading is never quoted: a "#" line, a table's header row, or a short line standing alone with no closing punctuation. A transcript line's time and speaker are no words of it.
- **Order:** the line holding the most of the claim's figures, then of its words, comes first. A further line is added when it adds two of the claim's words, a further figure beside one of its words, or a word no other line holds. A line whose figures are all other than the claim's is never added.
- **Negation:** a claim that is a line said again with a "not" more or less gets nothing from that Passage; a reply's own "No," before it doesn't count.
- **No model after the reply:** on this path, no request after the reply asks a model for the Citations the rules refused. Every Citation on the path is one the rules made.
- **Another language:** a press whose Passages are in another language than the call keeps `cite`, since a reply shares no words with them.

### The set

`../callHelpDocuments.ts` (`call-help-documents`), 12 English and 12 Chinese presses written for this look. Its Documents are written as people write them:

- paragraphs of several sentences and a table of figures;
- figures one step from the right one: a volume price beside the list price, battery life at each reporting interval, an onboarding fee beside the size at which it's waived;
- a Document whose name is in its own text;
- one call in each language over a Document in the other.

No run and no prompt has seen its calls, and no model has written a reply to them. Before any run, its Documents were used to check these rules with replies written by hand. That check led to two of the rules: the first quote ordered by figures (a table row of "60 元 | 1 年" lost to a prose line sharing more CJK pairs) and the lines about other figures left out. The bar is read on the model's own replies, which no rule was fitted to.

### The runs

- Claude Sonnet 5.5 on the direct Anthropic key, judged by Claude Opus 5.5.
- `today` against `help-marks-passages`, paired, three runs each, false Supported counted:
  - on `call-help-documents`;
  - on `call-help-fresh`, the slice that listed Sonnet before.
- One at a time, each started at a 15-minute load of 24 or less.
- If money allows within this look's $12: Claude Haiku 5.5 (judge Claude Sonnet 5.5) and DeepSeek V4.1 Flash 1017 (judge DeepSeek V4 Pro) on `call-help-documents`, reported only. Neither is listed by these runs.
- Spend: about $4 for Sonnet on the set and $2 on the slice; Haiku and DeepSeek about $0.70.

### The bar

Sonnet stays listed only if, on each of the two sets:

- **English cited and false Supported** hold on counts pooled over the three runs: the step's presses with the expected Passages cited are no fewer than today's, and its presses with a false Supported no more.
- **Every other line** holds as "The bar" above says: Chinese cited and false Supported, judged right and every Citation found by the range rule; done and the first whole option sooner per language; none new.

### Reported, not gated

- Each false Supported sentence on both arms.
- The share of found Citations whose quote doesn't state their sentence, per arm and language.
- How often each arm searched again.

### From the runs already made (their records, no new spend)

The share of found Citations the judge read as unstated (found-but-unstated), per arm, over all presses of each run:

| Run (commit) | Model | Language | today | step |
|---|---|---|---|---|
| First, 24 cases (8aaadba53) | Sonnet 5.5 | en | 13 of 90 (14%) | **34 of 115 (30%)** |
| | | zh | 14 of 97 (14%) | 13 of 99 (13%) |
| | DeepSeek | en | 10 of 81 (12%) | 16 of 92 (17%) |
| | | zh | 5 of 86 (6%) | 8 of 96 (8%) |
| Rerun, 24 cases (5680e53a0) | Sonnet 5.5 | en | 15 of 91 (16%) | **40 of 119 (34%)** |
| | | zh | 11 of 97 (11%) | 10 of 93 (11%) |
| | Haiku 5.5 | en | 20 of 78 (26%) | 30 of 95 (32%) |
| | | zh | 14 of 53 (26%) | 18 of 73 (25%) |
| | DeepSeek | en | 17 of 84 (20%) | 13 of 91 (14%) |
| | | zh | 7 of 78 (9%) | 7 of 73 (10%) |
| Fresh slice (5680e53a0) | Sonnet 5.5 | en | 9 of 50 (18%) | 12 of 61 (20%) |
| | | zh | 11 of 51 (22%) | 13 of 53 (25%) |
| | Haiku 5.5 | en | 8 of 40 (20%) | 6 of 49 (12%) |
| | | zh | 3 of 40 (8%) | 6 of 60 (10%) |
| | DeepSeek | en | 8 of 50 (16%) | 6 of 51 (12%) |
| | | zh | 6 of 51 (12%) | 4 of 56 (7%) |

- **Sonnet's English found-but-unstated was twice today's on the 24 cases.** Of the step's 40 in the rerun, 22 were on en2-sum: summary lines carrying four to eight markers on the call's Passages, each quote read alone against the whole line. The rest: en2-say-offline (5), en2-answer-unknown (3), en2-check-right (3), en2-want (2), en2-say-competitor (2), en2-ask-store (2), en2-no-deposit (1).
- **Cases with a false Supported**, pooled over three runs: Sonnet on the 24 cases 13 → 15 (en) and 11 → 10 (zh); on the fresh slice 6 → 8 and 11 → 10.
- Neither arm searched again in any Sonnet run; DeepSeek's today arm did once.
- The sentences, step's arm, Sonnet rerun (English): en2-answer-unknown "Webhooks and the API are available, so I'll confirm options in writing" quoting only the webhooks line, and "your IT team could connect NetSuite themselves" (twice); en2-say-competitor "so it isn't free on every plan. Shopify is included in every plan" (twice); en2-say-offline, three options promising a two-week trial, a named contact and a written rota from separate lines; en2-want, two moments whose words or time the quoted line doesn't hold; en2-sum, the five summary lines above; en2-no-deposit "walk through how the refund works"; en2-ask-store, the API line for "Webhooks are in every plan", and the webhooks line for "We connect to Shopify on every plan" (the review's case); en2-check-right, "which matches the 30-day term" against the speaker's own line (three).
- Today's arm, same run (English): en2-answer-total's computed $2,808 (three), en2-answer-earlier's "the on-site day is free" (three), en2-say-offline (two), en2-sum (four), en2-answer-edition (one), en2-ask-store (two).

## Third look: the picker after the review's probes (added 2026-11-08, committed before any run on this code)

The second look's code (53c7af2b6) was never run. Before its run, probes of its rules (replies written by hand, run through `markedPassages`) still found a Citation shown found for a claim its quote doesn't state:

- "Team is $52 a driver" quoted from "Enterprise plan: $52 per driver", and 团队版 from 企业版's line: the figure was held, the row named was another's;
- "The Team plan doesn't include single sign-on" quoted from "Single sign-on is included in the Team plan", and 不含 or 没有 against 含: a "not" said in other words;
- "They need 30 seats" quoted from "[0:30 Them] We need about 20 seats": a call's time read as a figure;
- "The minimum term is twelve months" from "24 months", 八折 from 九折: a number in words;
- "Standard keeps readings for 9 years" from "| Standard | $9 | 1 year |": an amount read as a count;
- a heading running straight into its text, or in bold.

### What changes

`src/core/answers/markedPassages.ts` says each rule; in short:

- **Names:** a name any Passage given gives a row or a thing, which the claim says, is in a quote whenever a quote names another one (a quote for a clause the claim negates, "I can't add live traffic to Team" from "…on Enterprise only", names no other row): a table row's first cell, a line's lead before its colon ("Team plan:", 团队版：), a word in capitals past a sentence's start ("on Standard and Premium", "SAP"). A quote naming nothing ("A faulty device is replaced within two business days") may stand for a named thing ("rugged tablets").
- **Figures with their kind:** "$9" is an amount, "50%" a share, "0:30" a time, "12 months" a span, "$52k" a scaled amount, "-30" a negative, each held only by its kind; "two", 两 and "one week" are numbers. A year of the Document's name or a heading ("2026" of "Service levels 2026") needs no quote. A figure the call said may stand beside a figure of its kind the quote holds ("your Android 10 phones" beside "Android 11"), but never in place of one ("15% off" said for a line's "10% off"), unless the line's figure is a bound the said one meets ("At 250 sensors" for "From 200 sensors"); and it draws no further quote from a line that happens to hold it ("minus forty" against "40 probes").
- **Negation:** a Passage whose line most like the claim says its opposite gives it nothing, and another line saying it is never quoted: a word said with a negation on one side and without one on the other, beside the same word ("doesn't include single sign-on"), unless the line names something the negated clause doesn't ("Team can't include live traffic" against "…on Enterprise only"); or the negated clause said again without it ("Not quite, single sign-on is in the Team plan"). "without", "cannot", "neither", "nor" and "none" count as negations, here and in `unmarkedQuotes.ts`. A reply's own answer before a comma ("No,", "Not quite,", 不，) negates nothing in its claim; any other lead does.
- **Headings:** also a "#" line inside a block, a line wholly in bold, and a short line with no closing punctuation and no figure that starts a block. Their words, like the name's, are no evidence.
- **Words:** endings are folded ("includes", "included"; "batteries", "battery"; "yearly", "year").
- **Sides of the call:** a claim quotes no transcript line of the other side than the one it names first: "they", "the customer", 对方, 他们 or 客户 for "Them"; "I" or "we" for "Me" (the trust review's "Speaker").
- **A marker vouches for its clause:** the words from the markers before it, so "Enterprise is $52 [^2], and route plans come weekly [^7]" is read for [^2] without its second clause. A marker may rest on a sibling Passage of the same Document (a transcript's next window).
- **A name the claim denies** ("I don't see NetSuite on our list") needs no quote.
- **A marker an earlier reply recorded** is read as naming its Passage anew, under a marker of its own (the trust review's "Marker numbers across replies"). A marker no rule reads, in a table row of the reply or naming no Passage given, goes, so it never shows a record its number holds.
- **Nothing after the picker:** on this path the engine no longer matches an uncited sentence to its likest line either, so a sentence the picker refused stays uncited.

### Checked before the run, at no cost

- **Hand-written replies on `call-help-documents`:** 24 right replies and 9 wrong ones, as the second look said. Every right reply keeps its Citations, but the two presses in another language than their Documents, which keep `cite`. Every wrong one loses them, but three that no rule here can tell (below).
- **The step arm's earlier Sonnet 5.5 replies,** from the runs at 5680e53a0 on `call-help-fresh` and the 24 cases, rebuilt from their records and run through this picker on a scripted press. So the fresh slice's earlier replies have been read while writing these rules: its run below is weaker evidence for them than `call-help-documents`, whose replies no rule has seen. Counted per option line, against how the judge had read its Citations then:
  - A first try asked every word of a claim that some line holds to be in a quote. It took away 23 English and 9 Chinese Citations the judge had read as stated, against 14 and 5 it had read as unstated, so it was narrowed to the names above.
  - This code (a769dd5a9): English keeps 78 of the 91 read as stated and Chinese 80 of 87; it takes away 8 and 5 of those read as unstated, and keeps a Citation, perhaps on another quote, on 20 and 21. On the fresh slice it loses none read as stated, but two whose markers the rebuild couldn't name.
  - The 13 English lost: three options giving a sum the reply worked out without `calculate` ("$2,808 a month"), three questions or quotes sharing one word with their line, four transcript lines the scripted press didn't show, two whose markers the rebuild couldn't name, and one ("I don't see NetSuite…, only Shopify and SAP") not traced. The 7 Chinese: one question, one year of the other edition's name (2025 against the 2026 sheet), and five lines the scripted press didn't show.

### The independent pre-review (2026-11-08, before the run)

A pre-review of this code, whose job was to break it, found more ways a quote could be recorded for a claim it doesn't state. Each general one was fixed before the run, with a test: units, scales and signs of figures; "one week"; a figure the call said standing in for the line's; "cannot"; a Chinese claim's first clause read as the reply's own "No"; a line's negation after its lead; a two-subject claim; a reply citing the wrong Passage; the side named first; a marker in a reply's table; and the engine matching a refused sentence to its likest line afterwards. The rest are below.

### What no rule here can tell

- Which figure goes with which in one sentence giving several: "about 5 years when a probe reports every 15 minutes, 3 years at every 5 minutes, and 2 years at every minute" holds "5 years at every minute".
- A condition left out: "Standard is $8" from "From 200 sensors, Standard drops to $8", and 55 元 the same way in Chinese.
- A row named only in the same sentence as another's fact: "基础版含短信告警" from "标准版和高级版含短信告警；基础版每条短信 0.3 元".
- Which side of the call said a line, where the claim says neither "they" nor "we", or both.
- A row named only by a line no other line names it in: "Text-message alerts are included on Basic" from that line and "On Basic, each text message costs $0.05", where no table names Basic.
- A row named in no Passage given: "Team is $52" on a Passage holding only Enterprise's line.
- A word the Passage doesn't hold at all, another word or a wrong one: "phone answers" for "email answers", "free" for "costs $5", "minimum term" for "Maximum term".
- An opposite said in other words than a negation: "excluded", "stopped including", 缺少, "every plan" for "Enterprise only", a ✗ in a table.
- A table's column: "$390 a month" from "| Team | $39 | $390 |" whose header says $390 is the year's.
- A person named instead of a side ("Sarah wants…").

### The runs and the bar

The runs are made at the commit that adds this section, whose code is a769dd5a9 (origin/main merged at 38cf2e90a). As the second look says: Claude Sonnet 5.5 on the direct Anthropic key, judged by Claude Opus 5.5; `today` against `help-marks-passages`, three runs, false Supported counted, on `call-help-documents` and on `call-help-fresh`, with the arms' order turning per model, set and language (#2791). The bar is the second look's. Spend: about $6, within this look's $10.

### The first run at 8675f554c compared the path with itself (added 2026-11-08, before the rerun)

`today` runs the lists as the branch has them, and the branch still listed Sonnet 5.5, so both arms took the marks path. The run was stopped after 34 of its 120 pairs, which spent $1.11 and count for nothing. Sonnet is now off `MARKS_PASSAGES`, so `today` is main's path again, and the runs above are made again on the same code. Sonnet is listed again only if this look's bar holds.


### Result, 2026-11-08: Claude Sonnet 5.5 isn't listed; English cited fell on both sets

The runs were made at 4c0d76e87, `today` on main's path, three runs of every press, judge Claude Opus 5.5, on the direct key. One-minute load 3.3 to 28.2, median 6.2; the 15-minute load stayed under 9. No press failed on either arm. Ranges are the three runs' lowest and highest, today → the step; medians over all presses.

| Set | Language | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|---|
| `call-help-documents` | en | 4.90 → 1.79 s | 4.90 → 2.51 s | 4–6 → 2–3 (15 → 7) | **11–12 → 11–11 (35 → 33)** | 11–11 → 10–11 | 11–12 → 12–12 |
| | zh-CN | 5.00 → 1.79 s | 5.00 → 2.63 s | 4–5 → 5–6 (14 → 16) | 12–12 → 12–12 | 10–11 → 10–11 | 12–12 → 12–12 |
| `call-help-fresh` | en | 4.25 → 1.61 s | 4.25 → 2.30 s | 1–3 → 1–2 (6 → 5) | **8–8 → 7–8 (24 → 22)** | 7–8 → 8–8 | 8–8 → 8–8 |
| | zh-CN | 4.18 → 1.71 s | 4.19 → 2.44 s | 2–3 → 2–3 (8 → 7) | 8–8 → 7–8 | 7–8 → 7–8 | 8–8 → 8–8 |

- **English cited, pooled, is below today's on both sets,** so Sonnet stays off `MARKS_PASSAGES` and the path ships switched off. Every other line holds by its rule.
- **The four English presses that lost "cited" lost it to the reply's markers, not to the picker:**
  - en4-check-right and en3-check-right (twice): "You said … [^1]; the agreement supports this" marked only the call's line, so the Document's line the case rests on was never named;
  - en4-ask-sites: the option about gateways carried no marker.
- **English false Supported fell by half on the new set,** 15 → 7 presses. Found-but-unstated: en 22 of 79 → 9 of 82 and 8 of 50 → 5 of 55; zh 16 of 69 → 22 of 81 and 8 of 47 → 14 of 57.
- **Cases with a false Supported,** presses over three runs, today → step, among them: en4-answer-onboarding 3 → 0, en4-answer-battery 2 → 0, en4-check-right 3 → 3, en4-say-outage 2 → 2, en4-answer-phone-zh 2 → 2 (it keeps `cite`); zh4-answer-texts 2 → 3, zh4-ask-sites 1 → 3, zh4-say-outage 0 → 3, zh4-check-right 3 → 1, zh4-answer-volume 3 → 2; en3-answer-two 3 → 0, en3-check-right 0 → 3, zh3-say-support 2 → 3. The step's are a claim saying more than its quote in words no rule reads ("which would cover your early-morning calls", 不过团队版其他需求都能覆盖), and check-right's "the agreement says" over the call's line.
- Neither arm searched again. The step took one request in 111 of 120 presses; today took two in 117.
- **Spend:** $5.04 for this run (judge $1.33), $1.11 for the stopped one: $6.15 of this look's $10.

## Fourth look: a check names both lines (added 2026-11-08, committed before any run on its slice)

The third look's English "cited" fell where a reply checking what was said against a Document named only the call's line ("You said … [^1]; the agreement supports this"), so the Document's line the press rests on went uncited.

### What changes

- **The marks path's instructions** (`MARKS_PASSAGES` in `src/core/answers/prompt.ts`) add one line: "When a sentence checks what was said in the call against a Document: if the Document supports it, put both markers right after what was said, the call line's and the Document's, as "you said X [^1][^4]"; if the Document contradicts it, put the call line's marker after what was said and the Document's after what the Document says." Its example names no press of any set.
- The picker is as the third look ran it. Its extra negations ("without", "cannot", "neither", "nor", "none") are now its own; `unmarkedQuotes.ts` counts the same negations as on main, so nothing outside the switched-off path changes.

### The slice

`../callHelpChecks.ts` (`call-help-checks`), 10 English and 10 Chinese presses written for this look: a shift-scheduling vendor and a restaurant group, four Documents a language (plans with a table and a volume price, kiosks, payroll export, data and privacy), none in a set before it. Each language has three presses checking what was said against a Document that supports it, one checking two claims the Document contradicts, three answers, and one each of say, ask and no. No run, prompt or probe has seen it; the picker's rules were not looked at against it.

### The run

- Claude Sonnet 5.5 on the direct Anthropic key, judged by Claude Opus 5.5.
- `today` (main's path: no model is on `MARKS_PASSAGES`) against `help-marks-passages`, paired, three runs, false Supported counted, the arms' order turning per model, set and language (#2791).
- Started at a 15-minute load of 24 or less. Spend: about $3.50, within the $8 for this look.

### The bar

Sonnet is listed only if, in each language:

- **Cited and false Supported** hold on counts pooled over the three runs: the step's presses with the expected Passages cited no fewer than today's, its presses with a false Supported no more.
- **Judged right and every Citation found** hold by the range rule ("The bar" above).
- **Sooner:** the step's medians of the first whole option and of done are below today's.
- **None new:** no more Tool calls left as text, replies that showed nothing, replies written while the live text was behind, or presses failing to run.

### Result, 2026-11-08: not listed; cited fell in both languages and false Supported rose

The run was made at dd50c809c, `today` on main's path, three runs of every press, judge Claude Opus 5.5, on the direct key. One-minute load 2.1 to 17.5, median 3.9; the 15-minute load stayed under 6. No press failed on either arm. Ranges are the three runs' lowest and highest, today → the step, pooled counts in brackets; medians over all presses.

| Language | First whole option | Done | False Supported | Cited | Judged right | Every Citation found |
|---|---|---|---|---|---|---|
| en | 4.87 → 1.70 s | 4.87 → 2.48 s | **3–5 → 4–6 (11 → 15)** | **10–10 → 8–9 (30 → 26)** | 10–10 → 10–10 | 10–10 → 10–10 |
| zh-CN | 4.88 → 2.18 s | 4.88 → 2.73 s | **2–3 → 3–5 (7 → 11)** | **9–10 → 9–9 (29 → 27)** | 10–10 → 8–10 (30 → 27) | 9–10 → 8–10 |

- **Sonnet stays off `MARKS_PASSAGES`.** Cited and false Supported fail in both languages; the times and the range lines hold.
- **The new line didn't change how Sonnet marks a check.** Six of the seven presses that lost "cited" are check-overtime (both languages, all three runs) and one check-warranty: the reply says "the payroll export document agrees" with only the call's line marked, as in the third look.
- **False Supported,** presses over three runs, today → step: en5-check-overtime 0 → 3, en5-check-warranty 2 → 3, en5-no-forecasts 0 → 3, en5-answer-growth 3 → 0; zh5-answer-offline 1 → 3, zh5-answer-growth 2 → 3, zh5-check-photos 0 → 2, zh5-check-warranty 2 → 0. Found-but-unstated: en 13 of 64 → 19 of 77, zh 8 of 57 → 14 of 78.
- One request in 55 of 60 presses on the step; today took two in 55.
- **Spend:** $2.72 (judge $0.68), so $8.88 for this look's three runs together.

## Fifth look: IncarnaMind finds the Document's line for a check that says a Document agrees (added 2026-11-08, committed with its slice before the code and before any run)

The fourth look's records were read press by press (posted on #2526). Every press that lost "cited" said a Document agreed while marking only the call's line ("You said … [1]; the payroll export document agrees."). Of the step's 26 presses with a false Supported, 8 came from those sentences and 5 from the picker:

- a compound sentence's other clause ("…含人工成本预测；入门版…另收 99 元") kept the right line out as one about other figures, and an overview line naming no plan was quoted;
- "I'll" gave the word "ll", so two words in common passed the floor;
- the transcript window a marker named won with a weak line over a neighbouring window's better one;
- "2-business-day" was read as a bare 2.

The rest were a table row read without its header or a total worked out with `calculate`, which the judge flags on today's arm too, and replies adding an inference or a promise to their quote.

### What changes

The picker's rules stay, and code never records a line that doesn't hold its claim. `src/core/answers/markedPassages.ts` says each rule.

- **A sentence that says a Document agrees.** A sentence's markers may name only the call's lines while its words after them name a Document (by its name, or as "the document" or 文档) with no negation. For such a sentence, IncarnaMind looks in the Documents given for the line that holds what was said, under the picker's rules: every figure by kind and unit, never the opposite, never a heading, and a row's name in the quote. It records that line under a marker of its own after those words. When no line holds it, the sentence's markers go and it shows uncited.
- **A compound sentence about two rows** is read clause by clause, split at its semicolon, when each clause names a row of its own.
- **The line holding the most of the claim wins** across the Passages of one Document or transcript, not the first Passage with any line that passes.
- **No word from a contraction's end:** "I'll", "we're" and "they've" give no "ll", "re" or "ve". A unit after a hyphenated "business" or "working" is read: "2-business-day" is two days.

The slice below was written and committed before this code. The rules come from the fourth look's replies and from no press of this slice.

### Changed before the run, after an independent pre-review (2026-11-08)

The pre-review found ways the first version of this code showed a quote as found for a sentence it doesn't state, so the list above changed before any run:

- **The Document's line holds the whole sentence,** with the words after the agreement too ("…agrees, though drivers start at 45 hours" gets nothing). It is recorded only when those words say the Document agrees (agree, confirm, support, match, the same; 一致, 相符, 支持 and their kin). "Differs" or "says otherwise" shows no negation, so it is left as it is, as is a sentence already citing the Document.
- **The line found for such a sentence, which no model named,** gives each figure of its kind and unit exactly ("40 hours" is no "40 shifts"), each unit of time the sentence names ("a month" is no "a year"), no row the sentence doesn't name, and no "only", "but" or 只 that the sentence doesn't say.
- **A sentence is read clause by clause only when each clause names rows of its own.** A clause is never quoted when its whole sentence says the claim's opposite. A further quote naming only rows other than the claim's is never added, and a quote naming only other rows holds none of the claim's figures.
- **The window a marker names keeps its quote,** as before. Taking the window holding the most of the claim picked a line with another figure (25 admins for 40), and the diagnosed press didn't need it.

### The slice

`../callHelpAgrees.ts` (`call-help-agrees`) holds 12 English and 12 Chinese presses. They are set at a hotel laundry service selling to a hotel group. Each language has four Documents: plans with a table, a volume price and a compound sentence about two plans; collection and delivery; damage and loss; billing terms. None of them is in a set before it.

Each language has:

- four presses checking what was said against a Document that agrees, one of them with a claim the other side made and with figures said in words;
- one press checking against a Document that disagrees on two claims;
- one press where the Document agrees with one claim and not the other;
- three answers with a near-miss figure;
- one no and one say;
- one answer from a Document in the other language, which keeps `cite` on both arms.

No run, prompt or probe has seen the slice.

### The run

- Claude Sonnet 5.5 on the direct Anthropic key, judged by Claude Opus 5.5.
- `today` (main's path: no model is on `MARKS_PASSAGES`) against `help-marks-passages`, paired, three runs, false Supported counted. The arms' order turns per model, set and language (#2791).
- Main is merged first, and the run starts at a 15-minute load of 24 or less.
- Spend: about $3.50, within this look's $10.

### The bar

Sonnet is listed only if all of these hold in each language, on counts pooled over the three runs:

- **Cited, judged right and every Citation found:** the step's presses are no fewer than today's.
- **False Supported:** the step's presses are no more than today's.
- **Sooner:** the step's medians of the first whole option and of done are below today's.
- **None new:** no more Tool calls left as text, replies that showed nothing, replies written while the live text was behind, or presses failing to run.

If any line fails, nothing ships, and the numbers go on #2526.
