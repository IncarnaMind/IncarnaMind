# Nested quotation marks, asked once

The gate for #2504's nested quotation marks. This file and `cases.json` were committed before the
code they measure and before any run, and nothing in them changes after the first priced call. A
changed bar, case or stop rule is a new gate.

`cases.json` is frozen: sha256 `8f1ce36ed6df6bd25df6f2fee67f6c52b81d5833c4dfa4909d15893295e32762`,
2026-11-06T12:40:33Z.

## What is measured

An Answer's quoted words that the quoted-words check doesn't find, but finds once every quotation
mark of either kind is read as one mark, are asked about once. The Answer's own model replies for
each quotation with the same words in the Document's marks, or "none". A reply is accepted only
when the check finds it exactly, at the place the second reading found, with the same words, and
its marks are “ ” or ‘ ’. The quotation is then spliced with the Document's marks. Matching itself
is unchanged: found still means exact marks.

## Bars

- **False Supported after the splice: 0.** Every case with `"claimTrue": false` must not end
  Supported through the app's own claim check, the Answer judging its sentences as an Answer in
  the assistant does. One is a fail: the model stays off the list.
- **Same claim: every accepted splice,** judged blind by a reviewer who is not the author, from the
  blind file below. One changed claim is a fail.
- **The ask fires on Answers with no nested marks: 0** of the 20 `plain` cases, and 0 on the 39
  saved DeepSeek Answers of #2504's live run, counted offline. One fire is reported with its text;
  more than one is a fail.
- **Added wait: p95 at most 5 s** over the Answers whose ask fired: the ask's own time, as the
  Answer reports it (`exactMarks.durationMs`), since the Answer waits for nothing else. Over it is
  a fail.
- **Recovered, reported and not a bar:** nested cases whose quotation ends found after the splice,
  English and Chinese apart. "none", a failed or late reply, or the old text counts as not
  recovered.
- **Not accepted for its marks, reported:** replies whose marks are other than “ ” or ‘ ’,
  English and Chinese apart.

By the rule of three, 0 false Supported in 40 real-mismatch cases bounds the miss rate at about
7% (3/40) with 95% confidence. Nothing more is claimed from it.

## Arms

- `deepseek/deepseek-flash` (DeepSeek V4.1 Flash 1017), through the app's DeepSeek provider: the
  Answer's text is scripted per case. Its ask and its sentence judging go to the real model, as
  `eval/answerSupport` judges a scripted Answer's sentences. One arm, with the ask on: with it off,
  every case reads as main does, its nested quotation not found.

## Comparison

stack: none
why: one model and one app; the arms differ only in whether the ask runs.

## Decoys

- 40 `mismatch` cases, 20 English and 20 Chinese, labelled by the Document when written: 24 true,
  16 false. In each, the marks carry meaning: an identifier against a literal, code, a title, a
  quoted quote, sibling pairs and possessives. A false one passing as Supported is the failure
  the gate exists to catch.
- 20 `plain` cases, with no nested marks: inches, primes, apostrophes, straight marks and corner
  brackets. Any fire there is the second reading misfiring.

## Stop rules

- The spend cap is $5, read from the app's own meter. The run stops before the next Answer once it
  is reached.
- A pilot of three cases runs first. Its spend, projected to all 80, must fit the cap.
- The first false Supported, or the first fire on a `plain` case, is reported at once. The run
  goes on so that the counts are whole.
- A provider error on more than 5 of the asks stops the run as failed. A failed ask counts as not
  recovered.

## Held-out exposure

`cases.json` was written for this gate on 2026-11-06, before the code and before any run. No model
has seen it. The reviewer's two private probe sets are not touched: since no matcher changes, the
matcher reads exactly as main on them, and a test pins that on the frozen development set.

## Running it

```sh
INCARNAMIND_EVAL_NESTED_KEY=… npm run eval:nested-marks
```

`INCARNAMIND_EVAL_NESTED_ONLY` takes case ids for the pilot; `INCARNAMIND_EVAL_NESTED_SAVED` a file
of saved Answers, one JSON line each with its `text` and `page`, for the offline fire count. Each
run writes `eval/results/<start time>-nested-marks-<model>/report.json` and `blind.json`.

## Counts the report gives

Per language: Answers, quoted spans not found, second-reading finds, asks fired, spans asked,
accepted, declined, failed (an error or the deadline), not accepted for marks, recovered, false
Supported, and the added seconds (median and p95).

## The blind file

After the run, one shuffled file for the blind judgment, with these fields per accepted splice:
- an opaque id;
- the language;
- the old sentence as the Answer streamed it;
- the new sentence as spliced;
- the page's exact text.

It carries no family, model, label or outcome. Its path and the run's output go to the reviewer,
who posts the verdict on the pull request.
