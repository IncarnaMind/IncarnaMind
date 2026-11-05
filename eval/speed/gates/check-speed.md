# The gate for a check's speedups

Written and committed on 2026-11-04, before any run it gates. Each speedup is a step of its own, measured against today's path; a step that fails any line below keeps today's path, and the reason is written here.

## The budget

From #1624: Check this Note on 10 sentences shows its first verdict under 5 s and finishes under 15 s. An Answer's sentences and a write's checked sentences are measured the same way, from the moment the Answer or the write ends: the first verdict on the page, and the last.

## The timing runs

`INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note,write,answer` (`../README.md` › Where a check's time goes), on Claude Haiku 5.5 and Claude Sonnet 5.5 on a direct Anthropic key, English and Chinese, two runs each on Haiku and one on Sonnet, today's path and the step's, one after the other on the same computer. A step is kept only where it makes the median first verdict or the median end sooner, and neither later.

## Two kinds of step

**Steps that change only when the requests are sent** (more checks at once, a verdict written to the page as it lands): every request a sentence's check sends is the same, byte for byte, whatever runs beside it, so they can't change a verdict. (Added 2026-11-05: one exception, an `Id.` or `supra` a record cite resolves from the Note as it reads then.) Their gate is path identity: a unit test shows a sentence's requests are identical under the step and without it, and that each verdict reaches the page with the same mark. The timing runs' verdicts are reported beside it; a sentence whose verdict differs between the arms is the model's own variance unless it repeats: it is checked three more times on each arm, and the step fails if the step's arm calls it Supported more often than today's while the Documents don't state it.

**Steps that change what the judge is sent** (thinking set lower, a check that reads its Citation's Passage before it searches, one request for several sentences): these can change a verdict, so they are gated on real models:

- **Sets.**
  - The second written held-out set (`../writtenHeldOut.ts`): 30 sentences over the membership rules in each language, 7 the rules state and 23 near-copies they don't, among them dropped and changed conditions (`condition`, `qualified`), should, may and must for one another (`force`) and the parties the other way round (`parties`). Each verdict's line names the Passage it rests on.
  - The 40-check set (`eval/repeats`: `en`, `zh`, `en-control`, `zh-control`), for a step that reaches Check this Note.
  - For a step that reaches an Answer's sentences: the same 30 held-out sentences, cited and judged as an Answer judges its own (the `answer` flow), and `npm run eval:support`'s cases.
- **Scope.** Every case is checked in a Library of only its own Documents, so a verdict can't rest on another case's Document; a sentence the check reads only against its Citation's Passage is recorded with that Passage.
- **Models.** Claude Haiku 5.5 and Claude Sonnet 5.5, English and Chinese; three runs of each arm on Haiku and two on Sonnet, since one sentence's verdict varies from request to request.
- **Bars,** per model, on the sentences both arms finished, both languages together:
  - **no new false Supported:** no sentence the Documents don't state is Supported in more of the step's runs than of today's;
  - **judged right** (Supported for a sentence the Documents state, anything else for one they don't) no lower than today's by more than one sentence in 30, rounded down;
  - **not checked** no higher than today's by more than one sentence in 30, rounded down.

## Reported, not gated

Per model, language and flow: requests per sentence and of which kind, searches, turn checks that sent the model back, failed requests and retries, the time each request waited for its first byte and thought, the time between a sentence's requests (searching and reranking, and waiting for a free place), cached input tokens, the load, and what the run cost.

## Results, 2026-11-05

- **Twelve at once on an Anthropic key: not met on the first runs.** A test held path identity (since taken out with the step), with no failed request and no rate limit. The end came sooner in all 14 cells of model, language, flow and Library, by 0.3 to 5.6 s. But the first verdict came 0.1 to 0.6 s later in 5 of them (Luna's Chinese Note, Haiku's Chinese Note on the mixed Library, and the writes on Haiku in Chinese and on Sonnet in both languages), so the line "neither later" was not met. The step was decided instead by `check-speed-twelve.md`, which says how much later counts as later and was committed before its own runs. It wasn't met there either, so the step keeps today's six.
- **A write's marks as each lands: kept.** Path identity holds (`tests/core/writtenChecks.test.ts`). The first mark came 8.2 to 14.1 s sooner and the end didn't move.
- **An Answer's batches without thinking: failed, kept today's path.** On Claude Haiku 5.5, 11 sentences the rules don't state were Supported in more runs than today's: the dropped conditions in both languages, the lead-in and `copy-damage`. Judged right fell from 129 to 105 of 180, with 6 allowed. On Sonnet 5.5, 2 sentences were Supported in more runs (`copy-damage`, `notwithstanding`), with judged right 93 → 94 of 120.
