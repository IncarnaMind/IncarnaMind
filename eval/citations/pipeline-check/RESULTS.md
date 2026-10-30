# Do AI citations hold up? Results

> **A pipeline check, not published numbers.** These scores show that the run, the scorers and this page work end to end:
> - Answered fewer than the 75 Questions of its language, a failed or timed-out Answer not counted: [ollama-qwen3.5-4b.en.json](ollama-qwen3.5-4b.en.json), [ollama-qwen3.5-4b.zh.json](ollama-qwen3.5-4b.zh.json).
> - Judged by the scripted stand-ins, not by model judges: [ollama-qwen3.5-4b.en.json](ollama-qwen3.5-4b.en.json), [ollama-qwen3.5-4b.zh.json](ollama-qwen3.5-4b.zh.json), [scripted.en.json](scripted.en.json), [scripted.zh.json](scripted.zh.json).
> - Answered by the smoke tests' scripted chat model, which isn't a model: [scripted.en.json](scripted.en.json), [scripted.zh.json](scripted.zh.json).

The set: version 1 (questions.jsonl SHA-256 `ab17b69ea42ce560fa1981061932059d84e124b70e08b98fdd34c9ea121d1923`). Scored with `npm run eval:citations:score`. Every number links to the run file it is counted from; `scores.json` beside this page has each miss.

## The misses

Each run's misses, and how many the app's check flagged: a Citation's "Quote not found", or a sentence the check of the Note found unsupported or contradicted.

| Model | Language | Quote not at its Location | Not supported | Figure wrong or left out | Superseded figure in its place | Caught by the check | Let through | Left out: nothing to flag |
|---|---|---|---|---|---|---|---|---|
| ollama/qwen3.5:4b | English | [1](ollama-qwen3.5-4b.en.json) | [2](ollama-qwen3.5-4b.en.json) | [1](ollama-qwen3.5-4b.en.json) | [0](ollama-qwen3.5-4b.en.json) | [2](ollama-qwen3.5-4b.en.json) | [1](ollama-qwen3.5-4b.en.json) | [1](ollama-qwen3.5-4b.en.json) |
| ollama/qwen3.5:4b | Chinese | [0](ollama-qwen3.5-4b.zh.json) | [2](ollama-qwen3.5-4b.zh.json) | [1](ollama-qwen3.5-4b.zh.json) | [0](ollama-qwen3.5-4b.zh.json) | [0](ollama-qwen3.5-4b.zh.json) | [3](ollama-qwen3.5-4b.zh.json) | [0](ollama-qwen3.5-4b.zh.json) |
| scripted | English | [0](scripted.en.json) | [0](scripted.en.json) | [58](scripted.en.json) | [0](scripted.en.json) | [0](scripted.en.json) | [0](scripted.en.json) | [58](scripted.en.json) |
| scripted | Chinese | [0](scripted.zh.json) | [0](scripted.zh.json) | [61](scripted.zh.json) | [0](scripted.zh.json) | [0](scripted.zh.json) | [0](scripted.zh.json) | [61](scripted.zh.json) |

### ollama/qwen3.5:4b, English ([run](ollama-qwen3.5-4b.en.json))

