# The gate for call help on the fastest model (#2526)

Written and committed on 2026-11-08, before any run it gates.

## The change

Call help answers on the quick-tasks model of the Answers model's own provider, thinking off, unless the User chooses Same as Answers in Settings › Meetings › Help during the call (decided on #2526 on 2026-11-08: fastest by default). Under Claude Sonnet 5.5 on Anthropic, that is Claude Haiku 5.5. It is the same service with the same key, so nothing goes anywhere new. A model on this computer, or in Ollama, keeps call help; where the provider has no quick model, or refuses it, the Answers model answers. Nothing else changes: the prompt, the Tools, the form and the Citation check are as on `main`.

What is known before the run: on today's path Sonnet 5.5 shows a whole reply at about 4.3–4.7 s on this set (`call-help-records-first.md`), and Haiku 5.5 and DeepSeek V4.1 Flash give first words at a median of 1.2–1.6 s by hand (#2526). On 2026-11-05 Haiku answering first under Sonnet ended 4.2 s sooner at the median, with judged right 16 → 13 of 30 (#2541's review); that path went to Sonnet when a reply failed, and this one never does. The decision accepted Haiku's replies being less complete; it did not accept a wrong Supported mark or a Citation that isn't found.

## The runs

- **Arms:** `help-answers-model` (call help on the Answers model, as before this change) against `help-fastest` (this change's default), paired, as `../README.md` › Paired runs says, each saving its choice before each item as the User would.
- **The set:** the call-help set, all 30 cases, 15 English and 15 Chinese (`../callHelpCases.ts`), on the fixed call rig. Earlier runs of other steps have seen it; nothing in this change was written or tuned against it, since it changes no prompt, rule or wording, only the model that answers.
- **Model:** Claude Sonnet 5.5 as the User's Answers model on a direct Anthropic key; its provider's quick model is Claude Haiku 5.5. The judge is Claude Opus 5.5, the same for both arms. If the key runs out of credit mid-run, the run goes on with another direct Anthropic key (same model and endpoint), noted here with its time; never another route or model within this gate.
- **Samples:** three runs of every case (`INCARNAMIND_EVAL_SPEED_RUNS=3`), the arms' order turning case by case, false Supported counted over the set (`INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`).
- **Load:** a run starts only once the 15-minute load is 24 or less.
- **Spend:** about $3.20 (a Sonnet press about $0.018, a Haiku press about $0.006, the judge about $0.006 a press). The cap for this work is $4: the ledger stops the run before the next item once $3.90 is spent, and the pairs both arms finished are read.

## The bar

Per language, from each run's per-case records (`report.json`), a range is the lowest and highest of the three runs' counts.

**It ships only if:**

- **False Supported** (cases with a sentence its found Citation doesn't state): `help-fastest`'s range does not sit above `help-answers-model`'s; its lowest is not above the other's highest.
- **Every Citation found:** `help-fastest`'s range does not sit below `help-answers-model`'s; its highest is not below the other's lowest.
- **Faster:** `help-fastest`'s median time to the first whole option, reading or line, and to the end, over its presses in that language, are both below `help-answers-model`'s.

**Reported plainly, not held** (the decision accepted this trade): expected Passages cited and judged right, with the same ranges, saying where `help-fastest`'s range sits below; replies that showed nothing, Tool calls left as text and cases that failed to run, on both languages together.

## Reported beside

The first sign and the first words; done at the 90th percentile; where the time went (each request's first byte, first text and end); every case with a false Supported on either arm, with its sentence; the pooled count of presses with a false Supported per arm over the three runs; the spend and the load.
