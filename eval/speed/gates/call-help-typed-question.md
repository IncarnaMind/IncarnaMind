# The real-model check of a question typed during the call (#2925)

Written and committed on 2026-11-13, before any run it gates. Step 3 of #2925 lets the User type a question about the call in the panel's field, in Ask. Its reply is asked for in the call's short form: one or two options to say, written by the buttons' own rule word for word (#2847's, unchanged), or one or two sentences, or the list the question asks for; grounded as a button's reply is, on the live transcript, the Note and the Documents found ahead for the question; in the question's language, an option to say in the call's. A fact a Document gives carries its Citation, whose ✓ comes from the sentence check as a button's does (#2847). This check holds it on Claude Haiku 5.5 before step 3 claims the box.

## The runs

- **The slice:** `call-help-typed` (`../callHelpTyped.ts`), 18 cases: 9 English and their Chinese twins, a commercial laundry's offer to a hotel group, every case with Documents of its own. Each presses a button, waits for its reply and its marks, then types its question; only the question's reply is read. Two cases a language were added on 2026-11-13 after the second reader's read of the plan, still before any run: a follow-up (`*-typed-followup`) whose question is asked after another typed question and needs that turn to be understood, its answer a Document's fact; and a question that points at what the other side just said without naming it (`*-typed-pointing`), its answer resting on a Document. The cases were written before any run, and no prompt has seen them.
- **Model:** Claude Haiku 5.5 on a direct Anthropic key, as the Answers model. **Judge:** Claude Sonnet 5.5, the runner's default, never a model under test. For a follow-up, the judge is shown the question it follows up.
- **Arms:** `today` against `today`, so each case is answered twice, in two cores of its own, each arm first in half the pairs. One run. False Supported is counted over the slice (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **A smoke run first:** one case on both arms (`INCARNAMIND_EVAL_SPEED_ITEMS=en-typed-price`), to see the wiring end to end; then the run.
- **Requests:** a typed case's reply takes about seven Haiku requests (the button's reply, its records and its sentence check; the question's reply, its records and its sentence check; now and then a judgement of the model's working), three more for a follow-up's question before it, and one Sonnet request for the judge, two when its first answer isn't JSON. About 260 Haiku and 36 to 72 Sonnet requests for the run; 14 and 2 to 4 for the smoke run.
- **Spend:** about $0.80 for the run and $0.05 for the smoke run, at the catalog's prices (Claude Haiku 5.5 $0.10 and $0.50 a million tokens in and out, Claude Sonnet 5.5 $2 and $10). The stop is $2 for both together, with the one rerun below, held by one ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`) and `INCARNAMIND_EVAL_SPEED_STOP_USD=2`.
- **A run counts only whole:** one with a request refused, failed or timed out is void. It is run again once, within the same $2.

```sh
INCARNAMIND_EVAL_SPEED_PAIRED=today,today \
INCARNAMIND_EVAL_SPEED_SETS=call-help-typed \
INCARNAMIND_EVAL_SPEED_MODELS=anthropic/claude-haiku-5-5 \
INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted \
INCARNAMIND_EVAL_SPEED_STOP_USD=2 \
INCARNAMIND_EVAL_SPEED_LEDGER=<the ledger file> \
npm run eval:speed
```

## The bars, per language, over its 18 replies (9 cases, both arms)

1. **Cited:** of the 16 replies whose case rests on a line (every case but the unknown one), at least 15 cite that line with a found Citation.
2. **No wrong ✓:** at most 1 reply shows a ✓ beside a sentence the judge finds its quoted words don't state.
3. **Judged right:** at least 16 are graded right against the case's expected answer and what it must not give as so.
4. **Its form, as the panel shows it** (`formFailures` in `../callHelp.ts`): a short reply has at most two items, none past 40 words or 80 Chinese characters; a question of what to say gets one or two options, each with its "→" line, the recommended one first; a list asked for gives every item. At most 1 reply leaves its form.
5. **What it doesn't know:** both replies to the case no Document answers (`*-typed-unknown`) are graded right: they say it isn't known, and claim no insurance, insurer, sum or policy.
6. **Language:** every reply's words are in the question's language (no `language` failure).
7. **Nothing else:** no Tool call left as text, no reply that showed nothing, no case failing to run.

Reported beside them: each typed reply's first words and end, from the question, beside the first words and end of the button pressed before it in the same case, from its press (the report's "A typed question beside its button"); each reply as the panel shows it, with its Citations' checks; and the judge's grade for each. The replies of the two new cases go on #2925 one by one, all eight, each with its Citations, their checks and its grade.

## If a bar fails

Step 3 doesn't claim the box, and the numbers, with each failing reply, go on #2925. A wrong ✓ (bar 2) is the shared sentence check's, which #2847's gates hold. A bar the question's own instructions decide (1, 3, 4, 5, 6) is answered by a change to them, then a run on a fresh slice written before it, under these bars and a stop of its own.

If a pointing case's replies miss its Document, the change is in what the search ahead is given (the question together with the call's newest lines, not the question alone), and that change goes to the second reader before it is made or run.
