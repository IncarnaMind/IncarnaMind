# Near copies on the check's judge (#1766, #1708, #1765)

Summaries of the real-model runs behind #2515, one file a run. Each case of `tests/live/nearCopy*.cases.ts` is checked by `tests/live/nearCopyHeldout.live.test.ts` on its own: a Note of its own, in a Library that holds only its one Document, with the test core's fake embedding and reranking models. The repeated checks are `npm run eval:repeats` on the sets named in each file.

- `main-haiku.md`, `main-sonnet.md`: the first held-out files on `main` (commit d5d481d10, `main` e2dda3770 with the held-out files only).
- `repeats-main-haiku.md`, `repeats-main-sonnet.md`: the recall and conflict sets on `main`, under the labels as they were before 2026-11-04. The relabel of that day (the ruling on #1708) turns six of their Supported sentences into Unsupported ones: on Haiku 5.5 that is 18 false Supported checks, on Sonnet 5.5 six.

The unit is the item: a case, checked 3 times on Haiku 5.5 and once on Sonnet 5.5. The full reports, with every request's reply, stay with the run.
