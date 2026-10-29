# The citation benchmark

A public, reproducible answer to "do AI citations hold up?" (#1999). Each model answers the same 150
Questions about public Documents, in English and Chinese, through the app's own Answers path, and
every Answer is scored four ways, per model and language:

- **Quote found**: the Citation's quote is really at the Location it cites. The scorer reads the
  Document's text again, under a looser normalisation than the app's own check, so a miss of the
  check shows too. Deterministic.
- **Supported**: the Passage the Citation names supports its sentence, as two independent model
  judges say with one fixed prompt; where they disagree, a person settles it, and the disagreements
  are listed.
- **Figure right**: every figure the reference answer gives is written in the Answer, at its unit's
  scale ("$1.88 trillion" gives 1,875.6 billion; "129.4万亿元" gives 1,294,272亿元). An Answer that
  gives a superseded figure in place of the current one is counted apart. Deterministic.
- **With the check**: of each miss above, whether the app's check flagged it (a Citation's "Quote
  not found", or a sentence that Check this Note found unsupported or contradicted), what it let
  through, and what it got wrong itself: "Quote not found" on a quote that is there, and cited
  sentences flagged with no miss in them.

The results page leads with the misses, and every number on it links to the run file it is counted
from.

## Rerunning it

Every command runs from the repository root. Each process gets a temporary home and data folder of
its own (the evaluation's home guard sees to it); nothing reads or writes the app's data folder.

```sh
npm run eval:citations:estimate   # what each model's full run is expected to cost, and the most
npm run eval:citations            # one model answers every Question (paid with a cloud model)
npm run eval:citations:judge      # two judges read every Citation (paid)
npm run eval:citations:score      # every score and RESULTS.md, from the files alone (free)
npm run eval:citations:scan       # no key, personal data or unlisted Document in any file (free)
```

1. **Estimate.** `npm run eval:citations:estimate` prints, for each planned model, the tokens and
   US dollars its run and its judging are expected to take, and the most they may, at the app's own
   catalog prices. A model whose run has started is estimated from what its Questions took.
   `INCARNAMIND_EVAL_CITATIONS_MODELS=anthropic/claude-haiku-5-5,kimi/kimi-k2.6@intl` estimates
   other models.
2. **Run.** The model is set with the `INCARNAMIND_EVAL_CHAT_*` variables, as for `npm run eval`
   (`eval/README.md`); setting them is the consent to send the Questions, the Passages and the
   Answers' sentences to it. A model with a price needs a cap, and the run refuses to start when
   the estimate passes it:

   ```sh
   INCARNAMIND_EVAL_CHAT_KIND=anthropic INCARNAMIND_EVAL_CHAT_MODEL=claude-haiku-5-5 \
   INCARNAMIND_EVAL_CITATIONS_CAP_USD=5 npm run eval:citations
   ```

   Each Question is asked once, in a Note of its own, on a library of the twelve Documents added as
   the app adds them (embeddings off, keyword search reranked by the built-in model, as by default).
   Then the Answer's Note is checked as Check this Note checks it, on the same model. The run file
   is written after every Answer.
3. **Judge.** Name the two judges as the chat model is named, with `INCARNAMIND_EVAL_JUDGE_*` and
   `INCARNAMIND_EVAL_SECOND_JUDGE_*`: two models of other families than the run's. Neither may judge
   its own model's runs, and the cap holds for them too. Their verdicts go into `judgements/`, one
   file per run and judge, a line a Citation.
4. **Settle.** `npm run eval:citations:score` lists the Citations the judges disagree on in
   `disagreements.json`. A person reads each Passage and writes the verdict into `settled.json`:
   `{"<run file>": {"en-014#1": {"verdict": "supported", "why": "…", "date": "2027-01-20"}}}`.
5. **Score.** `npm run eval:citations:score` writes `scores.json` and `RESULTS.md` beside the runs.
   It calls no model, so it gives the same numbers every time from the same files.
6. **Scan.** `npm run eval:citations:scan` fails on any key (by the shapes services give them, and
   any value the shell holds under a key's name), e-mail address, phone number, home folder path or
   Document the set doesn't list, in the set, the runs, the judgements and the results. An address
   a Document's publisher printed in it (an author's, a court's press office) passes only by its
   entry in `scan-allowed.json`, which names it by its SHA-256 and says why. `npm test` runs the
   scan over `eval/citations/`.

| Variable | Default | |
|---|---|---|
| `INCARNAMIND_EVAL_CITATIONS_CAP_USD` | none | The most a run, or the judging, may spend, in US dollars, its earlier spending included. Required for a model with a price. Before each Question the run reserves the most it may cost, and stops rather than pass the cap. |
| `INCARNAMIND_EVAL_CITATIONS_LANGUAGES` | `en,zh` | The languages to run, a run file each. |
| `INCARNAMIND_EVAL_CITATIONS_CHECK` | `on` | `off` leaves each Answer's Note unchecked, so "with the check" reads only the Citations' own check. |
| `INCARNAMIND_EVAL_CITATIONS_RUNS` | `eval/citations/runs` | The folder of the run files, the judgements, the settlements, the scores and the results page. |
| `INCARNAMIND_EVAL_CITATIONS_SCRIPTED` | off | `1` asks the smoke tests' scripted chat model instead, and judges with two scripted stand-ins: a check of the pipeline at no cost, never published numbers. |
| `INCARNAMIND_EVAL_QUESTIONS` | all | Only these Questions, by id, as for `npm run eval`. |

`INCARNAMIND_EVAL_ANSWER_TIMEOUT_S`, `INCARNAMIND_EVAL_RERANK_DEPTH`, `INCARNAMIND_EVAL_MAX_PASSAGES`,
`INCARNAMIND_EVAL_RERANK_CPU` and the Ollama settings work as for `npm run eval`, and each run file
records them.

### A run that stops

A run stops before a Question the cap couldn't cover, and at a provider's answer no later Question
gets past (a refused key, no credit, an unknown model), saying why in its file. Run the same command
again: it keeps every Answer that finished, stopped or ran out of time, since those were paid for,
asks again only those that failed, and counts what the failed ones cost against the cap. A run file
made with another model, set, settings or commit isn't resumed; the command says so and asks for
another folder.

### The run files

One per model and language, `<kind>-<model>.<language>.json`, with the set's version and hashes,
the exact model id and endpoint, where the Questions were sent, the date, the app's version and
commit, the settings (the catalog price the cost was worked out at among them), the computer, and
each Document's stored text hashed. For each Answer: its text, sentences, Citations (quote,
Document, Location, the app's check of it, the Passage it names), Calculated figures, searches,
the check of its Note sentence by sentence, the tokens of the Answer and of the check, their cost
and their time. A provider's error is kept with any key it quotes taken out.

## The cost

The estimate assumes what the app's Answers path was measured to take on the mixed sample set: an
Answer about 40,000 tokens in and 1,300 out, 70% of the input from the provider's prompt cache, and
the check of its Note about five claims at 16,700 in and 330 out each. Judging assumes three
Citations an Answer, each about 1,500 tokens in and 120 out per judge. "At most" takes four times
the tokens with no cache, as the largest measured Answer did. Prices are the app's catalog's on
2026-10-29; Claude Opus 5.5 and Gemini 3.1 Pro stand in for the judges until they are chosen.

| Model | The run, expected | The judges, expected | At most, both |
|---|---|---|---|
| Claude Sonnet 5.5 | $17.59 | $5.78 | $177.08 |
| Claude Haiku 5.5 | $0.95 | $5.78 | $14.34 |
| GPT-6 Luna | $0.95 | $5.78 | $14.34 |
| GPT-6.1 Sol | $17.59 | $5.78 | $177.08 |
| Gemini 3.8 Flash | $7.09 | $5.78 | $70.02 |
| Kimi K2.6 (International) | $9.48 | $5.78 | $85.68 |
| DeepSeek V4 Pro | $4.82 | $5.78 | $57.59 |
| qwen3.5:4b on Ollama | none | $5.78 | $5.78 |
| **All** | **$58.46** | **$46.22** | **$601.91** |

## The pipeline check

`pipeline-check/` holds the whole pipeline run at no cost, to show it works end to end: every
Question asked of the scripted chat model, and 10 Questions asked of qwen3.5:4b on Ollama, both
judged by the scripted stand-ins, then scored and scanned. Its `RESULTS.md` says at its top that
these are not published numbers: the scripted model searches and cites the first line that shares a
word with the Question, so its scores say only that each step runs.

## Publishing

The published runs go into `runs/`, with their judgements, settlements, `scores.json` and
`RESULTS.md`. Before they are published: every planned model has both languages' runs, every
Citation is judged by two model judges and every disagreement settled, the runs come from a commit
with no uncommitted changes, and `npm run eval:citations:scan` passes. Rerunning a model gives
scores within the variance the results page states once a model has been run twice.

## The set

The Documents, the Questions and the gold answers the benchmark asks every model. It is test data
only: no client, employer or personal data, and every Document is in the library under a licence or
statute that allows it to be published here.

The set freezes on 2026-12-15. Until then a Question or a quote may be corrected; after it, the set
is fixed and a run says which version it answered.

- `documents.json`: each Document's source, licence, the day the licence was read, its SHA-256 and
  its path.
- `questions.jsonl`: one Question per line, with its gold answer, the quotes it rests on and their
  Locations.
- `checkSet.ts`: loads both and checks every gold quote at its Location against what processing
  stores, with the app's own quote and Location code. `tests/eval/citationsSet.test.ts` runs it with
  `npm test`, checks that no Question or gold quote is written in the app's prompts or their
  examples, and runs the scan.

### The Documents

Twelve Documents in English and Chinese, 435 pages. Six are the real Documents #2019 added to
`data/real`, referenced from there and not copied; six are added for this set in `documents/`. Each
is a text PDF that the app reads; the one page without a text layer, a CIA Reading Room scan, is part
of the library and no gold quote cites it.

| Key | File | Pages | Language | Source | Licence (read) | SHA-256 |
|---|---|---|---|---|---|---|
| `mamba` | `data/real/Mamba Linear-Time Sequence Modeling with Selective State Spaces.pdf` | 36 | en | https://arxiv.org/abs/2312.00752 | CC BY 4.0 (2026-10-26) | `adf70ed1803c85b1899dec3e21f3af0b124411439e8654b840ea65f7b9f52b2e` |
| `world-development-report` | `data/real/World Development Report 2023 Overview.pdf` | 20 | en | https://openknowledge.worldbank.org/bitstreams/95ff039b-394f-4dc6-9ad9-b85da5a0b0d3/download | CC BY 3.0 IGO (2026-10-26) | `28f967181d2aeaab9b28e4ef463aa66a6ef4f72a0ad54e119b19d3681af992e7` |
| `national-risk-register` | `data/real/National Risk Register 2023.pdf` | 192 | en | https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/1175834/2023_NATIONAL_RISK_REGISTER_NRR.pdf | Open Government Licence v3.0 (2026-10-26) | `4d3a29e5eb530efeb78bccf574521699c7f7df6fa15b614f8a22aabf203094cd` |
| `nbs-communique-2023` | `data/real/中华人民共和国2023年国民经济和社会发展统计公报.pdf` | 22 | zh | https://www.stats.gov.cn/xxgk/sjfb/tjgb2020/202402/t20240229_1947923.html | Copyright Law of the PRC, article 5 (2026-10-26) | `a3561d2f63273957f84bd9a4d7374d0e57bae45f70c96b0a6b561c1020c8675f` |
| `fomc-minutes-1950` | `data/real/FOMC Historical Minutes 13 June 1950.pdf` | 14 | en | https://www.federalreserve.gov/monetarypolicy/files/FOMChistmin19500614.pdf | US federal public domain, 17 U.S.C. 105 (2026-10-26) | `d74aea9b91bcb79836ab6e9cdc8c45942b3b4fecb9eb0840dc7e168370f0027e` |
| `cia-reading-room-scan` | `data/real/scanned/CIA Reading Room record 22 October 1965.pdf` | 1 | en | https://www.cia.gov/readingroom/document/cia-rdp75-00149r000800170070-2 (file: https://archive.org/download/cia-readingroom-document-cia-rdp75-00149r000800170070-2/cia-rdp75-00149r000800170070-2.pdf) | US federal public domain, 17 U.S.C. 105 (2026-10-26) | `764e4ea530cbcb4818c31f21481e596eb119004deadea43e6f7247260407e9ba` |
| `scotus-biden-nebraska` | `documents/Biden v. Nebraska 600 U.S. (2023) 22-506.pdf` | 77 | en | https://www.supremecourt.gov/opinions/22pdf/22-506_nmip.pdf | US federal public domain, 17 U.S.C. 105 (2026-10-26) | `ac5cb286b5795e18e1942c5dc066750b64ccbbcd1de71e1400fcb264a3730003` |
| `guiding-case-2` | `documents/指导案例2号 吴梅诉四川省眉山西城纸业有限公司买卖合同纠纷案.pdf` | 2 | zh | https://www.court.gov.cn/shenpan/xiangqing/4215.html | Copyright Law of the PRC, article 5 (2026-10-26) | `51962a5a05009a1e8ce513e402dc37b1663c19346adf5ba9ced01816d1da3319` |
| `nbs-communique-2024` | `documents/中华人民共和国2024年国民经济和社会发展统计公报.pdf` | 34 | zh | https://www.stats.gov.cn/sj/zxfb/202502/t20250228_1958817.html | Copyright Law of the PRC, article 5 (2026-10-26) | `9c204863ab9362e68db5023f464b0f72db934a16258022c18a0c753d4fbe1ccd` |
| `nbs-gdp-revision` | `documents/国家统计局关于修订2023年国内生产总值数据的公告.pdf` | 1 | zh | https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202412/t20241227_1957915.html | Copyright Law of the PRC, article 5 (2026-10-26) | `8d0d9d9a390e42470155dc2bcb0f47265f0e159ca85f3d05b5641f1ae357f5c4` |
| `cern-soil-elements` | `documents/1995-2011年CERN土壤环境元素含量数据集.pdf` | 16 | zh | https://doi.org/10.11922/csdata.170.2016.0102 (file: https://www.chinaflux.org/upload/accessory/20195/2019571530435901963.pdf) | CC BY 4.0 (2026-10-26) | `5c6c3cb9bfd4c30cf39cf5997b5e79a29bc8f904a76d79a8ba3c317b0293a24a` |
| `treasury-financial-statements-2023` | `documents/Treasury Financial Statements of the United States Government FY2023.pdf` | 20 | en | https://fiscal.treasury.gov/system/files/files/reports-statements/financial-report/2023/financial-statements-2023.pdf | US federal public domain, 17 U.S.C. 105 (2026-10-26) | `aa8e8d0eb839c0ac2cfdb5db3716f7c2baa84dfc193d3af434df3dbaa8278a19` |

Retrieved 2026-10-26. The six `data/real/` Documents are recorded in full in
[`data/README.md`](../../data/README.md); that file holds the same SHA-256 values, and
`tests/eval/realDocuments.test.ts` checks them against the files too. The two new NBS prints and the
Supreme People's Court print are prints of the official pages, made for this set without changing
their text; the 2023 communiqué's print was made the same way for `data/real/`. The page's own text
is the Document.

#### Why each may be published here

| Key | Basis, in the licence's or the statute's words |
|---|---|
| `mamba` | "You are free to share — copy and redistribute the material in any medium or format for any purpose, even commercially." (CC BY 4.0 deed) |
| `world-development-report` | The item's rights metadata: "CC BY 3.0 IGO"; the report's copyright page: "you are free to copy, distribute, transmit, and adapt this work, including for commercial purposes, under the following conditions: Attribution." |
| `national-risk-register` | "This publication is licensed under the terms of the Open Government Licence v3.0 except where otherwise stated." (its last page) |
| `nbs-communique-2023`, `nbs-communique-2024`, `nbs-gdp-revision` | "本法不适用于：……（一）法律、法规，国家机关的决议、决定、命令和其他具有立法、行政、司法性质的文件，及其官方正式译文。" (Copyright Law of the PRC, article 5: official documents of state organs are not protected.) |
| `guiding-case-2` | The same article: an official judicial document of a state organ. |
| `fomc-minutes-1950`, `scotus-biden-nebraska`, `cia-reading-room-scan` | "Copyright protection under this title is not available for any work of the United States Government." (17 U.S.C. 105); the Federal Reserve Board adds, for the minutes: "Unless otherwise indicated, information on Board's website is in the public domain and may be copied and distributed without permission." |
| `treasury-financial-statements-2023` | "Copyright protection under this title is not available for any work of the United States Government." (17 U.S.C. 105). The Treasury, an executive department, publishes these statements in the Financial Report of the United States Government. |
| `cern-soil-elements` | The DOAJ record for the journal, 中国科学数据 (ISSN 2096-2223), gives its licence as "CC BY" with https://creativecommons.org/licenses/by/4.0/ (https://doaj.org/api/search/journals/issn%3A2096-2223); the journal publishes its data papers under CC BY 4.0. |

There are no company filings, whose copyright is often unclear: the Treasury's financial statements
stand in for a filing.

#### The pairs that disagree

- **Two years of one report.** `nbs-communique-2023` and `nbs-communique-2024` report the same
  indicators for 2023 and 2024, so the same phrase ("全年国内生产总值", "全年社会消费品零售总额")
  carries different figures in each. The 2024 communiqué's footnote [38] also says the retail sales
  data were revised after the Fifth National Economic Census, so the 2023 figure does not rest on the
  same basis.
- **A revision of a report.** `nbs-gdp-revision` revises the 2023 figures the 2023 communiqué gave:
  GDP from 1,260,582 to 1,294,272 hundred million yuan, and each sector's value added and share. It
  prints both columns, so the preliminary figure is a decoy a right answer must not give.

### The Questions

150 Questions: 75 asked in English and 75 in Simplified Chinese, 15 of them cross-lingual (9 asked in
English about Chinese Documents, 6 asked in Chinese about English Documents). They hold 196 gold
quotes, 175 figures and 10 decoys.

| Kind | Count | What it tests |
|---|---|---|
| `single-fact` | 40 | One fact, with one quote. |
| `table-figure` | 35 | A figure read from a table or a figure's own text, with its row. |
| `calculated` | 20 | A sum, difference, ratio or per-unit figure worked out from quoted figures. |
| `multi-passage` | 20 | A figure that needs several Passages, with two Locations. |
| `conflict` | 15 | Documents that disagree, or report the same indicator for different years: the answer names both values and both Documents. |
| `absent` | 10 | The Documents do not answer: the right result is to say so and cite nothing. |
| `superseded` | 10 | A figure an earlier Document gives and a later one replaces: the answer gives the current figure and must not give the decoy. |

### The gold

One Question per line in `questions.jsonl`:

```json
{"id":"en-014","kind":"table-figure","language":"en","crossLingual":false,
 "about":["treasury-financial-statements-2023"],
 "question":"In the FY 2023 Statement of Net Cost, what gross cost does the Department of Health and Human Services report?",
 "answer":"$1,875.6 billion.",
 "quotes":[{"document":"treasury-financial-statements-2023","pages":[8,8],
            "quote":"Department of Health and Human Services 1,875.6 161.2 1,714.4 (0.3) 1,714.1"}],
 "figures":[{"value":1875.6,"unit":"billions of dollars","tolerance":0.05}],
 "checked":"2026-10-26"}
```

- `language` is the language the Question is asked in; `crossLingual` says its Documents are in the
  other language. `about` names every Document the Question is about.
- `quotes`: each with the Document, the Location (`pages`, the first and last Unit from 1: a PDF's
  page as pdf.js indexes it) and the text the answer rests on, quoted from the page. A Location is
  one Unit or two consecutive ones, as a Citation may name.
- `figures`: each with its value, unit and the rounding the source shows (its tolerance).
- `decoy` (a `superseded` Question only): the superseded figure, with its own Document, Location and
  quote, which a right answer must not give.
- `checked`: the day independent model passes checked this answer against the page text. It
  records when, never who.

Answers are written from the Documents in the language the Question is asked in; a Chinese Document
is quoted in Chinese and an English one in English. A quote is matched the way the app matches a
Citation's quote: after NFKC, letters' case, quote marks and dashes are unified, whitespace beside
Chinese characters is dropped, and a word broken at a line end is joined.

### How the gold was checked

Two checks, both recorded in the set:

1. **A script, on every quote.** `eval/citations/checkSet.ts` reads a Document the way the app does
   (`processFile` in `src/core/documents/processing`), then checks every gold quote with the app's
   own `findQuote` and Location code (`quoteInUnits` in `src/shared/locations`): the quote is at its
   cited Location, it is there verbatim after the app's normalisation, and it is on no other Unit of
   its Document. It also checks every decoy the same way, that every table-figure or superseded
   figure is written in one of its quotes (a calculated answer's result is checked against the
   arithmetic by the independent model passes, not by the script), and the set's shape: 150 Questions, the counts above, 75 in each
   language, 15 cross-lingual, and a `checked` day on every Question. `tests/eval/citationsSet.test.ts`
   runs it with `npm test`, so a quote or a hash that drifts fails CI.

   ```sh
   npx vitest run tests/eval/citationsSet.test.ts
   ```

2. **Independent model passes, on every answer.** The gold answers were written for this set from
   the Documents, then every answer was checked against the page text by independent model passes
   that did not write it: that each quote is on its page, that the answer's figures, units, years and
   attribution match the text, that arithmetic holds, that a `conflict` answer names both Documents'
   values, that a `superseded` answer gives the current figure and not the decoy, and that an
   `absent` Question really is unanswered by the library. A Question whose answer did not pass was
   corrected and checked again; `checked` records the day it passed.

### Known quirks of the prints

- The prints keep many Chinese characters as Kangxi-radical code points (人, 比, 生 and others). The
  app's quote normalisation folds them to the characters the page shows, and the gold quotes are
  written in those characters.
- One character in the 2023 communiqué's print is mapped to the wrong radical: 口 (as in 人口) is
  stored as a radical that normalises to 又, so that Document's stored text reads "人又" where the
  page shows "人口". No gold quote uses a span with that character; a run that quotes such a span of
  that Document will see the app's check read it as a different character. The quirk is the print's,
  not the benchmark's, and it is recorded here so a reader of the results knows.
- The CIA Reading Room record has no text layer. It is in the library as a Document a run must cope
  with, and no Question rests on it.

## Licence

The code in this folder is Apache-2.0, like the app. The Questions, their gold answers, the run
files, the judgements, the scores and the results pages are CC BY 4.0. Each Document stays under
its own licence or statute, as the table above says.
