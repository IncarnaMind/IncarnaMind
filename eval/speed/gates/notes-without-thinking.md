# The gate for filling a Meeting's notes without thinking first (#2773, #1624)

Written and committed on 2026-11-08, before any run it gates. After Stop, a one-minute call's notes took 27–87 s on today's main (`b2ae19bf8`, the built app, two synthetic calls of 53 s and 62 s, 15-minute load under 5). Most of it is one model request: the fill's, which thinks before it gives its records. Claude Haiku 5.5, at its low effort for an Answer, thought for 15–17 s (3,700–4,200 output tokens); DeepSeek V4.1 Flash, at its default effort, for 41–73 s (6,500–10,700). The rest is the speaker pass the notes wait for (6–8 s), the claims checked against the User's Documents (0–13 s) and the request that writes the notes' text after the records (1–3 s). This gate decides whether the fill's request may skip thinking on a model, as a small call does. A model is admitted only while it holds every line below; one that fails a line keeps today's path, and its numbers go on #2773.

## The runs

- **Arms:** `today` against `notes-without-thinking` (`eval/speed/arms.ts`: every call that would think as an Answer, `thinking: "answer"`, is made with thinking off; in the meeting-notes set that is the fill's request alone, since the claims' checks already think off), paired as `eval/speed/README.md` › Paired runs says: each item on both arms in one run, each arm in a core of its own, the order turning item by item, one run at a time.
- **Set:** `meeting-notes`, the 12 cases (`eval/speed/meetingNotesCases.ts`), 6 English and 6 Chinese, each a long call heard live and stopped, its notes filled in from its Transcript. Each case is stopped once a run, so the set runs twice: 24 pairs a model, read together. These cases were seen by the runs of `write-then-cite-tasks.md`, which changed no prompt; no prompt was changed for this gate.
- **Models:** Claude Haiku 5.5 and DeepSeek V4.1 Flash 1017 (`deepseek-flash`), each as the User's Answers model. The judge is Claude Sonnet 5.5 for both.
- **Languages:** both, counted together; each language is reported beside them.
- **The built app, as well:** the two synthetic calls this issue was measured on (an English sales call of 53 s and a Chinese one of 62 s, made with macOS `say`, played through Chromium's fake microphone and transcribed on this computer), stopped 3 s after their last words, on today's main and on the branch, twice each per model and language. The notes are judged by Claude Sonnet 5.5 against what the call says, below, and against the Transcript's words.

## The guards

On the meeting-notes set, `INCARNAMIND_EVAL_SPEED_MARGIN=0`: on the items both arms finished, per model, `notes-without-thinking` has no fewer items than `today` on:

- the lines the case rests on, each quoted by a found Citation of the Transcript;
- judged right;
- every Citation found.

And none new:

- no new false Supported: a sentence with a found Citation that states something its quoted words don't say, as the judge reads it. The run stops at the first one `today` didn't give, and the path fails on that model;
- no new Tool call left as text, notes with a problem (a partial fill included) or with nothing written;
- no more items failing to run.

In the built app, on each model and language, the branch's notes give as many of the call's facts below as main's, in either language, and the judge finds no sentence in them that the Transcript doesn't say where main's had none:

- English call: Enterprise is 45 dollars a seat a month with single sign-on included; annual billing takes 10% off, 40.50 dollars a seat; whether the data can stay in the European region is open, and Maren checks with the security team and emails by Thursday; the trial starts on 1 December; Maren sends the contract draft tomorrow; whether the API has rate limits is open, and Maren finds out.
- Chinese call: 企业版每个席位每月三百元，含单点登录；按年付费打九折，每个席位每月二百七十元；数据能否留在国内未定，林晓雯（转写可能写作林小文）与安全团队确认，周四前邮件回复；试用十二月一号开始；林晓雯明天发合同草稿；接口有无调用次数限制未定，回头再确认。

## Faster, or it isn't admitted

The path is for speed: a model is admitted only where the paired median difference of the time to the end is below zero on the meeting-notes set, and the built app's notes are done sooner on both languages.

## What admission changes

A model that holds every line is listed beside the catalog (`src/core/providers/catalog/notesThinking.ts`) with the day and these numbers, and its fill's request skips thinking. A model not listed fills its notes as before.

## Spend

$5 for all of this piece of work's runs, the built app's included, held by the runner: each run reads what the runs before it spent from `INCARNAMIND_EVAL_SPEED_LEDGER` and stops before the next item once the total reaches `INCARNAMIND_EVAL_SPEED_STOP_USD`, set to what is left of the $5.

## Reported, not gated

Per model: the times to the first sign, to the notes going into the page and to the end; model calls and tokens; each language's counts; every item side by side; the load during the runs; and what each run cost.

## Result (2026-11-08)

It fails on both models, so no model is listed and the fill's request keeps thinking as an Answer does. On the meeting-notes set, first pass, judged by Claude Sonnet 5.5, $0.17 in all:

- **DeepSeek V4.1 Flash:** the run stopped at its second item, `notes-en-say-records`, on a new false Supported: 15 sentences against today's 2 (8 of the 15 are lines that point to another, "— see above"; today's own first item had 17). Done 44.5 s and 48.8 s against today's 86.0 s and 99.0 s.
- **Claude Haiku 5.5:** stopped by hand after 5 of 12 items. Without thinking, every item was judged wrong, citing only its overview, and one wrote nothing ("the model found nothing to add"); today's were right on 1, partly on 2 and wrong on 2. Done 4.2–8.9 s against today's 17.4–46.8 s.
