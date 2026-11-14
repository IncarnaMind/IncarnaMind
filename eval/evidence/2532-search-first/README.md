# The search-first check's gate (#2532)

Written and committed on 2026-11-14, before any paid request of this gate. The bars below are fixed. The one number they leave open, the margin for right sentences, is fixed by the rule in Bar 2 from Phase A's runs and committed here before Phase B starts. A bar changed after a paid request makes a new gate.

## What is gated

The check this pull request builds, on a model listed in `src/core/providers/catalog/checkPaths.ts` (`SEARCH_FIRST`):

1. **The app searches first.** A check of an uncited sentence searches the sentence's own words before its first request and hands the model those Passages as the Run's first search: a Passage that states the sentence word for word first, then the search's order, four in all, with a note to search again if they don't decide it.
2. **One reply for every part.** A sentence whose parts are known (Check this Note names them first) and that holds no figure is answered part by part in one request, from those Passages, each part in a Run's reply form, the records of all parts in the same reply. A part's reply is read as its Run's would be after the same search: it settles the part unless a turn check would send the Run back (to search again, to give its own words, a calculation, its Duty and Condition), it can't be read, or it leaves the part not checked. That part, and only it, goes on to its Run, which starts from the same Passages.
3. **A Note's searches as one batch.** Each sentence's own search starts as soon as the claims sort names the sentence, before its check has one of the six places, so the reranker takes the Note's searches one after another from the start. A search where a Passage states the sentence word for word isn't reranked: that Passage comes first without it.

Six checks at once stays.

## Arms

Both arms run in the same process, on one core per language, each Note a Note of its own, paired and alternated: in each round the arms take turns going first, the order turning from round to round.

- **`main`:** the branch with the path off for the model under test. It is `main`'s check: no hand-off, no first reply, no search ahead, every search reranked. The unit tests show the path off gives the same requests and marks as before (`tests/core/searchFirstChecks.test.ts`, the "not listed" case, and the existing check tests unchanged).
- **`search-first`:** the three steps above.

**Model:** Claude Haiku 5.5 (`claude-haiku-5-5`) on the Anthropic API with a direct key, in every phase. Sonnet 5.5 only if a step can't be read on Haiku, with a new approval. No Opus, no Fable.

**Optional Phase C, second provider:** DeepSeek V4.1 Flash (`deepseek-flash`) on the DeepSeek API, the `note-24` flow only. Why: the first reply asks for one JSON object carrying several parts' replies, and a model outside Claude may write it differently; DeepSeek also thinks before replying by default, which tests the first reply's room. Run only if the lead and the CEO approve it with the plan.

## Sets and flows (`INCARNAMIND_EVAL_SPEED_CHECK_TIMES`)

- **`note-24`, held out:** Check this Note on a Note of 24 sentences in each language (`eval/speed/searchFirstCases.ts`), over invented bike-share rider terms written for this gate and run by no prompt before: 8 sentences the terms state (4 word for word, 4 in other words), 8 wrong twins (may for must, a negation, another place, the parties the other way round, a dropped condition, another period, two other figures), 8 the terms don't state, on the same topics. Four sentences in each language are checked figure by figure (the free dry run found them), and go to their Run on both arms, with the Passages handed over on `search-first`. A fresh Sonnet 5.5 reader, shown the terms and the 48 sentences shuffled with no labels, agreed with every label before any run.
- **`note`:** Check this Note on the 10-sentence Note of `eval/repeats` (`en` and `en-paraphrases`, and their Chinese twins), the #1624 budget's case. Not held out: earlier gates have seen it.
- **`write`:** the assistant writes 30 cited paragraphs into a new Note, 12 of which are checked. Cited sentences take no hand-off: a timing that must not get worse.
- **`answer`:** an Answer of 30 cited sentences, judged in batches. Untouched by these steps: a timing that must not get worse.
- **Library (`INCARNAMIND_EVAL_SPEED_LIBRARY=mixed`):** each language's sets' Documents beside the mixed sample set (683 Passages), so a search reranks as many Passages as in a real Library, on the built-in reranker on this computer.

## Phases

- **Phase A, the margin:** `CHECK_ARMS=main,main`, `note-24`, 3 rounds, English and Chinese. Its spread fixes Bar 2's margin before Phase B.
- **Phase B, the gate:** `CHECK_ARMS=main,search-first`, `note-24,note,write,answer`, 3 rounds, English and Chinese.
- **Phase C (optional):** Phase B's `note-24` on DeepSeek V4.1 Flash, 2 rounds.

## The void rule, the probe and the stop

- **Void:** an arm-round is void when any of its requests was refused, failed or timed out (a retried request counts), or any sentence's mark says it couldn't be checked for a failure, a rate limit, a time limit, credit or a cap. A void arm-round voids its round for both arms. The report lists every void round; Bars 1 to 5 read only the rounds that count. A void round may be run again once, within the stop.
- **Probe:** before each round, one request of one token to the same key and model reads the key's rate-limit headers. The round starts only when more than 90% of every stated limit (requests, input tokens, output tokens) is left; otherwise the run stops there. Only the numbers are logged.
- **Stop:** each phase's stop is set as the core's own monthly cap, so the core refuses the first request past it, between requests and not only between rounds. Nothing goes past a stop; past it needs the owner's yes. The stops are in the plan sent for approval.

## Bars (per model, both languages together unless said)

1. **No wrong sentence Supported more often:** on `note-24` and `note`, no wrong twin or absent sentence (a sentence the Documents don't state) is Supported in more rounds on `search-first` than on `main`, sentence by sentence, and their totals are no higher.
2. **Right sentences Supported no fewer, beyond the repeat's noise:** on `note-24`, in each language, `search-first`'s right sentences Supported over its rounds is at least `main`'s minus the margin.
   - **The margin's rule, fixed now:** the larger, over the two languages, of the difference in right sentences Supported between Phase A's two `main` arms over their 3 rounds; at least 1. For scale, the pressure test's same 7 right sentences gave 4, 6 and 5 across three runs.
   - **The margin:** _written here from Phase A's report, before Phase B._
3. **Not checked no higher:** on `note-24` and `note`, `search-first`'s Not checked over the rounds no higher than `main`'s by more than one sentence in 24 per language.
4. **Faster where it should be, later nowhere:**
   - on `note-24` and `note`, in each language, `search-first`'s median end is sooner than `main`'s, and its median first verdict no later than `main`'s by more than `main`'s own spread on that flow and language (its slowest round minus its fastest);
   - on `write` and `answer`, `search-first`'s median first verdict and end no later than `main`'s by more than that same spread.
5. **Held-out data stays held out:** no prompt, instruction or rule of this pull request changes after Phase B's first paid request. A change made after it needs a new set and a new gate.

A model is listed in `SEARCH_FIRST` only when Bars 1 to 5 all hold on it. A bar that fails keeps today's check for that model, and the reason is written here.

## Reported, not gated

Per flow, language and arm: the first sign, the first mark, the first verdict and the end; requests a sentence and of which kind; uncached input a sentence (input tokens less those read from the cache); the seconds of a Note during which some search was running (the union of its reranks, their wait included); the reranks repeated; the load. On `note-24`: each sentence's Supported count on each arm, and on `search-first` whether its first reply settled it, or which parts went on to their Run and why (the turn check that would have sent the Run back, a reply that couldn't be read, a part not checked, or no first reply at all: a figure, nothing found). The share of sentences settled in one reply, by kind. The #1624 budget on `note`: first verdict under 5 s and done under 15 s.

## Results

_None yet. Each phase's report and its log go here as they finish._
