## Rounds

- branch-1-a.jsonl: 304 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2486590 input and 60961 output tokens, $0.0940
- branch-10-a.jsonl: 292 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2479583 input and 61015 output tokens, $0.0799
- branch-2-a.jsonl: 298 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2512678 input and 61118 output tokens, $0.0793
- branch-3-a.jsonl: 282 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2359717 input and 58508 output tokens, $0.0766
- branch-4-a.jsonl: 297 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2453922 input and 60732 output tokens, $0.0790
- branch-5-a.jsonl: 294 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2420097 input and 61137 output tokens, $0.0775
- branch-6-a.jsonl: 291 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2449952 input and 60839 output tokens, $0.0768
- branch-7-a.jsonl: 297 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2526848 input and 62425 output tokens, $0.0796
- branch-8-a.jsonl: 313 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2619411 input and 63352 output tokens, $0.0845
- branch-9-a.jsonl: 295 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2422887 input and 60143 output tokens, $0.0784
- main-1-a.jsonl: 291 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2438944 input and 60820 output tokens, $0.0903
- main-10-a.jsonl: 303 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2493688 input and 63457 output tokens, $0.0814
- main-2-a.jsonl: 306 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2478559 input and 61993 output tokens, $0.0825
- main-3-a.jsonl: 304 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2537841 input and 61538 output tokens, $0.0816
- main-4-a.jsonl: 303 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2460378 input and 63915 output tokens, $0.0797
- main-5-a.jsonl: 300 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2484799 input and 62830 output tokens, $0.0802
- main-6-a.jsonl: 312 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2527932 input and 62319 output tokens, $0.0825
- main-7-a.jsonl: 303 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2453077 input and 62889 output tokens, $0.0820
- main-8-a.jsonl: 298 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2414109 input and 60807 output tokens, $0.0797
- main-9-a.jsonl: 289 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 2404850 input and 61587 output tokens, $0.0787
- starts-unmetered.jsonl: 0 requests, 0 refused, 0 failed, 0 timed out, 0 held at the stop, 0 input and 0 output tokens, $0.1000

Priced in all: $1.7241

## Cases