- en-001 [en-001#2] (table-figure): quote not at its Location; the quote isn't at pp. 9–10 of 1995-2011年CERN土壤环境元素含量数据集; caught by the citation check.
  - Sentence: “The table provides the month and day (May 10) but does not specify the year of collection for that specific entry, although the dataset covers the period from 1995 to 2011 .”
  - Quote: “1995-2011年CERN土壤环境元素含量数据集摘要：土壤环境是地球环境的重要组成部分。目前土壤环境问题的关注重点在于土壤污染。”
- en-001 [en-001#2] (table-figure): Passage doesn't support the sentence; the judges find the Passage doesn't support the sentence; caught by the citation check.
  - Sentence: “The table provides the month and day (May 10) but does not specify the year of collection for that specific entry, although the dataset covers the period from 1995 to 2011 .”
  - Quote: “1995-2011年CERN土壤环境元素含量数据集摘要：土壤环境是地球环境的重要组成部分。目前土壤环境问题的关注重点在于土壤污染。”
- en-019 (calculated): figure wrong or missing; it leaves out 7,122.2 billions of dollars and 7,882.8 billions of dollars; nothing in the Answer for the check to flag.
- en-025 [en-025#2] (absent): Passage doesn't support the sentence; the judges find the Passage doesn't support the sentence; **let through by the check**.
  - Sentence: “The Chinese National Statistical Bulletin for 2023 mentions the number of people participating in social insurance schemes (such as basic endowment insurance), but does not provide a total federal payroll figure.”
  - Quote: “年末全国参加城镇职工基本养老保险人数52121万人”

### ollama/qwen3.5:4b, Chinese ([run](ollama-qwen3.5-4b.zh.json))

- zh-012 [zh-012#1] (table-figure): Passage doesn't support the sentence; the judges find the Passage doesn't support the sentence; **let through by the check**.
  - Sentence: “根据《1995-2011年CERN土壤环境元素含量数据集》中的表1，禹城站2010年表层土壤（0～10 cm）的汞含量为 0.047 mg/kg。”
  - Quote: “0–10 0.047”
- zh-052 [zh-052#1] (conflict): Passage doesn't support the sentence; the judges find the Passage doesn't support the sentence; **let through by the check**.
  - Sentence: “根据您提供的文档，2024年12月的修订公告给出了2023年国内生产总值的最终数据，而2024年的统计公报中并未包含2023年的具体数值（仅提及对历史数据的修订背景）。”
  - Quote: “根据第五次全国经济普查结果，并同步实施城镇居民自有住房服务核算方法改革，对国内生产总值、三次产业及相关行业增加值、全员劳动生产率等历史数据（包括图1、图2、图3、图9、图10、图11）进行了修订。”
- zh-052 (conflict): figure wrong or missing; it doesn't give 1,260,582 亿元; **let through by the check**.
  - Sentence: “修订后，2023年国内生产总值为1294272亿元。”

### scripted, English ([run](scripted.en.json))

- en-001 (table-figure): figure wrong or missing; it leaves out 5 day of October 2010; nothing in the Answer for the check to flag.
- en-002 (conflict): figure wrong or missing; it leaves out 1,260,582 亿元 and 1,294,272 亿元; nothing in the Answer for the check to flag.
- en-003 (conflict): figure wrong or missing; it leaves out 688,238 亿元 and 729,167 亿元; nothing in the Answer for the check to flag.
- en-004 (conflict): figure wrong or missing; it leaves out 471,495 亿元 and 483,345 亿元; nothing in the Answer for the check to flag.
- en-005 (superseded): figure wrong or missing; it leaves out 1,294,272 亿元; nothing in the Answer for the check to flag.
- en-006 (superseded): figure wrong or missing; it leaves out 729,167 亿元; nothing in the Answer for the check to flag.
- en-007 (superseded): figure wrong or missing; it leaves out 56.3 %; nothing in the Answer for the check to flag.
- en-008 (superseded): figure wrong or missing; it leaves out 36.8 %; nothing in the Answer for the check to flag.
- en-009 (superseded): figure wrong or missing; it leaves out 6.9 %; nothing in the Answer for the check to flag.
- en-010 (single-fact): figure wrong or missing; it leaves out 1,714.1 billions of dollars; nothing in the Answer for the check to flag.
- en-012 (single-fact): figure wrong or missing; it leaves out -37,479.2 billions of dollars; nothing in the Answer for the check to flag.
- en-014 (table-figure): figure wrong or missing; it leaves out 1,875.6 billions of dollars; nothing in the Answer for the check to flag.
- en-015 (table-figure): figure wrong or missing; it leaves out 7,661.7 billions of dollars; nothing in the Answer for the check to flag.
- en-016 (table-figure): figure wrong or missing; it leaves out 5,419.1 billions of dollars; nothing in the Answer for the check to flag.
- en-017 (table-figure): figure wrong or missing; it leaves out 26,347.7 billions of dollars; nothing in the Answer for the check to flag.
- en-018 (table-figure): figure wrong or missing; it leaves out 4,465.6 billions of dollars; nothing in the Answer for the check to flag.
- en-019 (calculated): figure wrong or missing; it leaves out 7,122.2 billions of dollars and 7,882.8 billions of dollars; nothing in the Answer for the check to flag.
- en-020 (calculated): figure wrong or missing; it leaves out 37,479.2 billions of dollars (negative); nothing in the Answer for the check to flag.
- en-021 (calculated): figure wrong or missing; it leaves out 3,417.2 billions of dollars (negative); nothing in the Answer for the check to flag.
- en-022 (multi-passage): figure wrong or missing; it leaves out 5,419.1 billions of dollars and 7,882.8 billions of dollars; nothing in the Answer for the check to flag.
- en-023 (multi-passage): figure wrong or missing; it leaves out 1,714.1 billions of dollars and 4,465.6 billions of dollars; nothing in the Answer for the check to flag.
- en-024 (multi-passage): figure wrong or missing; it leaves out 42,898.3 billions of dollars and 7,882.8 billions of dollars; nothing in the Answer for the check to flag.
- en-029 (single-fact): figure wrong or missing; it leaves out 4.5 billion tokens; nothing in the Answer for the check to flag.
- en-030 (table-figure): figure wrong or missing; it leaves out 99.8 accuracy; nothing in the Answer for the check to flag.
- en-031 (table-figure): figure wrong or missing; it leaves out 63.3 average; nothing in the Answer for the check to flag.
- en-032 (table-figure): figure wrong or missing; it leaves out 57.1 average; nothing in the Answer for the check to flag.
- en-033 (table-figure): figure wrong or missing; it leaves out 0.94 FID; nothing in the Answer for the check to flag.
- en-034 (table-figure): figure wrong or missing; it leaves out 144.9 mIS; nothing in the Answer for the check to flag.
- en-035 (calculated): figure wrong or missing; it leaves out 4.2 points; nothing in the Answer for the check to flag.
- en-036 (calculated): figure wrong or missing; it leaves out 1.05 FID; nothing in the Answer for the check to flag.
- en-037 (calculated): figure wrong or missing; it leaves out 43.4 points; nothing in the Answer for the check to flag.
- en-038 (multi-passage): figure wrong or missing; it leaves out 99.8 accuracy and 63.3 average; nothing in the Answer for the check to flag.
- en-039 (multi-passage): figure wrong or missing; it leaves out 59.7 average and 0.94 FID; nothing in the Answer for the check to flag.
- en-040 (multi-passage): figure wrong or missing; it leaves out 4.5 billion tokens; nothing in the Answer for the check to flag.
- en-042 (single-fact): figure wrong or missing; it leaves out 84 %; nothing in the Answer for the check to flag.
- en-043 (single-fact): figure wrong or missing; it leaves out 40 % and 3.5 billion people; nothing in the Answer for the check to flag.
- en-045 (table-figure): figure wrong or missing; it leaves out 184 million migrants and 2.3 %; nothing in the Answer for the check to flag.
- en-046 (table-figure): figure wrong or missing; it leaves out 37 million refugees; nothing in the Answer for the check to flag.
- en-047 (table-figure): figure wrong or missing; it leaves out 64 million economic migrants and 10 million refugees and 40 %; nothing in the Answer for the check to flag.
- en-048 (table-figure): figure wrong or missing; it leaves out 52 million economic migrants and 27 million refugees and 43 %; nothing in the Answer for the check to flag.
- en-049 (table-figure): figure wrong or missing; it leaves out 32 million people; nothing in the Answer for the check to flag.
- en-050 (calculated): figure wrong or missing; it leaves out 147 million economic migrants; nothing in the Answer for the check to flag.
- en-051 (calculated): figure wrong or missing; it leaves out 578 million people; nothing in the Answer for the check to flag.
- en-052 (multi-passage): figure wrong or missing; it leaves out 184 million migrants and 43 %; nothing in the Answer for the check to flag.
- en-053 (multi-passage): figure wrong or missing; it leaves out 37 million refugees and 31 million economic migrants; nothing in the Answer for the check to flag.
- en-054 (single-fact): figure wrong or missing; it leaves out 89 risks and 9 risk themes; nothing in the Answer for the check to flag.
- en-055 (single-fact): figure wrong or missing; it leaves out 5 years and 2 years; nothing in the Answer for the check to flag.
- en-056 (single-fact): figure wrong or missing; it leaves out 7 dimensions; nothing in the Answer for the check to flag.
- en-058 (table-figure): figure wrong or missing; it leaves out 1 % (lower bound of the range); nothing in the Answer for the check to flag.
- en-059 (table-figure): figure wrong or missing; it leaves out 25 % (threshold); nothing in the Answer for the check to flag.
- en-060 (table-figure): figure wrong or missing; it leaves out 80 % (lower bound of the range); nothing in the Answer for the check to flag.
- en-061 (table-figure): figure wrong or missing; it leaves out 201 fatalities (lower bound of the range); nothing in the Answer for the check to flag.
- en-062 (calculated): figure wrong or missing; it leaves out 5 percentage points; nothing in the Answer for the check to flag.
- en-063 (multi-passage): figure wrong or missing; it leaves out 89 risks and 25 %; nothing in the Answer for the check to flag.
- en-068 (multi-passage): figure wrong or missing; it leaves out 3 billion dollars; nothing in the Answer for the check to flag.
- en-071 (single-fact): figure wrong or missing; it leaves out 430 billion dollars; nothing in the Answer for the check to flag.
- en-072 (single-fact): figure wrong or missing; it leaves out 1.6 trillion dollars and 43 million borrowers; nothing in the Answer for the check to flag.
- en-074 (calculated): figure wrong or missing; it leaves out 37,209 dollars per borrower; nothing in the Answer for the check to flag.

### scripted, Chinese ([run](scripted.zh.json))

- zh-001 (single-fact): figure wrong or missing; it leaves out 1,970,000 元; nothing in the Answer for the check to flag.
- zh-003 (calculated): figure wrong or missing; it leaves out 251.8 万元; nothing in the Answer for the check to flag.
- zh-008 (multi-passage): figure wrong or missing; it leaves out 251.8 万元; nothing in the Answer for the check to flag.
- zh-012 (table-figure): figure wrong or missing; it leaves out 0.047 mg/kg; nothing in the Answer for the check to flag.
- zh-013 (table-figure): figure wrong or missing; it leaves out 0.042 mg/kg; nothing in the Answer for the check to flag.
- zh-014 (calculated): figure wrong or missing; it leaves out 0.005 mg/kg; nothing in the Answer for the check to flag.
- zh-015 (table-figure): figure wrong or missing; it leaves out 1,992 年; nothing in the Answer for the check to flag.
- zh-016 (table-figure): figure wrong or missing; it leaves out 20 m; nothing in the Answer for the check to flag.
- zh-017 (calculated): figure wrong or missing; it leaves out 9.51 个百分点; nothing in the Answer for the check to flag.
- zh-018 (multi-passage): figure wrong or missing; it leaves out 6.55 % and 7.7 %; nothing in the Answer for the check to flag.
- zh-020 (single-fact): figure wrong or missing; it leaves out 1,349,084 亿元 and 5 %; nothing in the Answer for the check to flag.
- zh-021 (single-fact): figure wrong or missing; it leaves out 140,828 万人 and 139 万人; nothing in the Answer for the check to flag.
- zh-022 (single-fact): figure wrong or missing; it leaves out 1,256 万人 and 12 万人; nothing in the Answer for the check to flag.
- zh-023 (single-fact): figure wrong or missing; it leaves out 1,751 亿件 and 14,034 亿元; nothing in the Answer for the check to flag.
- zh-024 (table-figure): figure wrong or missing; it leaves out 94,350 万人 and 67 %; nothing in the Answer for the check to flag.
- zh-025 (table-figure): figure wrong or missing; it leaves out 578.3 亿吨 and 3.8 %; nothing in the Answer for the check to flag.
- zh-026 (table-figure): figure wrong or missing; it leaves out 254,545 亿元 and 7.1 %; nothing in the Answer for the check to flag.
- zh-027 (calculated): figure wrong or missing; it leaves out 1,349,084 亿元; nothing in the Answer for the check to flag.
- zh-028 (calculated): figure wrong or missing; it leaves out 438,468 亿元; nothing in the Answer for the check to flag.
- zh-029 (calculated): figure wrong or missing; it leaves out 56.7 %; nothing in the Answer for the check to flag.
- zh-030 (multi-passage): figure wrong or missing; it leaves out 1,349,084 亿元 and 140,828 万人; nothing in the Answer for the check to flag.
- zh-031 (multi-passage): figure wrong or missing; it leaves out 0.2 % and 70,650 万吨; nothing in the Answer for the check to flag.
- zh-032 (multi-passage): figure wrong or missing; it leaves out 1,751 亿件 and 75,238 亿元; nothing in the Answer for the check to flag.
- zh-033 (multi-passage): figure wrong or missing; it leaves out 41,314 元 and 32,024 亿美元; nothing in the Answer for the check to flag.
- zh-036 (single-fact): figure wrong or missing; it leaves out 1,260,582 亿元 and 5.2 %; nothing in the Answer for the check to flag.
- zh-037 (single-fact): figure wrong or missing; it leaves out 69,541 万吨 and 888 万吨; nothing in the Answer for the check to flag.
- zh-038 (single-fact): figure wrong or missing; it leaves out 1,244 万人 and 38 万人; nothing in the Answer for the check to flag.
- zh-039 (single-fact): figure wrong or missing; it leaves out 39,218 元 and 6.3 %; nothing in the Answer for the check to flag.
- zh-040 (table-figure): figure wrong or missing; it leaves out 47,700 万人 and 33.8 %; nothing in the Answer for the check to flag.
- zh-041 (table-figure): figure wrong or missing; it leaves out 556.8 亿吨 and 8.1 %; nothing in the Answer for the check to flag.
- zh-042 (table-figure): figure wrong or missing; it leaves out 50.1 亿吨 and 1.5 %; nothing in the Answer for the check to flag.
- zh-043 (table-figure): figure wrong or missing; it leaves out 6.5 %; nothing in the Answer for the check to flag.
- zh-044 (calculated): figure wrong or missing; it leaves out 1,260,582 亿元; nothing in the Answer for the check to flag.
- zh-045 (calculated): figure wrong or missing; it leaves out 69,541 万吨; nothing in the Answer for the check to flag.
- zh-046 (calculated): figure wrong or missing; it leaves out 54.6 %; nothing in the Answer for the check to flag.
- zh-047 (multi-passage): figure wrong or missing; it leaves out 1,260,582 亿元 and 69,541 万吨; nothing in the Answer for the check to flag.
- zh-048 (multi-passage): figure wrong or missing; it leaves out 39,218 元 and 0.2 %; nothing in the Answer for the check to flag.
- zh-049 (multi-passage): figure wrong or missing; it leaves out 471,495 亿元 and 503,036 亿元; nothing in the Answer for the check to flag.
- zh-052 (conflict): figure wrong or missing; it leaves out 1,260,582 亿元 and 1,294,272 亿元; nothing in the Answer for the check to flag.
- zh-053 (conflict): figure wrong or missing; it leaves out 89,755 亿元 and 89,169 亿元; nothing in the Answer for the check to flag.
- zh-054 (conflict): figure wrong or missing; it leaves out 482,589 亿元 and 475,936 亿元; nothing in the Answer for the check to flag.
- zh-055 (superseded): figure wrong or missing; it leaves out 1,294,272 亿元; nothing in the Answer for the check to flag.
- zh-056 (superseded): figure wrong or missing; it leaves out 729,167 亿元; nothing in the Answer for the check to flag.
- zh-057 (superseded): figure wrong or missing; it leaves out 56.3 %; nothing in the Answer for the check to flag.
- zh-058 (superseded): figure wrong or missing; it leaves out 36.8 %; nothing in the Answer for the check to flag.
- zh-059 (superseded): figure wrong or missing; it leaves out 6.9 %; nothing in the Answer for the check to flag.
- zh-060 (conflict): figure wrong or missing; it leaves out 1,260,582 亿元 and 1,349,084 亿元; nothing in the Answer for the check to flag.
- zh-061 (conflict): figure wrong or missing; it leaves out 89,358 元 and 95,749 元; nothing in the Answer for the check to flag.
- zh-062 (conflict): figure wrong or missing; it leaves out 471,495 亿元 and 483,345 亿元; nothing in the Answer for the check to flag.
- zh-063 (conflict): figure wrong or missing; it leaves out 503,036 亿元 and 514,374 亿元; nothing in the Answer for the check to flag.
- zh-064 (conflict): figure wrong or missing; it leaves out 1,244 万人 and 1,256 万人; nothing in the Answer for the check to flag.
- zh-065 (conflict): figure wrong or missing; it leaves out 69,541 万吨 and 70,650 万吨; nothing in the Answer for the check to flag.
- zh-066 (conflict): figure wrong or missing; it leaves out 39,218 元 and 41,314 元; nothing in the Answer for the check to flag.
- zh-067 (conflict): figure wrong or missing; it leaves out 1,320.7 亿件 and 1,751 亿件; nothing in the Answer for the check to flag.
- zh-072 (table-figure): figure wrong or missing; it leaves out 63.3 平均分; nothing in the Answer for the check to flag.
- zh-075 (multi-passage): figure wrong or missing; it leaves out 184 百万 and 43 %; nothing in the Answer for the check to flag.
- zh-073 (table-figure): figure wrong or missing; it leaves out 201 人死亡（区间下限）; nothing in the Answer for the check to flag.
- zh-068 (conflict): figure wrong or missing; it leaves out 557 亿吨 and 578 亿吨; nothing in the Answer for the check to flag.
- zh-069 (table-figure): figure wrong or missing; it leaves out 688,238 亿元; nothing in the Answer for the check to flag.
- zh-070 (table-figure): figure wrong or missing; it leaves out 1,714.1 十亿美元; nothing in the Answer for the check to flag.
- zh-071 (calculated): figure wrong or missing; it leaves out 37,479.2 十亿美元（负）; nothing in the Answer for the check to flag.

## The scores

| Model | Language | Answers | Quote found | Supported | Figure right | Misses the check caught |
|---|---|---|---|---|---|---|
| ollama/qwen3.5:4b | English | [5 of 75](ollama-qwen3.5-4b.en.json), [2](ollama-qwen3.5-4b.en.json) failed | [8 of 9 (89%)](ollama-qwen3.5-4b.en.json) | [4 of 6 (67%)](ollama-qwen3.5-4b.en.json), [3](ollama-qwen3.5-4b.en.json) to settle | [1 of 2 (50%)](ollama-qwen3.5-4b.en.json) | [2 of 4 (50%)](ollama-qwen3.5-4b.en.json) |
| ollama/qwen3.5:4b | Chinese | [5 of 75](ollama-qwen3.5-4b.zh.json), [3](ollama-qwen3.5-4b.zh.json) failed | [3 of 3 (100%)](ollama-qwen3.5-4b.zh.json) | [1 of 3 (33%)](ollama-qwen3.5-4b.zh.json) | [1 of 2 (50%)](ollama-qwen3.5-4b.zh.json) | [0 of 3 (0%)](ollama-qwen3.5-4b.zh.json) |
| scripted | English | [75 of 75](scripted.en.json) | [72 of 72 (100%)](scripted.en.json) | [72](scripted.en.json) to settle | [0 of 58 (0%)](scripted.en.json) | [0 of 58 (0%)](scripted.en.json) |
| scripted | Chinese | [75 of 75](scripted.zh.json) | [74 of 74 (100%)](scripted.zh.json) | [74](scripted.zh.json) to settle | [0 of 61 (0%)](scripted.zh.json) | [0 of 61 (0%)](scripted.zh.json) |

- **Quote found:** the Citation's quote is at the Location it cites, read again from the Document's text under a looser normalisation than the app's.
- **Supported:** two scripted stand-ins, which compare words and numbers by fixed rules and are no model, say the cited Passage supports the sentence; a person settles where they disagree.
- **Figure right:** every figure the reference answer gives is written in the Answer at its scale. An Answer that gives a superseded figure in place of the current one is counted apart; one that names it as superseded beside the current one is right.

## What the check gets wrong itself

| Model | Language | "Quote not found" on a quote that is there | Cited sentences flagged with no miss | Answers whose Note got no verdict | Sentences it couldn't check |
|---|---|---|---|---|---|
| ollama/qwen3.5:4b | English | [0](ollama-qwen3.5-4b.en.json) | [0](ollama-qwen3.5-4b.en.json) | [2](ollama-qwen3.5-4b.en.json) | [9](ollama-qwen3.5-4b.en.json) |
| ollama/qwen3.5:4b | Chinese | [0](ollama-qwen3.5-4b.zh.json) | [0](ollama-qwen3.5-4b.zh.json) | [1](ollama-qwen3.5-4b.zh.json) | [5](ollama-qwen3.5-4b.zh.json) |
| scripted | English | [0](scripted.en.json) | [0](scripted.en.json) | [0](scripted.en.json) | [0](scripted.en.json) |
| scripted | Chinese | [0](scripted.zh.json) | [0](scripted.zh.json) | [0](scripted.zh.json) | [0](scripted.zh.json) |

## Questions the Documents don't answer

| Model | Language | Said so | Cited something anyway |
|---|---|---|---|
| ollama/qwen3.5:4b | English | [1 of 1 (100%)](ollama-qwen3.5-4b.en.json) | [1 of 1 (100%)](ollama-qwen3.5-4b.en.json) |
| ollama/qwen3.5:4b | Chinese | – | – |
| scripted | English | [0 of 5 (0%)](scripted.en.json) | [5 of 5 (100%)](scripted.en.json) |
| scripted | Chinese | [0 of 5 (0%)](scripted.zh.json) | [5 of 5 (100%)](scripted.zh.json) |

## Cost and time

| Model | Language | Tokens in (cached) | Tokens out | Cost | Time | Run on | Settings |
|---|---|---|---|---|---|---|---|
| ollama/qwen3.5:4b | English | [32,429 (0)](ollama-qwen3.5-4b.en.json) | [2,136](ollama-qwen3.5-4b.en.json) | [none (on this computer)](ollama-qwen3.5-4b.en.json) | [2.0 min](ollama-qwen3.5-4b.en.json) | 2026-10-29, commit 218ac9412, Apple M2 Max (12 cores), darwin arm64 | on this computer, the Note checked, num_ctx 8192, app 0.1.0-alpha.4 |
| ollama/qwen3.5:4b | Chinese | [32,243 (0)](ollama-qwen3.5-4b.zh.json) | [1,619](ollama-qwen3.5-4b.zh.json) | [none (on this computer)](ollama-qwen3.5-4b.zh.json) | [1.6 min](ollama-qwen3.5-4b.zh.json) | 2026-10-29, commit 218ac9412, Apple M2 Max (12 cores), darwin arm64 | on this computer, the Note checked, num_ctx 8192, app 0.1.0-alpha.4 |
| scripted | English | [0 (0)](scripted.en.json) | [0](scripted.en.json) | [none (on this computer)](scripted.en.json) | [3.9 min](scripted.en.json) | 2026-10-30, commit 8c1373b83, Apple M2 Max (12 cores), darwin arm64 | on this computer, the Note checked, app 0.1.0-alpha.4 |
| scripted | Chinese | [0 (0)](scripted.zh.json) | [0](scripted.zh.json) | [none (on this computer)](scripted.zh.json) | [2.9 min](scripted.zh.json) | 2026-10-30, commit 8c1373b83, Apple M2 Max (12 cores), darwin arm64 | on this computer, the Note checked, app 0.1.0-alpha.4 |

## The judges

- [ollama-qwen3.5-4b.en.json](ollama-qwen3.5-4b.en.json): scripted-numbers (a scripted stand-in, no model) and scripted-words (a scripted stand-in, no model); 3 disagreements to settle (`disagreements.json`, settled in `settled.json`).
- [ollama-qwen3.5-4b.zh.json](ollama-qwen3.5-4b.zh.json): scripted-numbers (a scripted stand-in, no model) and scripted-words (a scripted stand-in, no model).
- [scripted.en.json](scripted.en.json): scripted-numbers (a scripted stand-in, no model) and scripted-words (a scripted stand-in, no model); 72 disagreements to settle (`disagreements.json`, settled in `settled.json`).
- [scripted.zh.json](scripted.zh.json): scripted-numbers (a scripted stand-in, no model) and scripted-words (a scripted stand-in, no model); 74 disagreements to settle (`disagreements.json`, settled in `settled.json`).

## Rerun

`npm run eval:citations:score` reproduces every number here from the run files, the judgements and the settlements beside this page; eval/citations/README.md says how to make the runs.
