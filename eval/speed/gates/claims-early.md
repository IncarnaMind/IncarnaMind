# The gate for checking a reply's claimed changes beside the working-notes judgement (#1624)

Written and committed on 2026-11-07, before any run it gates. #1624's baseline found that an Answer's closing calls hold Done back one after the other. On Claude Haiku 5.5, a reply written beside `cite` first waits for the judgement of its working notes (#2371, about 1.0 s), then for the check of the changes it claims (#2037, about 0.8 s). The step starts that check on the reply as it stands when the judgement starts, and takes its verdict at the end only for that same reply and record; a reply the judgement changed, or a call made since, is checked again. The check's request is the same as before, so what it catches is the same: the step changes when it runs, not what it reads.

*Changed on 2026-11-07, after review and before a complete run: the early verdict is reused only when the judge's whole prompt is the same at the end (the reply and the record of what the calls did), since a call made after the check started changes the record though not the reply. A first run of the earlier version was stopped after 10 everyday items when that was found, and is not read. The runs below are of this version.*

## The runs

- **Arms:** `claims-after` (the check after the judgement, as on main) against `today` (the check beside it), paired as `eval/speed/README.md` › Paired runs says, each arm in a core of its own, the order turning item by item.
- **Set:** `everyday`, the assistant's requests with their guards, `INCARNAMIND_EVAL_SPEED_EACH=8` on Claude Haiku 5.5 and `EACH=4` on DeepSeek V4.1 Flash 1017 (`deepseek-flash`), the languages taking turns. Every everyday request is an assistant turn offered Note Tools, so the change-claim check runs on each.
- **Models:** Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 on the direct key; the judge of claimed changes is Claude Sonnet 5.5.

## The guards

On the items both arms finished, per model, the step's arm has none new of:

- a change claimed that no Tool made;
- another everyday guard failed, a duplicate Answer, a Tool call left as text;
- an item failing to run.

And `tests/core/claimsCheckedEarly.test.ts` (committed with this file): a reply that claims a change no call made, written beside `cite`, is still caught and asked about once more; a reply whose claiming line the judgement takes back is checked again, and the early verdict is never used for it. Zero misses.

## Faster, or it doesn't ship

On Claude Haiku 5.5 the paired median difference of the time to the end is below zero. DeepSeek Flash cites before it writes, so it has no text beside `cite` to judge and the step never runs there: on DeepSeek the guards above hold and its times are reported, not gated.

## Spend

Within the $12 cap of #1624's table and closing-calls work, held by `INCARNAMIND_EVAL_SPEED_LEDGER`.

## Reported, not gated

The times to the first sign, the first words and the end per model and language; model calls; the load; what each run cost.
