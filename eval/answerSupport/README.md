# Answer sentences against their quotes

`npm run eval:support` checks sentences an Answer might write against the quote each cites, with `checkClaim`, the check an Answer in the assistant runs on its sentences with Citations once it ends (#2311). It needs a chat model (`INCARNAMIND_EVAL_CHAT_*`, see `../README.md`); neither `npm test` nor `npm run eval` runs it.

## The sets

- **cases** (`cases.ts`), over five small Documents built here: a deck with the walk's kiln slides, the walk's Chinese contract summary, a dryer quote "delivered and commissioned", a lease note whose first page mentions 2024, and a contract summary whose file says it was created in May 2026 while its text gives no date.
  - **fixture**: the walk's two sentences, each in English and Chinese: "包括两台 K9 窑炉并已安装好" against "Cost: £185,000 for two K9 kilns, installed", and "dated 2026" against the title "供应商合同摘要".
  - **held-out**: the same two mistakes in other words and over the other Documents. None is the fixture reworded word for word, so a fix fitted to the fixtures shows up here.
  - **control**: sentences their quotes support, which must keep their green check.
- **supported**: Find support's supported sentences that state a date or a year (`../checks/labels.json`, 35), each citing its labelled quote, over that evaluation's Folder.

A sentence shows the green check only when the check says Supported; Unsupported and Contradicted mark it; a check that couldn't decide shows Not checked, with Check again.

## Running it

```sh
INCARNAMIND_EVAL_CHAT_KIND=anthropic INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 INCARNAMIND_EVAL_CHAT_KEY=… npm run eval:support
```

- `INCARNAMIND_EVAL_SUPPORT_SETS`: `cases`, `supported` or both (the default).
- `INCARNAMIND_EVAL_SUPPORT_ONLY`: case ids, comma-separated.
- `INCARNAMIND_EVAL_SUPPORT_REPEATS`: how often each sentence is checked (1); a model's verdict on one sentence varies from request to request.
- `INCARNAMIND_EVAL_SUPPORT_BUDGET`: dollars; the run stops before the next check once it has spent this (1).
- `INCARNAMIND_EVAL_SUPPORT_ARM`: a name for the report's folder, such as `before` or `after`.
- `INCARNAMIND_EVAL_SUPPORT_DRY=1`: finds each cited quote's Passage, as the Citation check finds a quote, and checks nothing; no model needed. A case whose quote no Passage holds is skipped and listed in the report.

Each run writes `eval/results/<start time>-support-<model>-<arm>/report.json`: every check's verdict, what it said, the parts it named with theirs, its time, its requests and tokens, and its cost from the app's own meter.

## Results, 2026-10-31 (#2311)

Claude Haiku 5.5 and Sonnet 5.5 on a direct Anthropic key, before (main at `a317cee1b`) and after the change. Before, an Answer runs no check on its sentences, so every one whose quote is found shows the green check; the "check alone" lines say what the same check would have said. After, a check that couldn't decide shows Not checked, never the green check.

| | Haiku before | Haiku after | Sonnet before | Sonnet after |
|---|--:|--:|--:|--:|
| Fixtures, green in the Answer | 30 of 30 | 0 of 30 | 8 of 8 | 0 of 8 |
| Fixtures, check alone says supported | 12 of 30 | 0 of 30 | 1 of 8 | 0 of 8 |
| Held-out, green in the Answer | 66 of 66 | 3 of 66 | 44 of 44 | 2 of 44 |
| Held-out, not checked | | 4 of 66 | | 0 of 44 |
| Held-out, check alone says supported | 5 of 66 | 3 of 66 | 2 of 44 | 2 of 44 |
| Controls, marked | 0 of 36 | 1 of 36 | 0 of 12 | 0 of 12 |
| Supported set, marked | 2 of 35 | 3 of 70 | 1 of 35 | 2 of 35 |

- The fixtures the check alone called supported before were "dated 2026" (12 of 18 on Haiku, from the year beside the contract's Passage) and, on Sonnet, the Chinese "已安装好" once in 2.
- Every held-out sentence still called supported, in both arms and on both models, is "窑炉升级的费用为 £185,000，即两台 K9 窑炉的安装费用": the Answer's own wording in a reproduction, which calls the price of two kilns installed their installation fee. Haiku's 4 not checked are "dated 2026" sentences: dated-en-5b, dated-zh-5b, dated-en-6b and dated-zh-7b, once each.
- The control marked once is "根据供货协议，交货从 2027 年 1 月开始", which two Documents answer differently. The supported set's marks after are 万千瓦时 against a bare 126 (fs-129, marked before too, on both models), fs-017 once in 7 on Haiku (never in 7 before) and fs-049 on Sonnet, "rose every quarter": contradicted in its one check after, not checked in its one check before, and not checked in all three on Haiku.
- With the date gone from a check's Passages but before the Time field, Haiku called "包括两台 K9 窑炉并已安装好" supported in 5 of 8 checks: the deck's year had been telling it the installation was still to come. With the Time field it refused all 18.
- The walk's two Questions, asked in the app's Answers path over the walk's two files, with the judgement first built inside the Answer: on Haiku an Answer took 4.2 s before and 9.5 s after for the kiln Question, and 5.2 s and 10.8 s for the contract, three of each; on Sonnet, 4.1 s and 8.6 s, 5.2 s and 12.6 s, one of each. The Answer now ends when it is written, as before, and its Citations settle that much later (about 5 s on Haiku, 4 to 7 s on Sonnet). The checks cost about $0.004 an Answer on Haiku and $0.04 on Sonnet.
- Not checked on sentences their quotes support, after: Haiku 3 of 36 controls and 17 of 70 in the supported set, Sonnet 1 of 12 and 6 of 35. Before the change these kept the green check without a judgement; now they say so.
- Once the Answer ends at once and its sentences are judged after (the final code), the held-out set again: Haiku, three times each, 3 of 66 supported (all "窑炉升级的费用为 £185,000…") and 5 not checked; 305 requests, 1,730,844 input and 47,524 output tokens, $0.058. Sonnet, once each until its $0.25 budget ran out, 18 of 22: none supported, none not checked ("窑炉升级的费用…" unsupported); 80 requests, 512,189 input and 11,703 output tokens, $0.27.
