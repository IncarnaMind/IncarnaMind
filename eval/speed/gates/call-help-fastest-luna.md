# The gate for Fastest call help on GPT-6 Luna (#3354)

Written on 2026-11-19 before any run it gates, and committed with its results.

## The change

Settings › Meetings › Help during the call offers Fastest under an Answers model of OpenAI (an OpenAI key, or the ChatGPT plan, which serves OpenAI's models) and of OpenRouter, as it does under Claude since #2526: call help then answers on the provider's quick model, GPT-6 Luna (`openai/gpt-6-luna` on OpenRouter), thinking off. Same as Answers stays the default. Under GPT-6.1 Sol, Same as Answers answers in one request (`call-help-one-reply.md`); Luna answers in the Tool loop, two requests, with no thinking.

What is known before the run: on the ChatGPT plan, on screen, Sol's presses end in 4.1–6.3 s with one at 8.7 s; Luna's, in the loop before #3359, in 5.6–11.1 s, when the plan sent no reasoning setting. #3359 has the plan ask Luna for none.

## The runs

- **Arms:** `help-answers-model` against `help-fastest`, paired, as `../README.md` › Paired runs says.
- **The set:** the call-help set, all 30 cases, 15 English and 15 Chinese.
- **Model:** GPT-6.1 Sol through OpenRouter as the Answers model; its provider's quick model is `openai/gpt-6-luna`. The judge is Claude Sonnet 5.5 for both arms.
- **Samples:** three runs of every case (`INCARNAMIND_EVAL_SPEED_RUNS=3`), false Supported counted over the set.
- **Spend:** stops before the next item at $3.

## The bar

The bar of `call-help-fastest.md`, unchanged. Per language, a range is the lowest and highest of the three runs' counts. It ships only if, in each language:

- **False Supported:** `help-fastest`'s lowest is not above `help-answers-model`'s highest.
- **Every Citation found:** `help-fastest`'s highest is not below `help-answers-model`'s lowest.
- **Faster:** `help-fastest`'s median time to the first whole option and to the end are both below `help-answers-model`'s.

Reported plainly, not held, as there: expected Passages cited and judged right, with the same ranges; replies that showed nothing, Tool calls left as text and cases that failed to run.

A missed line is reported as missed, and Luna is not offered. No rerun for a better draw.

## Result, 2026-11-19: Chinese is slower; Luna is not offered

`eval/results/speed-paired-2026-11-19T07-33-22-017Z`, at origin/main fb5156390 with Luna listed for the run only, 90 pairs, none failed, $0.74. Ranges over the three runs, `help-answers-model` (GPT-6.1 Sol, one request) → `help-fastest` (GPT-6 Luna, the loop):

| Language | False Supported | Every Citation found | Cited | Judged right | First whole option, median | Done, median |
|---|---|---|---|---|---|---|
| en | 0–1 → 1–2 | 15–15 → 15–15 | 13–13 → 13–14 | 11–12 → 10–11 | 3.61 → 3.27 s | 4.07 → 3.56 s |
| zh-CN | 0–1 → 0–5 | 14–15 → 14–15 | 12–13 → 13–14 | 10–12 → 12–13 | **3.47 → 4.01 s** | **3.84 → 4.52 s** |

- **Fails:** in Chinese, Luna's first option and end are both later than Sol's. False Supported and every Citation found hold in both languages.
- So Fastest stays offered under Claude only. Since #3359 a press on Sol is one request, and Luna's two requests in the loop gain little on it; a quicker model would need one reply too, through `call-help-one-reply.md`'s gate.
