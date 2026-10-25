# The speed of every AI flow

`npm run eval:speed` times the AI flows (#1624) on real models, in English and Chinese, as the app runs them: through the core, over the sample reports in `data/`, with the built-in reranker on this computer. It prints two tables and writes them to `eval/results/speed-<time>/report.md`, with every run in `report.json`. Neither `npm test` nor CI runs it.

## What it measures

- **Each flow** (`flows.ts`), from the User's action: the first sign of work the window shows (a step, a spinner, the first words), the first words (in the panel or the page), the first change in the page, the end, and the longest wait with no new sign. Every flow is held to one rule: a sign within 0.5 s, and no silent wait over 2 s.
- **Each model request and local step** the flows made, from the core's own timing records (`src/core/timing`): by flow and step, the times to the first byte, the first reasoning, the first text and the end, with the tokens and the reasoning setting. A request made outside any tagged flow shows under its data flow (`tagging` for Tags, `classification` for Organize), so a new flow appears by itself.

The core keeps these records for any use of the app, in its own database, for 30 days: times, tokens and names, never text, and nothing is sent anywhere.

## Running it

Setting the variables is the consent to send the requests and Passages to each model:

```sh
INCARNAMIND_EVAL_SPEED_MODELS=anthropic/claude-haiku-5-5,kimi/kimi-k2.6 \
INCARNAMIND_EVAL_SPEED_KEY_ANTHROPIC=sk-ant-... \
INCARNAMIND_EVAL_SPEED_KEY_KIMI=sk-... INCARNAMIND_EVAL_SPEED_ENDPOINT_KIMI=intl \
npm run eval:speed
```

- `INCARNAMIND_EVAL_SPEED_FLOWS` runs only the flows named, `_LANGUAGES` only `en` or `zh-CN`, and `_RUNS` sets how many times each runs per model and language (3 by default).
- The ChatGPT plan signs in through a browser, which a run can't do: time it by hand in the app.
- Run it on a quiet computer and say the load: the log gives each run's load average.

## The token audit (#1634)

`INCARNAMIND_EVAL_SPEED_AUDIT=1` adds the token audit to the same run, or `npm run eval:speed:tokens`. For each model call it measures the exact prompt the core assembled and writes, per request kind and per flow:

- the tokens of the instructions, each Tool's description and schema, the Passages and their windows, the conversation history, and anything else, with the provider's counted input, cached input and output;
- the Tools each kind is offered and how often it called each one, so a Tool it never calls is named;
- the instruction blocks each kind carries, and whether a step of that kind relied on each block (its Tool was called) or no step used it.

The input, cached input and output are what the provider counted, from the same finish part the core's timing records keep. Every other number is estimated locally with the core's own estimator (`src/core/answers/context` `estimateTokens`) from the exact prompt text, and scaled per request by `counted input / local estimate`, so the parts sum to the counted input. The report says how far the local estimate was from the counted total before scaling; the split between the parts is as good as that estimator, and a part the prompt doesn't let apart (a selection before the Question, the provider's own framing) is named rather than guessed. Only numbers and Tool names are kept, never a prompt's or a reply's text.

The tables are in the run's report and in `tokens.json` beside it. A kind whose flows `INCARNAMIND_EVAL_SPEED_FLOWS` left out shows as not run, with no numbers, rather than as zeros.
