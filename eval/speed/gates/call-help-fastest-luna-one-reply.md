# The gate for Fastest call help on GPT-6 Luna, in one request (#3354)

Written on 2026-11-19 before any run it gates, at the owner's choice of this test; committed with its results.

## The change

As `call-help-fastest-luna.md` (on branch `feat/3354-fastest-luna`), with one difference: under Fastest, Luna answers a press in one request, its records first, as GPT-6.1 Sol does since #3359 (`call-help-one-reply.md`), not in the Tool loop. That gate failed in Chinese, where Luna's two requests ended later than Sol's one.

## The runs

- **Arms:** `help-answers-model` (GPT-6.1 Sol, one request) against `help-fastest-one-reply` (GPT-6 Luna, one request), paired.
- **The set:** the call-help set, 30 cases, 15 English and 15 Chinese; three runs of every case; false Supported counted over the set.
- **Model:** GPT-6.1 Sol through OpenRouter as the Answers model; its provider's quick model `openai/gpt-6-luna`. Judge Claude Sonnet 5.5 for both arms. Stops at $3.

## The bar

The bar of `call-help-fastest.md`, unchanged. Per language, a range is the lowest and highest of the three runs' counts. It ships only if, in each language:

- **False Supported:** the Luna arm's lowest is not above the Sol arm's highest.
- **Every Citation found:** the Luna arm's highest is not below the Sol arm's lowest.
- **Faster:** the Luna arm's median time to the first whole option and to the end are both below the Sol arm's.

Reported plainly, not held: expected Passages cited and judged right, with the same ranges; replies that showed nothing, broke the form or failed to run. A missed line is reported as missed, and Luna is not offered. No rerun for a better draw.

## Result, 2026-11-19: every Citation found misses in Chinese; Luna is not offered

`eval/results/speed-paired-2026-11-19T11-35-14-418Z`, at origin/main 4492cf5cf with Luna listed and the arm added for the run only, 90 pairs, none failed, $0.80. Ranges over the three runs, GPT-6.1 Sol (one request) → GPT-6 Luna (one request):

| Language | False Supported | Every Citation found | Cited | Judged right | First whole option, median | Done, median |
|---|---|---|---|---|---|---|
| en | 1–2 → 1–2 | 15–15 → 15–15 | 13–14 → 12–13 | 10–11 → 10–12 | 3.60 → 2.00 s | 4.24 → 2.33 s |
| zh-CN | 0–1 → 1–2 | **15–15 → 13–14** | 12–12 → 12–14 | 8–9 → 12–12 | 3.53 → 2.00 s | 4.10 → 2.51 s |

- **Fails:** in Chinese, Luna's highest count of replies with every Citation found (14) is below Sol's lowest (15). False Supported and faster hold in both languages; English holds every line.
- **What was not found:** in zh-answer-total, in all three runs, Luna's quote of the price line was not the line's words: cut at "320 元" with "，" turned into "。", or two lines of the sheet run together as one quote. In zh-sum (one run), a quote of the User's words ran across two lines of the call.
- **Seen beside:** one zh-answer-total reply showed "合计每月  元", its total left out, where its calculation wasn't worked out.
- Luna is twice as fast as Sol in one request. It would need its quotes to keep a line's own words in Chinese, and a reply that never shows a figure left out, before a next try.
