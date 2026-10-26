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

## Paired runs

A change that makes a flow faster must not make it worse, and two separate runs differ by more than most changes do. A paired run asks each item of a set on two arms in the same run and the same core, today's path and the new one, one right after the other, the order turning item by item so neither always meets a prompt cache the other warmed. Each arm is read the same way, and the two are compared item by item.

```sh
INCARNAMIND_EVAL_SPEED_PAIRED=today,<new arm> \
INCARNAMIND_EVAL_SPEED_SETS=gating,hard,everyday,checks \
INCARNAMIND_EVAL_SPEED_MODELS=anthropic/claude-haiku-5-5 \
INCARNAMIND_EVAL_SPEED_KEY_ANTHROPIC=sk-ant-... \
npm run eval:speed
```

- **The sets.** `gating`: the gating set's 65 Questions (`eval/retrieval`), each asked in a Mind of its own. `hard`: the hard tier's Questions over its library (`eval/hard`, fetched into the cache; indexing it takes a few minutes), those whose quotes the stored text holds. `everyday`: the everyday requests (`eval/everyday`), held to their own guards. `checks`: Check this Mind on each Mind of `eval/repeats`, once a run.
- **What each arm's run gives**, from the User's action: the first sign of work, the first words (the Answer's own text that stayed, for a Question; the first words the core sends anywhere, for the others), the end of the last Answer (or of the check), and the model calls and tokens until then.
- **The guards**, over the items both arms finished: the expected Passages cited, each with its quote found; judged right (a judge grades the Answer against the expected Passages' words and the set's short answer: right, partly or wrong); every Citation found; no new false Supported (a sentence the Documents don't state, Supported); no new duplicate Answer; no new change claimed that no Tool made, nor another everyday guard failed; no more items failing to run. Each says how many items it lost and gained, and whether it holds: the first three with up to `INCARNAMIND_EVAL_SPEED_MARGIN` fewer items in 30 (none by default; say the margin before the run), the others with none new.
- **It stops** at the new arm's first false Supported that today's didn't give, at a key refused for credit or sign-in, and before the next item once `INCARNAMIND_EVAL_SPEED_STOP_USD` is spent (12 by default; the core's own count, and the judge's from the catalog's price).
- `INCARNAMIND_EVAL_SPEED_ITEMS` asks only the items named by id (a Question's, a request's, a check set's), and `INCARNAMIND_EVAL_SPEED_EACH` at most that many of each kind (a hard-tier difficulty, a gating group, an everyday kind), the languages taking turns: `EACH=3` asks 30 hard-tier Questions. `_LANGUAGES` and `_RUNS` (1 by default here) work as above.
- **The judge** is Claude Sonnet 5.5 on the Anthropic key, or Opus 5.5 when Sonnet 5.5 is under test, never a model under test; `INCARNAMIND_EVAL_SPEED_JUDGE=<kind>/<model id>` names another. It also judges the everyday requests' claimed changes.
- The report goes into `eval/results/speed-paired-<time>/`: `report.md` per model and set, then every item with both arms side by side; `report.json` has every run.

### Adding an arm

An arm is a path the core can take between two items without being opened again (`arms.ts`): its `prepare(core)` saves the settings it needs, as the User saves them (the quick-tasks model, say), its `request(params)` changes each model request as it is sent (a prompt's wording, a provider option), and its `paths` decide which faster Answer paths every model takes instead of the lists beside the catalog (`src/core/providers/catalog/answerPaths.ts`): `cite-first` and `write-then-cite` (#489) compare the two ways of citing on any model, and `retrieve-first` (#1633) answers from the Question's own search, made before the first call; `loop` keeps the Tool loop from the first call, so a model the list names already (whose `today` retrieves first) is still compared with it. The report's "Answered in one call" counts the Answers that made one call of their own (not counting the query's rewrite or translation): for `retrieve-first`, the rest fell back to the loop. Add it to `ARMS`, and name it after `today`. A change the product makes behind a switch of its own (an allowlist, a setting) is best paired through that switch; a change that replaces today's path keeps today's as an arm until the comparison is made. `today` against `today` shows how much two runs of the same path differ.

## The token audit (#1634)

`INCARNAMIND_EVAL_SPEED_AUDIT=1` adds the token audit to the same run, or `npm run eval:speed:tokens`. For each model call it measures the exact prompt the core assembled and writes, per request kind and per flow:

- the tokens of the instructions, each Tool's description and schema, the Passages and their windows, the conversation history, and anything else, with the provider's counted input, cached input and output;
- the Tools each kind is offered and how often it called each one, so a Tool it never calls is named;
- the instruction blocks each kind carries, and whether a step of that kind relied on each block (its Tool was called) or no step used it.

The input, cached input and output are what the provider counted, from the same finish part the core's timing records keep. Every other number is estimated locally with the core's own estimator (`src/core/answers/context` `estimateTokens`) from the exact prompt text, and scaled per request by `counted input / local estimate`, so the parts sum to the counted input. The report says how far the local estimate was from the counted total before scaling; the split between the parts is as good as that estimator, and a part the prompt doesn't let apart (a selection before the Question, the provider's own framing) is named rather than guessed. Only numbers and Tool names are kept, never a prompt's or a reply's text.

The tables are in the run's report and in `tokens.json` beside it. A count the provider doesn't give, or gives malformed, is shown as a dash. If a column contains an unknown count, its aggregate remains unknown instead of averaging the remaining values, and no total or share includes it. A request's outcome (finished, failed or stopped) comes from what its stream did, never from whether its usage was complete. A kind with no flow of its own and no request of its kind shows as not run, with no numbers, rather than as zeros; a written check inside a write still counts as a Check when no check flow was selected.
