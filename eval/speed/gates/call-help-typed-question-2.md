# The real-model check of a question typed during the call, second round (#2925)

Written and committed on 2026-11-13, before any run it gates. The first round (`call-help-typed-question.md`) counted and failed. It is read on #3033: which step wrote each failing reply, why typed replies met the request to cite again, and its bar 2 by sentence. This round measures what changed since, and nothing else:

- **The typed question's own instructions** (4f7e5f884). Its language is named ("Write in Simplified Chinese, the language the User typed the Question in"). A reply's first words say what isn't known, and an option then promises nothing. Each listed item cites its own words. A reply says what it found, never where it looked or what it didn't find.
- **What a typed question is given** (9d63a4b69). It reads the call's earlier Answers as their words, without their Citations, so no earlier Citation id is shown and the request to cite again has nothing to run on.
- **The yardstick** (6d8f12561). A typed reply's judge reads each place a Citation shows under a number of its own, so a ✓ counts as unstated only beside the sentence the judge lists. The run also keeps what each reply showed before it was written again, and the reply's uncited lines beside the Answers before it.

A button's instructions and request, the rule for writing an option (#2847) and the earlier call's words (#3005) are unchanged.

## The runs

- **The slice:** `call-help-typed-fresh` (`../callHelpTypedFresh.ts`), 20 cases: 10 English and their Chinese twins, about a commercial solar installer's offer to a warehouse owner. It was written before the wording was frozen, by a writer who saw neither the instructions nor the first round's replies, and no prompt has seen it.
  - The ten kinds: a price; what is included, and its limit; a line said earlier; the most to offer without approval; a fact no Document gives; a list, item by item; what to say to a worry; a follow-up that needs the question typed before it, asked after a reply that cites; a question pointing at what the other side just said; and what to say when they ask for a fact no Document gives.
  - Each case's Library holds three or four Documents of the same business, most of them not about the question, so a search ahead can miss.
  - Each case presses a button, waits for its reply and its marks, asks a follow-up's earlier question if it has one, then types its question. Only the question's reply is read.
  - Every case's Note is empty, so a typed question in a Note that holds Citations isn't measured here (#3040).
- **Model:** Claude Haiku 5.5 on a direct Anthropic key, as the Answers model. **Judge:** Claude Sonnet 5.5, never a model under test; for a follow-up, it is shown the question followed up.
- **Arms:** `today` against `today`, each arm first in half the pairs, so each case is answered twice. One run. False Supported is counted over the slice (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **A smoke run first:** one case on both arms (`INCARNAMIND_EVAL_SPEED_ITEMS=en-fresh-price`), then the run.
- **Requests:** the first round made 265 Haiku requests for 36 replies, and its judge one or two Sonnet requests a reply. This round's 40 replies: about 300 Haiku and 40 to 80 Sonnet requests; about 16 and 2 to 4 for the smoke run.
- **Spend:** the first round cost $0.13 and its smoke run $0.01. This round is about $0.16 with the smoke run. The stop is **$0.50** for the smoke run, the run and one rerun of a void run together, inside the pull request's $2, of which $0.14 is spent. One ledger holds it (`INCARNAMIND_EVAL_SPEED_LEDGER`, `INCARNAMIND_EVAL_SPEED_STOP_USD=0.5`).
- **A run counts only whole:** one with a request refused, failed or timed out is void. It is run again once, inside the same $0.50.

```sh
INCARNAMIND_EVAL_SPEED_PAIRED=today,today \
INCARNAMIND_EVAL_SPEED_SETS=call-help-typed-fresh \
INCARNAMIND_EVAL_SPEED_MODELS=anthropic/claude-haiku-5-5 \
INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted \
INCARNAMIND_EVAL_SPEED_STOP_USD=0.5 \
INCARNAMIND_EVAL_SPEED_LEDGER=<a new ledger file> \
npm run eval:speed -- eval/speed/paired.speed.ts
```

## The bars, per language, over its 20 replies (10 cases, both arms)

1. **Cited:** of the 16 replies whose case rests on a line (all but the two unknown cases), at least 15 cite that line with a found Citation.
2. **A ✓ the judge finds unstated:** at most 1, read by sentence: a ✓ beside the very sentence the judge lists. The count by Citation, the first round's reading, is reported beside it.
3. **Graded right:** at least 18, against the case's expected answer and what it must not give as so.
4. **Out of form:** at most 1 (`formFailures` in `../callHelp.ts`, reading all the panel shows of an item: its sentence, its notes and its "→" line). An option that fails only because its "→" line counts is out of form, and is listed with its words.
5. **What it doesn't know:** all four replies to the two unknown cases (`*-fresh-unknown`, `*-fresh-unknown-say`) are graded right.
6. **Language:** no reply in a language other than the question's (no `language` failure).
7. **Anything else:** no Tool call left as text, no reply that showed nothing, no case failing to run.

**Bar 2 stays a bar.** If it alone fails, it goes to the second reader with each ✓ and what the same sentence reads at a button on `main`; it isn't waived ahead.

Reported beside the bars:

- Each failing reply with the step that wrote what the User saw, now from what the run keeps.
- How many typed replies met the request to cite again (none is expected).
- How many typed replies repeat an earlier Answer's fact with no Citation: no ✓ there is right, and the number is counted from each reply's uncited lines beside the Answers before it.
- Each typed reply's first words and end beside its button's.
- Each reply as the panel shows it, with its Citations' checks and its grade.

## If a bar fails

Step 3 doesn't claim the real-model box, the numbers with each failing reply go on #3033 and #2925, and no third wording is tried in this pull request before it comes back to the second reader.
