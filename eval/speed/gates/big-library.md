# The gate for reading Documents from their rows on the window's per-change paths (#2772)

Written and committed on 2026-11-08, before any run it gates.

## The change

The window asks the core again for a Note's figure schedule on every change to the Note or the Library, for the first open's ready Question on every Library change, and Check this Note reads the Documents' versions and the Library's state as it plans and starts. Each of these built every Document's whole record, which reads its Tags, reference, source and imported Note with a query apiece, to use its id, version, name, title, status or a flag. They now read those fields from the Document's row in one query (`documents.summaries()`), and the examples ask whether their Linked folder is still there by its row instead of listing every Linked folder with its file counts. No request to a model, Passage or verdict changes; each reader gives the same values.

## Measured before this gate (on `main` at b2ae19bf8), reported on #2772

The packaged build, driven as a User drives it, with Claude Haiku 5.5 on a direct Anthropic key; the main process's event-loop delay, the time of each call from the window and a CPU profile were read from inside it.

- While 2,000 Documents imported, the main thread was busy 34.7 s of a 109 s profile. 23 s of it answered the window's calls: the figure schedule (9.9 s, 42 ms a call), the ready Question (8.8 s, 40 ms a call, 3 s of it listing Linked folders for the examples) and the unread files (4.2 s, 3.4 ms a call, 1,234 calls). Recording the import's results took 5 s.
- On a settled Library of 2,629 Documents, Check this Note's planning and start took 65 to 69 ms each on the main thread (4 to 7 ms with 28), and each figure schedule 49 ms (1.3 ms with 28), asked 14 times during a check.
- A Question's search took 2 to 61 ms on either Library; an Answer's search doesn't rerank.

## The runs

- **Arms:** `main` is the packaged build of b2ae19bf8; `rows` is the packaged build of this branch's commit with the change. Both are built the same way.
- **Order:** `main`, `rows`, `main`, `rows`: one run each, on a fresh profile (the keys saved through the app's own forms, Claude Haiku 5.5 for Answers), the 15-minute load at most 24.
- **Each run,** on the same files (test data only: the audit fixtures' formats and 2,000-Document scale set, the generated sample PDFs, four Chinese organize fixtures, and 601 more scale Documents):
  1. Link the 26 files (28 Documents with the two the app adds as examples); once all are ready, ask the six Questions below, each in a new Note, then Check this Note on the English and on the Chinese Note below.
  2. Link the 2,000 and at once Check this Note (English), then ask the Questions and Check this Note (Chinese) while they import. The main thread is profiled from the link until every Document is ready.
  3. Link the 601 more; once all 2,629 are ready, the same six Questions and two checks.
- **Times,** from the User's action in the window, sampled every 200 ms: a Question's first sign, first words and end from Enter; Check this Note's first sign (its badge changes), first verdict and end (its Stop goes) from the press of the page menu's Check.

**Questions:**
- "What does the Tide report say about harbour tide tables?" Right: harbours publish the times of high water every year.
- "What does the Vantrell report say about emissions?" Right: cites the Vantrell report's emissions targets, the 45% cut of Scope 1 and 2 emissions by 2032 among them.
- "What do my reading notes say about spring and neap tides?" Right: spring tides at new and full moon, neap tides at the quarter moons.
- "Norvath Assembly 2022 年度报告的重点是什么？" Right: a summary of that report's focus, cited from it.
- "潮汐与港口研究笔记里说港口的潮汐表有什么用？" Right: harbours publish the times of high and low water each year, and shipping plans large ships' movements by them to avoid running aground.
- "设备采购合同的付款方式是怎样的？" Right: 30% within 10 days of signing, 60% after acceptance, the last 10% as a retention paid when the warranty ends.

**Check this Note**, each Note eight sentences, the last two not stated by the Documents:
- English: the Moon raises two bulges of water on the Earth; spring tides at new and full moon; harbours publish the times of high water every year; neap tides at the quarter moons; Vantrell's 45% cut of Scope 1 and 2 emissions by 2032; Vantrell's more than $1.4 trillion over eight years. Not stated: spring tides at the quarter moons; a 60% cut by 2032.
- Chinese: 大潮发生在新月和满月时; 小潮发生在上弦月和下弦月时，潮差最小; 港口每年都会公布高潮和低潮的时间; 合计金额 341,000 元; 验收合格后支付 60%; 质保期 24 个月. Not stated: 大潮发生在上弦月和下弦月时; 质保期 12 个月.

## The bars

**What it must show:**
- The main thread's busy time during the import is at least 30% lower on `rows` than on `main`, in each run's pair.
- On the 2,629-Document Library, the figure schedule's, Check this Note's planning and start, and the ready Question's main-thread time per call are lower on `rows`.

**No later:**
- Check this Note during the import and on each Library: `rows`' median first sign, first verdict and end are not later than `main`'s median by more than `main`'s spread (its runs' largest minus smallest) and never by more than 0.5 s for the sign.
- Questions on each Library and during the import: `rows`' median first words and end are not later than `main`'s by more than `main`'s spread.

**Quality** (#1624's gate), over both runs of each arm:
- No new false Supported: neither sentence the Documents don't state is Supported in more `rows` runs than `main` runs.
- Judged right (Supported for a stated sentence, anything else for a sentence not stated) no lower than `main` by more than one in 30, rounded down.
- Every Answer's Citations found, and Answers judged right against the expected answers above, no lower than `main` by more than one in 30, rounded down; no Answer claims a change.
- No request fails on `rows` that didn't on `main`.

## What decides

`rows` ships if every bar holds. If one fails, the change ships no further and the numbers go on #2772.

**Cost:** about $0.20 a run, $0.80 for the four; within the $6 approved for this work.
