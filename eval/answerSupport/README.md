# Answer sentences against their quotes

`npm run eval:support` checks sentences an Answer might write against the quote each cites (#2311): one at a time with `checkClaim`, as Check this Note checks a sentence, or in batches as an Answer in the assistant judges its own once it ends (`INCARNAMIND_EVAL_SUPPORT_JUDGE=answer`). It needs a chat model (`INCARNAMIND_EVAL_CHAT_*`, see `../README.md`); neither `npm test` nor `npm run eval` runs it.

## The sets

- **cases** (`cases.ts`), over five small Documents built here: a deck with the walk's kiln slides, the walk's Chinese contract summary, a dryer quote "delivered and commissioned", a lease note whose first page mentions 2024, and a contract summary whose file says it was created in May 2026 while its text gives no date.
  - **fixture**: the walk's two sentences, each in English and Chinese: "包括两台 K9 窑炉并已安装好" against "Cost: £185,000 for two K9 kilns, installed", and "dated 2026" against the title "供应商合同摘要".
  - **held-out**: the same two mistakes in other words and over the other Documents. None is the fixture reworded word for word, so a fix fitted to the fixtures shows up here.
  - **control**: sentences their quotes support, which must keep their green check.
- **supported**: Find support's supported sentences that state a date or a year (`../checks/labels.json`, 35), each citing its labelled quote, over that evaluation's Folder.

A sentence shows the green check only when its check says Supported; Unsupported and Contradicted mark it; a check that couldn't decide shows Not checked, with Check again.

## Running it

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 INCARNAMIND_EVAL_CHAT_KEY=… npm run eval:support
```

- `INCARNAMIND_EVAL_SUPPORT_SETS`: `cases`, `supported` or both (the default).
- `INCARNAMIND_EVAL_SUPPORT_ONLY`: case ids, comma-separated.
- `INCARNAMIND_EVAL_SUPPORT_REPEATS`: how often each sentence is checked (1); a model's verdict on one sentence varies from request to request.
- `INCARNAMIND_EVAL_SUPPORT_BUDGET`: dollars; the run stops before the next check once it has spent this (1).
- `INCARNAMIND_EVAL_SUPPORT_ARM`: a name for the report's folder, such as `before` or `after`.
- `INCARNAMIND_EVAL_SUPPORT_JUDGE=answer`: judges the sentences as an Answer in the assistant judges its own, through the app: each Answer, scripted, writes up to 16 of them citing their quotes, grouped by the Document they cite, and the real model judges them in batches of up to 8 (`src/core/answers/checks/sentenceBatch.ts`), on the meter and within the Answer's checking limit. Without it, each sentence is checked on its own with `checkClaim`, as Check this Note checks one.
- `INCARNAMIND_EVAL_SUPPORT_DRY=1`: finds each cited quote's Passage, as the Citation check finds a quote, and checks nothing; no model needed. A case whose quote no Passage holds is skipped and listed in the report.

Each run writes `eval/results/<start time>-support-<model>-<arm>/report.json`: every check's verdict, what it said, the parts it named with theirs, its time, its requests and tokens, and its cost from the app's own meter.

## Results, 2026-10-31 (#2311)

### Judged as an Answer judges its own sentences, in batches

Claude Haiku 5.5 (the cases three times each, the supported set twice) and Sonnet 5.5 (each once), `INCARNAMIND_EVAL_SUPPORT_JUDGE=answer`. A sentence shows the green check only when its batch says supported.

| | Haiku | Sonnet |
|---|--:|--:|
| Fixtures, green | 0 of 12 | 0 of 4 |
| Held-out, green | 0 of 66 | 1 of 22 |
| Controls, marked | 0 of 36 | 0 of 12 |
| Controls, not checked | 3 of 36 | 1 of 12 |
| Supported set, marked | 0 of 70 | 0 of 35 |
| Supported set, not checked | 10 of 70 | 5 of 35 |
| Sentences per request | 5.8 (184 in 32) | 3.3 (73 in 22) |
| Input / output tokens | 101,155 / 18,735 | 47,929 / 5,540 |
| Spent (the app's meter) | $0.018 | $0.129 |
| Per sentence | $0.000096 | $0.00176 |

- Sonnet's green held-out sentence is installed-zh-2, "窑炉升级的费用为 £185,000，即两台 K9 窑炉的安装费用": it reads the price of two kilns installed as their installation fee, as both models did when checking it on its own. Haiku refused it in all three.
- The control not checked is control-dated-zh-3, "根据供货协议，交货从 2027 年 1 月开始，每季度 12 吨。", on both models.
- The supported set's not checked are all figures no quote states as the sentence does: arithmetic (fs-049 "rose every quarter", fs-203 "about 23 per cent", fs-205 a sum, fs-207 "48,000 fewer"), and fs-050, a total that its row states among several amounts, which a batch doesn't confirm against the row (a check on its own asks the model once more). Each twice on Haiku, once on Sonnet.
- Requests and cost for an Answer of 200 cited sentences: checked one by one, about 4.6 requests a sentence on Haiku and 4.4 on Sonnet (the held-out runs below), about 920 and 880 requests, $0.22 and $2.42; in batches of eight, 25 requests, about $0.02 on Haiku and $0.35 on Sonnet. On Sonnet the Answer's $0.25 checking limit stops it at 128 sentences with $0.224 spent: a probe through the core whose batches each use what the eval measured on Sonnet, 4,500 input and 500 output tokens, about $0.014.

### Checked one sentence at a time

Claude Haiku 5.5 and Sonnet 5.5 on a direct Anthropic key; before is main at `a317cee1b` with this folder copied in, after is this branch's final check code. Before, an Answer runs no check on its sentences, so every sentence whose quote is found shows the green check; the "check alone" lines say what the same check would have said. After, a sentence shows the green check only when its check says Supported, and a check that couldn't decide shows Not checked. Every figure below comes from a report that records each check's requests and tokens.

Haiku: the cases three times each, the supported set twice. Sonnet, a sample: the four fixtures, eight held-out sentences (installed-zh-1, installed-zh-2, installed-en-2, dated-en-1, dated-en-4b, dated-zh-5b, dated-en-6b, dated-zh-7b) and four controls once each in both arms, and the supported set once after.

| | Haiku before | Haiku after | Sonnet before | Sonnet after |
|---|--:|--:|--:|--:|
| Fixtures, green in the Answer | 12 of 12 | **0 of 12** | 4 of 4 | **0 of 4** |
| Fixtures, check alone says supported | 1 of 12 | 0 of 12 | 2 of 4 | 0 of 4 |
| Held-out, green in the Answer | 66 of 66 | **3 of 66** | 8 of 8 | **1 of 8** |
| Held-out, check alone says supported | 5 of 66 | 3 of 66 | 1 of 8 | 1 of 8 |
| Held-out, not checked | | 3 of 66 | | 0 of 8 |
| Controls, marked | 0 of 36 | 0 of 36 | 0 of 4 | 0 of 4 |
| Controls, not checked | | 3 of 36 | | 1 of 4 |
| Supported set, marked | 4 of 70 | 5 of 70 | | 1 of 35 |
| Supported set, not checked | 16 of 70 (check alone) | 6 of 70 | | 3 of 35 |
| Requests | 672 | 665 | 53 | 149 |
| Input / output tokens | 4,598,715 / 118,665 | 4,548,085 / 114,182 | 360,967 / 8,324 | 1,172,239 / 23,098 |
| Spent (the app's meter) | $0.165 | $0.164 | $0.212 | $0.639 |

- Every held-out sentence still green after, on both models, is installed-zh-2, "窑炉升级的费用为 £185,000，即两台 K9 窑炉的安装费用": the Answer's own wording in a reproduction, which calls the price of two kilns installed their installation fee.
- The control not checked is control-dated-zh-3, "根据供货协议，交货从 2027 年 1 月开始，每季度 12 吨。", in both arms and on both models (`no-evidence`).
- Not checked on the supported set, by reason. Before the change to the calculation gate (#2311), the check alone left 16 of 70 on Haiku not checked: sheet rows whose unit is only in the column heading, or that hold several amounts (fs-044, fs-147 twice, fs-149 twice, fs-050), a number written in words (fs-018 twice), arithmetic (fs-049, fs-205 and fs-207, twice each), a reply it couldn't read (fs-006) and fs-156 ("每半年") once. After, 6 of 70: arithmetic, which the AI never does in its head (ADR-0021), 4 (fs-049 "rose every quarter", fs-203 "about 23 per cent", fs-205 a sum, twice), and a sentence that writes its number in words, "Forty examination couches" (fs-044), and fs-057, once each. Sonnet's 3 of 35 are all arithmetic (fs-049, fs-205, fs-207 "48,000 fewer"); in an Answer such a figure is a Calculated figure, which this judgement leaves to its Calculation check.
- The supported set's marks after: fs-129 twice (万千瓦时 against a bare 126, marked before too), fs-018 once (the transcript's "we" read as not the steering group), fs-147 once, fs-049 once (contradicted on "rose every quarter"). Before: fs-129 twice, fs-017 and fs-175.
- Earlier runs on this branch, whose reports record no tokens, measured the Time field and the stripped dates on the same cases: with the date gone from a check's Passages but before the Time field, Haiku called "包括两台 K9 窑炉并已安装好" supported in 5 of 8 checks; with the Time field it refused all 18.
- Time: the Answer ends when written, as on main, and its Citations settle as each sentence is judged. With the judgement first built inside the Answer (runs that record no tokens), the walk's Questions took 4.2 to 9.5 s and 5.2 to 10.8 s on Haiku, 4.1 to 8.6 s and 5.2 to 12.6 s on Sonnet; that difference is now how long the badges wait after the end.
- `eval:support` calls `checkClaim`, as Check this Note does. An Answer's judgement also leaves out what its sort calls opinion and gives the sentence's paragraph, so these numbers stand for the check, not the whole judgement.
