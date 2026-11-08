# The second gate for starting a call's notes while its speakers are told apart (#2773)

Written and committed on 2026-11-08, before any run it gates. The first gate (`notes-before-speakers.md`) ran two built-app runs a side and failed on the models' own spread: the change sends the same request, sooner, and two runs couldn't tell that from one DeepSeek fill thinking for 63 s and another for 24 s. This gate runs on the paired runner with #2791's fix (each arm goes first in half the pairs), sizes its pairs from that spread, and holds the change to what it claims: the same request, sent sooner.

## The change

Unchanged from the first gate. Once a call's Transcript is saved its words are final, and its notes start at once while the speaker pass runs. Nothing is written until the pass ends. If the pass renamed any line, what was made is dropped and the notes start again from the renamed Transcript. A recording of a room, and a model on this computer, wait for the pass as before.

## The runs

- **Arms:** `speakers-first` (the notes wait for the speaker pass, as on main) against `notes-before-speakers`, in `eval/speed/arms.ts`. Paired as `eval/speed/README.md` › Paired runs says, with `INCARNAMIND_EVAL_SPEED_SAME_REQUEST=1` and `INCARNAMIND_EVAL_SPEED_FALSE_SUPPORTED=counted`.
- **Set:** `meeting-notes`, the 12 long calls of `eval/speed/meetingNotesCases.ts`, 6 English and 6 Chinese, once each per model: 12 pairs a model.
- **The speaker pass:** the set now runs a stand-in after Stop, in both arms. It takes as long as the app's pass took on this Mac, 0.11 s for each second of the call's audio (5.9–6.8 s for the calls of 53–62 s in #2773's runs), which is about 30–36 s for these calls of 4–6 minutes. It hears one voice on the other side, as in a call with one other person, so it renames no line, as the real pass did in every run of the first gate.
- **Models:** Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), each as the User's Answers model, on a direct Anthropic key and DeepSeek's own. The judge is Claude Sonnet 5.5.

## How many pairs, and why

From the earlier runs of this set and of the built app:
- A DeepSeek fill's time from Stop spread by about 18 s from run to run: #1624's 65 s median against 95 s at the 95th percentile, and 24 s against 63 s of thinking in the first gate. So the difference within a pair spreads by about √2 × 18 ≈ 26 s.
- Claude Haiku 5.5's spread by about 11 s, so a pair's difference spreads by about 16 s.

The change saves the pass's time, about 30 s here (less where the fill ends before the pass, which only Haiku's short fills can). A pair then comes out slower on the new arm with a chance of about 1 in 10 on DeepSeek (30 s against a spread of 26 s) and about 1 in 30 on Haiku. With 6 pairs in a language, the median comes out slower only when 3 or more of the 6 do: about 1.6% on DeepSeek and under 0.3% on Haiku. Over a model's 12 pairs it is under 0.1%. So one pass of the set, 6 pairs a language and 12 a model, is enough to tell the saving from the spread, and no more is run.

## The guards

On each model:

- **The same request.** In all 12 pairs, the new arm's first request after Stop (the fill's) is word for word the one `speakers-first` sent, apart from the ids and file times each arm's own library gives (`sameRequestOf` in `eval/speed/pairedReport.ts`). One pair that differs fails the change on that model. This is what the change claims: the notes are made from the same request, so they are the same notes the models would write either way.
- **Faster.** The paired median difference of the time from Stop to the notes in the page is below zero over the model's 12 pairs, and in each language's 6.
- **Made once.** The new arm makes the fill's first request once per call: no call's notes are made twice, since no line is renamed.

## Reported, not gated

- The judged lines: cited, judged right, every Citation found, false Supported counted over the set, and notes that failed or were only partly filled in.
- Why they don't gate here: with the same request on both arms, any difference is the model's own. With 12 pairs, a one-sided 95% bound on two identical arms allows about 4 items either way on a line judged right two times in three, which no change could be held to. The same-request guard holds the change instead.
- These judged differences between arms that sent the same request also measure the set's spread for the next gate (`notes-low-effort.md`).
- Also reported: each arm's times to the first sign and to the notes, its model calls and tokens, the pairs each arm went first in, the load and the spend.

## What passing changes

If both models hold every line, the change ships on: a call's notes start once its words are final. If either fails a line, it doesn't ship. Either way, the numbers go on #2773.

## Spend

Within this phase's $5, held by the runner's ledger (`INCARNAMIND_EVAL_SPEED_LEDGER`, `INCARNAMIND_EVAL_SPEED_STOP_USD`), which also counts the judge.

## Result (2026-11-08): it holds on both models, so it ships

`speakers-first` against `notes-before-speakers` at commit `a54792e25`, the meeting-notes set once per model, 12 pairs a model, each arm first in 6. The one-minute load was 2.1–3.6. Claude Sonnet 5.5 judged.

| Model | Same first request | Notes in, median: speakers-first → notes-before-speakers | Paired median difference (EN / ZH) | Pairs slower |
|---|---|---|---|---|
| Claude Haiku 5.5 | 12 of 12 | 81.1 → 41.4 s | −34.3 s (−40.9 / −27.8) | 0 of 12 |
| DeepSeek V4.1 Flash | 12 of 12 | 113.0 → 67.1 s | −34.3 s (−36.6 / −34.3) | 0 of 12 |

- **Made once.** The stand-in pass renamed no line, so no fill was dropped and made again, and every pair's first request was the same.
- **Reported, as the gate says:**
  - Claude Haiku 5.5, speakers-first → notes-before-speakers: cited 8 → 9, judged right 6 → 9, every Citation found on both arms, false Supported 68 → 55, notes failed or partly filled in 11 → 4.
  - DeepSeek: cited 10 → 10, right 10 → 10, all found on both arms, false Supported 22 → 16, failed or partly filled 1 → 1.

  With the same request on both arms, these differences are the models' own. They set the spread for `notes-low-effort.md`.
- **Spend:** $0.36 on Haiku and $0.54 on DeepSeek (the judge's included), and $0.08 on two runs of `today` against `today` that checked the stand-in and the request check first.
