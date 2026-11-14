# The real-model check of a question typed during the call, confirming round (#2925)

Written and committed on 2026-11-13T15:01Z, before any run it gates. The second round (`call-help-typed-question-2.md`) counted and failed. The second reader then ruled what this pull request builds: steps 1, 2 and 4 of the plan read on #3033, and not step 3. This round confirms them, with the second round's bars, on a slice that none of them has seen.

What changed since the second round:

- **Step 1, the one request for Citations, asked about the right lines** (e51d335d9). A typed reply's request for Citations is asked about its uncited lines of fact and about the list items that share one Citation, and its answer is taken on those lines alone.
- **Step 2, one reader of a reply** (#3046, from `main`). An option to say loses a pair of quotation marks the model wrapped it in, and the reply is kept as read, so the check, the assistant, Check again and the note read the words the panel shows. What a typed reply says before its first option shows first once the reply ends (5e2231bcd).
- **Step 4, a reply in another language made anew once** (d2f324dc6, 757ef5566). When the question and the call are in one language and the reply's first line is in another, the same request is made again, once, and nothing of the first reply's Citations or figures reaches the Answer.

A button's instructions and request, the rule for writing an option (#2847), the earlier call's words (#3005) and the typed question's instructions (4f7e5f884) are unchanged.

## The run

- **The slice:** `call-help-typed-fresh-2` (`../callHelpTypedFresh2.ts`), 24 cases: 12 English and their Chinese twins, about a commercial cleaning contractor's offer of a three-year contract to an office tower's landlord. A writer who had seen neither the change nor any reply of the rounds before wrote it for this round, and no prompt has seen it. It is on this branch exactly as the writer gave it: it type-checks against the real types with no change.
  - **Six a language rest on a line:** a price, what is included and its limit, a line said earlier, the most to offer without approval, a list item by item, and what to say to a worry a Document answers, pointing at what they just said.
  - **Six a language have no Document fact**, each with a nearby Document that gives a related fact a careless reply could cite: a follow-up asking for a Sunday price, a cancellation fee, whether damage to a tenant's equipment is insured and up to how much, the most to give away free without approval, what to say to a worry about cleaners changing, and what to say when they ask for a certificate number.
  - Each case presses a button, waits for its reply and its marks, asks a follow-up's earlier question if it has one, then types its question; only the question's reply is read. Each Library holds three or four Documents of the same business, most of them not about the question. Every case's Note is empty.
- **Model:** Claude Haiku 5.5 on a direct Anthropic key, as the Answers model. **Judge:** Claude Sonnet 5.5, never a model under test; for a follow-up, it is shown the question followed up.
- **Arms:** `today` against `today`, each arm first in half the pairs, so each case is answered twice: 48 replies. One run. False Supported is counted over the slice (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **A dry run, a smoke run, then the run.** The dry run builds every setting as the run does, but sends a key that is no key, so the provider refuses every request and nothing is spent; it opens every case. The smoke run is one case on both arms (`INCARNAMIND_EVAL_SPEED_ITEMS=en-fresh2-price`).
- **Spend:** the second round's 40 replies cost $0.15, the judge $0.08 of it, and its smoke run $0.01. This round's 48 replies, with the requests steps 1 and 4 add, are about $0.20, and $0.01 for the smoke run. The stop is **$0.50** for the smoke run, the run and one rerun of a void run together. One ledger holds it (`INCARNAMIND_EVAL_SPEED_LEDGER`, `INCARNAMIND_EVAL_SPEED_STOP_USD=0.5`).
- **A run counts only whole:** one with a request refused, failed or timed out is void, and is run again once, inside the same $0.50. A request stopped because its reply was made anew (step 4: the reply then ends, after the same request again) is the step working, not a stop, and is counted under step 4.
- **The record** keeps, for each typed reply, what each request for Citations replied (`[citations asked]`), what it showed before it was written again (`[written before]`), its uncited lines beside the Answers before it, and every request with its outcome.

```sh
INCARNAMIND_EVAL_SPEED_PAIRED=today,today \
INCARNAMIND_EVAL_SPEED_SETS=call-help-typed-fresh-2 \
INCARNAMIND_EVAL_SPEED_MODELS=anthropic/claude-haiku-5-5 \
INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-sonnet-5-5 \
INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted \
INCARNAMIND_EVAL_SPEED_STOP_USD=0.5 \
INCARNAMIND_EVAL_SPEED_LEDGER=<a new ledger file> \
npm run eval:speed -- eval/speed/paired.speed.ts
```

## The bars, per language, over its 24 replies (12 cases, both arms)

The second round's, on this slice:

1. **Cited:** of the 12 replies whose case rests on a line, at least 11 cite that line with a found Citation.
2. **A ✓ the judge finds unstated:** at most 1, read by sentence: a ✓ beside the very sentence the judge lists.
3. **Graded right:** at least 22, against the case's expected answer and what it must not give as so.
4. **Out of form:** at most 1 (`formFailures` in `../callHelp.ts`, reading all the panel shows of an item: its sentence, its notes and its "→" line).
5. **What it doesn't know:** all 12 replies to the six cases with no Document fact are graded right.
6. **Language:** no reply in a language other than the question's (no `language` failure).
7. **Anything else:** no Tool call left as text, no reply that showed nothing, no case failing to run.

## Steps 1 and 4, each on its own

Counted from the record per language, and reported beside the bars:

- **Step 1:** the typed replies whose request for Citations ran; the lines it was asked about; the Citations it gave that were taken, and of those, how many are found, how many show ✓ and how many the judge finds unstated.
- **Step 4:** the replies made anew, each with its first line's language and the new reply's; and any reply made anew whose question and call are in two languages, which should be none.

## Reported, not a bar

- **The fact questions whose reply comes laid out as options:** of the 18 replies a language to the nine questions that ask for a fact or a list (all but the three asking what to say), those the reader lays out as options. Their words, on a line of their own with a "→" under it, are read as an option to say, so the model's quotation marks come off and they are no longer looked for as a quotation. Each is listed with its reply.
- Each failing reply with the step that wrote what the User saw.
- Each reply as the panel shows it, with its Citations' checks and its grade.

## What follows, fixed now

- **Every bar holds:** the pull request merges on the lead's word, with the box.
- **Only bar 5 fails, and only in Chinese:** nothing is reworded or run again, and it goes to the owner as a decision to ship.
- **Any other bar fails:** the pull request is held and goes back to the second reader.