| Case | Arm | ✓ | part ✓ | first reply contradicted | a figure Not checked |
|---|---|---|---|---|---|
| example | en | example | note | Revenue was £1,284 million, up 4.2% year on year. | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| example | en | example | note | Revenue was £1,284 million, up 4.2% year on year. | right | main | 10/10 | 0/10 | 0/10 | 0/10 |
| example | en | example | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right | branch | 10/10 | 10/10 | 0/10 | 0/10 |
| example | en | example | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| example | en | example | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| example | en | example | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong | main | 0/10 | 0/10 | 0/10 | 8/10 |
| example | en | example+own | note | Revenue was £1,284 million, up 4.2% year on year. | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| example | en | example+own | note | Revenue was £1,284 million, up 4.2% year on year. | right | main | 10/10 | 0/10 | 0/10 | 0/10 |
| example | en | example+own | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right | branch | 10/10 | 10/10 | 0/10 | 0/10 |
| example | en | example+own | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| example | en | example+own | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example+own | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example+own | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | en | example+own | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong | main | 0/10 | 0/10 | 10/10 | 1/10 |
| example | en | example+own | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| example | en | example+own | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong | main | 0/10 | 0/10 | 0/10 | 5/10 |
| example | zh-CN | example | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right | branch | 10/10 | 6/10 | 0/10 | 0/10 |
| example | zh-CN | example | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right | main | 10/10 | 4/10 | 0/10 | 0/10 |
| example | zh-CN | example | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right | branch | 9/10 | 0/10 | 0/10 | 1/10 |
| example | zh-CN | example | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right | main | 10/10 | 0/10 | 0/10 | 0/10 |
| example | zh-CN | example | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong | branch | 0/10 | 0/10 | 0/10 | 1/10 |
| example | zh-CN | example | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong | main | 0/10 | 0/10 | 0/10 | 0/10 |
| example | zh-CN | example+own | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right | branch | 10/10 | 4/10 | 0/10 | 0/10 |
| example | zh-CN | example+own | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right | main | 10/10 | 7/10 | 0/10 | 0/10 |
| example | zh-CN | example+own | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| example | zh-CN | example+own | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right | main | 9/10 | 0/10 | 0/10 | 1/10 |
| example | zh-CN | example+own | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example+own | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example+own | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example+own | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| example | zh-CN | example+own | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| example | zh-CN | example+own | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong | main | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a1-right | Operating profit was £41 million in 2026, against £52 million in 2025. | right | branch | 10/10 | 9/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a1-right | Operating profit was £41 million in 2026, against £52 million in 2025. | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a1-wrong | Operating profit was £41 million in 2026, against £25 million in 2025. | wrong | branch | 0/10 | 0/10 | 8/10 | 0/10 |
| held-out | en | comparative | en-a1-wrong | Operating profit was £41 million in 2026, against £25 million in 2025. | wrong | main | 0/10 | 0/10 | 9/10 | 0/10 |
| held-out | en | comparative | en-a2-right | Occupancy averaged 82% in July, up from 76% a year before. | right | branch | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a2-right | Occupancy averaged 82% in July, up from 76% a year before. | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a2-wrong | Occupancy averaged 82% in July, down from 76% a year before. | wrong | branch | 6/10 | 6/10 | 4/10 | 0/10 |
| held-out | en | comparative | en-a2-wrong | Occupancy averaged 82% in July, down from 76% a year before. | wrong | main | 7/10 | 7/10 | 3/10 | 1/10 |
| held-out | en | comparative | en-a3-right | Net debt stood at $3.4 billion at the end of 2026, compared with $2.9 billion a year earlier. | right | branch | 9/10 | 9/10 | 0/10 | 1/10 |
| held-out | en | comparative | en-a3-right | Net debt stood at $3.4 billion at the end of 2026, compared with $2.9 billion a year earlier. | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | en | comparative | en-a3-wrong | Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier. | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | en | comparative | en-a3-wrong | Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier. | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | en | short-note | en-b1-right | Sales were £2,615 million. | right | branch | 9/10 | 0/10 | 0/10 | 1/10 |
| held-out | en | short-note | en-b1-right | Sales were £2,615 million. | right | main | 8/10 | 0/10 | 0/10 | 2/10 |
| held-out | en | short-note | en-b1-wrong | Sales were £2,165 million. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | short-note | en-b1-wrong | Sales were £2,165 million. | wrong | main | 0/10 | 0/10 | 0/10 | 4/10 |
| held-out | en | short-note | en-b2-right | Costs came to $1,075 million. | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | short-note | en-b2-right | Costs came to $1,075 million. | right | main | 5/10 | 0/10 | 0/10 | 4/10 |
| held-out | en | short-note | en-b2-wrong | Costs came to $1,705 million. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | short-note | en-b2-wrong | Costs came to $1,705 million. | wrong | main | 0/10 | 0/10 | 0/10 | 8/10 |
| held-out | en | short-note | en-b3-right | Headcount was 4,310. | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | short-note | en-b3-right | Headcount was 4,310. | right | main | 2/10 | 0/10 | 0/10 | 8/10 |
| held-out | en | short-note | en-b3-wrong | Headcount was 3,410. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | en | short-note | en-b3-wrong | Headcount was 3,410. | wrong | main | 0/10 | 0/10 | 0/10 | 6/10 |
| held-out | zh-CN | comparative | zh-a1-right | 营业利润为 2,750 万元，上年同期为 3,180 万元。 | right | branch | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a1-right | 营业利润为 2,750 万元，上年同期为 3,180 万元。 | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a1-wrong | 营业利润为 2,750 万元，上年同期为 3,810 万元。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a1-wrong | 营业利润为 2,750 万元，上年同期为 3,810 万元。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a2-right | 出租率为 91%，较上年的 87% 有所上升。 | right | branch | 9/10 | 9/10 | 0/10 | 1/10 |
| held-out | zh-CN | comparative | zh-a2-right | 出租率为 91%，较上年的 87% 有所上升。 | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a2-wrong | 出租率为 91%，较上年的 87% 有所下降。 | wrong | branch | 0/10 | 0/10 | 8/10 | 4/10 |
| held-out | zh-CN | comparative | zh-a2-wrong | 出租率为 91%，较上年的 87% 有所下降。 | wrong | main | 1/10 | 1/10 | 8/10 | 2/10 |
| held-out | zh-CN | comparative | zh-a3-right | 2026 年末净负债为 18.6 亿元，一年前为 15.2 亿元。 | right | branch | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a3-right | 2026 年末净负债为 18.6 亿元，一年前为 15.2 亿元。 | right | main | 10/10 | 10/10 | 0/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a3-wrong | 2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。 | wrong | branch | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | zh-CN | comparative | zh-a3-wrong | 2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。 | wrong | main | 0/10 | 0/10 | 10/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b1-right | 销售额为 2,615 万英镑。 | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b1-right | 销售额为 2,615 万英镑。 | right | main | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b1-wrong | 销售额为 2,165 万英镑。 | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b1-wrong | 销售额为 2,165 万英镑。 | wrong | main | 0/10 | 0/10 | 0/10 | 3/10 |
| held-out | zh-CN | short-note | zh-b2-right | 成本为 1,075 万美元。 | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b2-right | 成本为 1,075 万美元。 | right | main | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b2-wrong | 成本为 1,705 万美元。 | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b2-wrong | 成本为 1,705 万美元。 | wrong | main | 0/10 | 0/10 | 0/10 | 4/10 |
| held-out | zh-CN | short-note | zh-b3-right | Headcount was 4,310. | right | branch | 10/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b3-right | Headcount was 4,310. | right | main | 2/10 | 0/10 | 0/10 | 8/10 |
| held-out | zh-CN | short-note | zh-b3-wrong | Headcount was 3,410. | wrong | branch | 0/10 | 0/10 | 0/10 | 0/10 |
| held-out | zh-CN | short-note | zh-b3-wrong | Headcount was 3,410. | wrong | main | 0/10 | 0/10 | 0/10 | 7/10 |

