# The gate for a call's notes asked for with each Transcript line once (#3151)

Written and committed on 2026-11-15, before any run it gates.

A Transcript's Passages overlap, for search. A call's notes were asked for with the Passages whole, so the model read about two lines in five twice: 718 labelled lines for a call of 444, and 40 for one of 28. The branch sends each line once. That changes the request of every call, so this gate decides whether it may ship: the notes must be no worse on the calls that already got them.

The same pull request also asks for a long call in parts and asks again for a part whose reply was cut. Neither changes these calls' requests: each is one part on both arms, and the gate doesn't judge them.

## The run

- **Arms:** `notes-lines-repeated` (the request as before: the Passages as they overlap) against `today` (the branch: each line once), paired as `eval/speed/README.md` › Paired runs says, the order turning from pair to pair, with `INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`.
- **Set:** `meeting-notes`, its 12 long calls, 6 English and 6 Chinese, with the stand-in speaker pass. One pass: 12 pairs.
- **Model:** Claude Haiku 5.5 as the User's Answers model, on a direct Anthropic key. The judge is Claude Sonnet 5.5.

## The bars

On the items both arms finished, `today` against `notes-lines-repeated`:

| Line | Allowed |
|---|---|
| Expected Passages cited | 2 items fewer |
| Judged right | 4 items fewer |
| Every Citation found | none fewer |
| Items with a false Supported | 1 more |
| Notes that failed or were only partly filled in ("Other guard failed" and "Failed to run" together) | 2 more |
| Duplicate Answer, or a change claimed that no Tool made | none new |

- **Where the allowances come from.** `notes-before-speakers-2.md` paired two identical requests on this model and set, 12 pairs. They differed by 2 items on cited (7 and 9), 4 on judged right (5 and 9), none on every Citation found, 1 on items with a false Supported (9 and 10), and on notes failed or partly filled by 5 one way and 2 the other. A line allows what identical requests gave, so a change that does nothing passes. The fill has changed since that record, and today's spread isn't measured: the bars may be looser than today's fill needs, and a harm smaller than them isn't caught by this run.
- **The runner's own "holds" column** allows one margin for its first three lines (`INCARNAMIND_EVAL_SPEED_MARGIN=10`, 4 in 12) and none on the others. The gate is read from the report's counts against the table above, line by line.
- **Every item `today` loses on any line is read by hand** and reported by kind: whether a line sent once could explain it or not.
- **One pass.** A line past its allowance fails the gate, and nothing ships on a second try alone: a retry is read over all runs together.

## Reported, not gated

The times to the first sign and to the notes, the fill's thinking tokens and the seconds of its first request on each arm, model calls and tokens, each language's lines, the pairs each arm went first in, the load and the spend. Sending each line once isn't a speed change, and a pair's difference in time spreads by about 16 s on this model.

## What passing changes

A call's notes, and a voice memo's tidied note, are asked for with each Transcript line once. If a line fails, the request keeps its overlap and both arms' results go to the issue.

## Spend

`INCARNAMIND_EVAL_SPEED_STOP_USD=0.80` for this run, the judge's included, on a ledger of its own.
