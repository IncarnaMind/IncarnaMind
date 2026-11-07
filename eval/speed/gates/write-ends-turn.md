# The gate for a write that ends the turn (#1635)

Written and committed on 2026-11-07, before any run it gates.

## The step

The write Tools (`add_to_mind`, `create_mind`, `edit_mind` with content) offer `done`: "true when this call does the last thing the User asked for, so your reply would only say it was done". When the model sets it and the call's result leaves nothing to say or act on (it applied at once; no Citation not found, no marker left unrecorded, no source dropped, no chart not drawn, no uncited text; its check flagged, cut and failed nothing and checked every cited sentence; for `edit_mind`, no Citation dropped, no length off what was asked and no hint about the paragraph), the Answer ends at the write: no closing reply, so no change-claim check of one either. Anything else gets today's closing reply.

## The runs

- **Arms,** paired item by item in one run (`eval/speed/README.md` › Paired runs), from one build: `write-replies`, the write Tools sent with no `done`, so every write gets its closing reply as on `main`; and `today`, this branch.
- **Sets:**
  - `writes`: the flows `assistant-write`, `assistant-write-long` (eight paragraphs), `assistant-longer`, and two held out for this step, written with this gate and before any run, `assistant-write-and-say` and `assistant-write-and-ask`: each asks for something after the write that only a reply can say. English and Chinese.
  - `everyday`: the write items of the four paired libraries (88 requests), whose guards read claimed changes, what was asked and what was covered.
- **Models:**
  - Claude Haiku 5.5 (a direct Anthropic key): `writes` three runs; `everyday`'s write items once.
  - DeepSeek V4.1 Flash 1017 (`deepseek-flash`): `writes`' three timed flows three runs, the two held-out flows once; 20 of `everyday`'s write items, ten per language, once. Kimi K2.6 is not run: its key answers every request with 429.
  - Claude Sonnet 5.5, whose eight-paragraph write is #1635's target: the `today` arm alone on the three timed flows, three runs per language, against the same flows on `main` (ae31c1819) run on 2026-11-07 16:08–16:50, and the two held-out flows once, `today` alone. The cap keeps Sonnet off the paired `write-replies` arm.
- **Load:** a run starts only while the 15-minute load is at most 24; the load goes in the table.
- **Cost:** the lane's cap is $18 for all of #1635's work; these runs stop at their share (`INCARNAMIND_EVAL_SPEED_STOP_USD`), and the pull request gives each run's spend.

## The bars

Quality, each must hold on every model it runs on, or the step ships switched off (the Tools offer no `done`) or not at all:

1. **The held-out flows reply:** on `today`, no run of `assistant-write-and-say` or `assistant-write-and-ask` ends at the write with no reply (the `no-reply` failure): zero.
2. **No new everyday failure,** items both arms finished: no new change claimed that no Tool made, no new failure of any other everyday guard, no new false Supported, no more items failing to run. No margin.
3. **No new Tool text** and no more failed runs on `writes`.

Speed, to ship it switched on:

4. On Haiku and DeepSeek, the paired median Done of the three timed flows is lower on `today`, over both languages; on Sonnet, `today`'s median Done of each timed flow is lower than `main`'s.
5. The first change in the page comes no later on `today` than on `write-replies` (Haiku, DeepSeek) or `main` (Sonnet) by more than 1.0 s, median per flow.

Reported, not bars: the share of writes that ended at the write, written-check and change-claim-check calls per write, and how often a write the model marked `done` still got a reply because its result had something to say.

## What decides

The step ships switched on only if every quality bar holds on every model and the speed bars hold. If a bar fails, the pull request names it with its numbers, and what ships is decided in a dated note below, not by reading these bars again.