## Bars

- met: example | en | example | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right: ✓ in at least 9 of 10 (10/10)
- met: example | en | example | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right: first reply contradicted in at most 1 (0/10)
- met: example | en | example | note | Revenue was £1,284 million, up 4.2% year on year. | right: ✓ in at least 9 of 10 (10/10)
- met: example | en | example+own | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right: ✓ in at least 9 of 10 (10/10)
- met: example | en | example+own | note | Underlying EBITDA was £96 million, against £118 million a year earlier. | right: first reply contradicted in at most 1 (0/10)
- met: example | en | example+own | note | Revenue was £1,284 million, up 4.2% year on year. | right: ✓ in at least 9 of 10 (10/10)
- met: example | en | example+own | note | Revenue was £1,284 million, up 4.2% year on year. | right: no figure Not checked (0/10)
- met: example | zh-CN | example | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right: ✓ in at least 9 of 10 (10/10)
- met: example | zh-CN | example | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right: first reply contradicted in at most 1 (0/10)
- met: example | zh-CN | example | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right: ✓ in at least 9 of 10 (9/10)
- met: example | zh-CN | example+own | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right: ✓ in at least 9 of 10 (10/10)
- met: example | zh-CN | example+own | note | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。 | right: first reply contradicted in at most 1 (0/10)
- met: example | zh-CN | example+own | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right: ✓ in at least 9 of 10 (10/10)
- met: example | zh-CN | example+own | note | 集团收入为 12.84 亿英镑，同比增长 4.2%。 | right: no figure Not checked (0/10)
- met: example | en | example | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | en | example | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | en | example | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | en | example+own | twin-3 | Revenue was £1,248 million, up 4.2% year on year. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | en | example+own | twin-1 | Underlying EBITDA was £96 million, against £128 million a year earlier. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | en | example+own | twin-2 | Underlying EBITDA was £118 million, against £96 million a year earlier. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | comparative | en-a1-wrong | Operating profit was £41 million in 2026, against £25 million in 2025. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | comparative | en-a2-wrong | Occupancy averaged 82% in July, down from 76% a year before. | wrong: no ✓ gained (main 7/10, branch 6/10)
- met: held-out | en | short-note | en-b1-wrong | Sales were £2,165 million. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | comparative | en-a3-wrong | Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | short-note | en-b3-wrong | Headcount was 3,410. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | short-note | en-b2-wrong | Costs came to $1,705 million. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example+own | twin-1 | 基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example+own | twin-3 | 集团收入为 12.48 亿英镑，同比增长 4.2%。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: example | zh-CN | example+own | twin-2 | 基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | zh-CN | comparative | zh-a1-wrong | 营业利润为 2,750 万元，上年同期为 3,810 万元。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | zh-CN | comparative | zh-a2-wrong | 出租率为 91%，较上年的 87% 有所下降。 | wrong: no ✓ gained (main 1/10, branch 0/10)
- met: held-out | zh-CN | comparative | zh-a3-wrong | 2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | zh-CN | short-note | zh-b1-wrong | 销售额为 2,165 万英镑。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | zh-CN | short-note | zh-b2-wrong | 成本为 1,705 万美元。 | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | zh-CN | short-note | zh-b3-wrong | Headcount was 3,410. | wrong: no ✓ gained (main 0/10, branch 0/10)
- met: held-out | en | comparative | en-a2-right | Occupancy averaged 82% in July, up from 76% a year before. | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out | en | comparative | en-a1-right | Operating profit was £41 million in 2026, against £52 million in 2025. | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out | en | short-note | en-b1-right | Sales were £2,615 million. | right: no ✓ lost (main 8/10, branch 9/10)
- met: held-out | en | comparative | en-a3-right | Net debt stood at $3.4 billion at the end of 2026, compared with $2.9 billion a year earlier. | right: no ✓ lost (main 10/10, branch 9/10)
- met: held-out | en | short-note | en-b2-right | Costs came to $1,075 million. | right: no ✓ lost (main 5/10, branch 10/10)
- met: held-out | en | short-note | en-b3-right | Headcount was 4,310. | right: no ✓ lost (main 2/10, branch 10/10)
- met: held-out | zh-CN | comparative | zh-a1-right | 营业利润为 2,750 万元，上年同期为 3,180 万元。 | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out | zh-CN | comparative | zh-a2-right | 出租率为 91%，较上年的 87% 有所上升。 | right: no ✓ lost (main 10/10, branch 9/10)
- met: held-out | zh-CN | short-note | zh-b1-right | 销售额为 2,615 万英镑。 | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out | zh-CN | comparative | zh-a3-right | 2026 年末净负债为 18.6 亿元，一年前为 15.2 亿元。 | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out | zh-CN | short-note | zh-b3-right | Headcount was 4,310. | right: no ✓ lost (main 2/10, branch 10/10)
- met: held-out | zh-CN | short-note | zh-b2-right | 成本为 1,075 万美元。 | right: no ✓ lost (main 10/10, branch 10/10)
- met: held-out right sentences, all: no ✓ lost (main 97, branch 117, drop -20, fails at 6 (main's spread 3))

## Wrong comparatives, read apart

| Wrong comparative | Arm | ✓ | Contradicted |
|---|---|---|---|
| held-out | en | comparative | en-a1-wrong | Operating profit was £41 million in 2026, against £25 million in 2025. | wrong | branch | 0/10 | 10/10 |
| held-out | en | comparative | en-a1-wrong | Operating profit was £41 million in 2026, against £25 million in 2025. | wrong | main | 0/10 | 10/10 |
| held-out | en | comparative | en-a2-wrong | Occupancy averaged 82% in July, down from 76% a year before. | wrong | branch | 6/10 | 4/10 |
| held-out | en | comparative | en-a2-wrong | Occupancy averaged 82% in July, down from 76% a year before. | wrong | main | 7/10 | 3/10 |
| held-out | en | comparative | en-a3-wrong | Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier. | wrong | branch | 0/10 | 10/10 |
| held-out | en | comparative | en-a3-wrong | Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier. | wrong | main | 0/10 | 10/10 |
| held-out | zh-CN | comparative | zh-a1-wrong | 营业利润为 2,750 万元，上年同期为 3,810 万元。 | wrong | branch | 0/10 | 10/10 |
| held-out | zh-CN | comparative | zh-a1-wrong | 营业利润为 2,750 万元，上年同期为 3,810 万元。 | wrong | main | 0/10 | 10/10 |
| held-out | zh-CN | comparative | zh-a2-wrong | 出租率为 91%，较上年的 87% 有所下降。 | wrong | branch | 0/10 | 7/10 |
| held-out | zh-CN | comparative | zh-a2-wrong | 出租率为 91%，较上年的 87% 有所下降。 | wrong | main | 1/10 | 4/10 |
| held-out | zh-CN | comparative | zh-a3-wrong | 2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。 | wrong | branch | 0/10 | 10/10 |
| held-out | zh-CN | comparative | zh-a3-wrong | 2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。 | wrong | main | 0/10 | 10/10 |
