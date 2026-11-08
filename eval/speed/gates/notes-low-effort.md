# The gate for a call's notes thinking one level less on DeepSeek (#2773)

Written and committed on 2026-11-08, before any run it gates. After Stop, most of a call's wait on DeepSeek V4.1 Flash is the fill's one request, which thinks for 41–73 s at DeepSeek's default effort before it gives its records (`notes-without-thinking.md`). Without thinking, the notes said things their Transcript doesn't. This gate decides whether the fill may think one level less instead: `reasoning_effort` low, one level below DeepSeek's default, high (DeepSeek reads medium as high).

Claude Haiku 5.5 isn't run: its fill already thinks at low, Claude's lowest effort, and thinking off failed `notes-without-thinking.md`.

## The runs

- **Arms:** `today` against `notes-low-effort` (`eval/speed/arms.ts`: each DeepSeek request that thinks is sent with `reasoningEffort: "low"`; in the meeting-notes set that is the fill's request alone, since the claims' checks don't think). Both arms start the notes during the speaker pass, as `notes-before-speakers-2.md` shipped. Paired as `eval/speed/README.md` › Paired runs says, with `INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`.
- **Set:** `meeting-notes`, its 12 long calls, 6 English and 6 Chinese, with the stand-in speaker pass. Twice, as two runs on one ledger, since a call is stopped once a run: 24 pairs, 12 a language. The guards are read over both runs' rows together. A first try with `INCARNAMIND_EVAL_SPEED_RUNS=2` was stopped at its first call, whose second Stop failed on both arms; its one pair ($0.04) isn't counted, and the runner now refuses a second run or model on this set.
- **Model:** DeepSeek V4.1 Flash 1017 (`deepseek-flash`) as the User's Answers model, on DeepSeek's own key. The judge is Claude Sonnet 5.5.

## How many pairs, and why

From `notes-before-speakers-2.md`'s DeepSeek runs, where both arms sent the same request:

- **Time.** A pair's difference in the time to the notes spread by 16 s (standard deviation). #1631 found DeepSeek's Answers 5–9 s sooner at low; a fill thinks for longer, so it may save more. With 24 pairs, a saving of 5 s comes out as a median below zero about 9 times in 10, and one of 8 s about 39 in 40. With 12 pairs in a language, a saving of 8 s comes out below zero about 9 times in 10.
- **The judged lines.** Two identical requests differed by 1 item in 12 on cited, judged right and notes only partly filled in. A gate allowing no difference fails a change that does nothing whenever chance gives `today` one item more, as it did there. So the set runs twice, and each line allows the difference identical requests gave: 1 in 12.

## The guards

On the items both arms finished, over the 24 pairs:

- **Cited, judged right, every Citation found:** no more than 2 items fewer than `today` (`INCARNAMIND_EVAL_SPEED_MARGIN=3`, which allows 2 in 24).
- **False Supported:** no more items with one than `today`, as the runner counts them.
- **Notes that failed or were only partly filled in:** the report's "Other guard failed" and "Failed to run" together, no more than 2 items more than `today`'s.
- **No new duplicate Answer, or change claimed that no Tool made.**
- **Faster:** the paired median difference in the time to the notes below zero over the 24 pairs, and over each language's 12.

## Reported, not gated

The times to the first sign and to the notes, the fill's thinking tokens, model calls and tokens, each language's lines, the pairs each arm went first in, the load and the spend.

## What passing changes

If DeepSeek holds every line, a Meeting's notes get a kind of their own for effort, which takes the Answer's effort unless a model names its own, and DeepSeek Flash's notes are sent at `reasoning_effort` low. Its Answers keep their default, as #1631 decided. If it fails a line, nothing changes. Either way, the numbers go on #2773.

## Spend

Within this piece of work's $5, of which $0.99 is spent, held by the runner's ledger and `INCARNAMIND_EVAL_SPEED_STOP_USD` at $2 for this run.
