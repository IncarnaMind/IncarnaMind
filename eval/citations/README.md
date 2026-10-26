# The citation benchmark's set

The Documents, the Questions and the gold answers that the citation benchmark asks every model,
through the app's own Answers path (#1999, part 1). It is test data only: no client, employer or
personal data, and every Document is in the library under a licence or statute that allows it to be
published here.

The set freezes on 2026-12-15. Until then a Question or a quote may be corrected; after it, the set
is fixed and a run says which version it answered.

- `documents.json`: each Document's source, licence, the day the licence was read, its SHA-256 and
  its path.
- `questions.jsonl`: one Question per line, with its gold answer, the quotes it rests on and their
  Locations.
- `checkSet.ts`: loads both and checks every gold quote at its Location against what processing
  stores, with the app's own quote and Location code. `tests/eval/citationsSet.test.ts` runs it with
  `npm test`.

## The Documents

Twelve Documents in English and Chinese, 481 pages. Six are the real Documents #2019 added to
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
| `federal-reserve-statements-2023` | `documents/Federal Reserve Banks Combined Financial Statements 2023.pdf` | 66 | en | https://www.federalreserve.gov/aboutthefed/files/combinedfinstmt2023.pdf | US federal public domain, 17 U.S.C. 105 (2026-10-26) | `ef2e222446c28e78021854b1c335bd2d34a52887eb0ac7aaa014ab8ed078f460` |

Retrieved 2026-10-26. The six `data/real/` Documents are recorded in full in
[`data/README.md`](../../data/README.md); that file holds the same SHA-256 values, and
`tests/eval/realDocuments.test.ts` checks them against the files too. The two new NBS prints and the
Supreme People's Court print are prints of the official pages, made for this set without changing
their text; the 2023 communiqué's print was made the same way for `data/real/`. The page's own text
is the Document.

### Why each may be published here

| Key | Basis, in the licence's or the statute's words |
|---|---|
| `mamba` | "You are free to share — copy and redistribute the material in any medium or format for any purpose, even commercially." (CC BY 4.0 deed) |
| `world-development-report` | The item's rights metadata: "CC BY 3.0 IGO"; the report's copyright page: "you are free to copy, distribute, transmit, and adapt this work, including for commercial purposes, under the following conditions: Attribution." |
| `national-risk-register` | "This publication is licensed under the terms of the Open Government Licence v3.0 except where otherwise stated." (its last page) |
| `nbs-communique-2023`, `nbs-communique-2024`, `nbs-gdp-revision` | "本法不适用于：……（一）法律、法规，国家机关的决议、决定、命令和其他具有立法、行政、司法性质的文件，及其官方正式译文。" (Copyright Law of the PRC, article 5: official documents of state organs are not protected.) |
| `guiding-case-2` | The same article: an official judicial document of a state organ. |
| `fomc-minutes-1950`, `scotus-biden-nebraska`, `federal-reserve-statements-2023`, `cia-reading-room-scan` | "Copyright protection under this title is not available for any work of the United States Government." (17 U.S.C. 105); the Federal Reserve Board adds: "Unless otherwise indicated, information on Board's website is in the public domain and may be copied and distributed without permission." |
| `cern-soil-elements` | The DOAJ record for the journal, 中国科学数据 (ISSN 2096-2223), gives its licence as "CC BY" with https://creativecommons.org/licenses/by/4.0/ (https://doaj.org/api/search/journals/issn%3A2096-2223); the journal publishes its data papers under CC BY 4.0. |

There are no company filings, whose copyright is often unclear: the Federal Reserve Banks' combined
financial statements stand in for a filing.

### The pairs that disagree

- **Two years of one report.** `nbs-communique-2023` and `nbs-communique-2024` report the same
  indicators for 2023 and 2024, so the same phrase ("全年国内生产总值", "全年社会消费品零售总额")
  carries different figures in each. The 2024 communiqué's footnote [38] also says the retail sales
  data were revised after the Fifth National Economic Census, so the 2023 figure does not rest on the
  same basis.
- **A revision of a report.** `nbs-gdp-revision` revises the 2023 figures the 2023 communiqué gave:
  GDP from 1,260,582 to 1,294,272 hundred million yuan, and each sector's value added and share. It
  prints both columns, so the preliminary figure is a decoy a right answer must not give.

## The Questions

150 Questions: 75 asked in English and 75 in Simplified Chinese, 15 of them cross-lingual (9 asked in
English about Chinese Documents, 6 asked in Chinese about English Documents). They hold 195 gold
quotes, 170 figures and 10 decoys.

| Kind | Count | What it tests |
|---|---|---|
| `single-fact` | 40 | One fact, with one quote. |
| `table-figure` | 35 | A figure read from a table or a figure's own text, with its row. |
| `calculated` | 20 | A sum, difference, ratio or per-unit figure worked out from quoted figures. |
| `multi-passage` | 20 | A figure that needs several Passages, with two Locations. |
| `conflict` | 15 | Documents that disagree, or report the same indicator for different years: the answer names both values and both Documents. |
| `absent` | 10 | The Documents do not answer: the right result is to say so and cite nothing. |
| `superseded` | 10 | A figure an earlier Document gives and a later one replaces: the answer gives the current figure and must not give the decoy. |

## The gold

One Question per line in `questions.jsonl`:

```json
{"id":"en-014","kind":"table-figure","language":"en","crossLingual":false,
 "about":["federal-reserve-statements-2023"],
 "question":"What were the Reserve Banks' total assets at December 31, 2023?",
 "answer":"$7,835,559 million.",
 "quotes":[{"document":"federal-reserve-statements-2023","pages":[6,6],
            "quote":"Total assets $ 7,835,559 $ 8,569,354"}],
 "figures":[{"value":7835559,"unit":"millions of dollars","tolerance":0.5}],
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
- `checked`: the day an independent second reader checked this answer against the page text. It
  records when, never who.

Answers are written from the Documents in the language the Question is asked in; a Chinese Document
is quoted in Chinese and an English one in English. A quote is matched the way the app matches a
Citation's quote: after NFKC, letters' case, quote marks and dashes are unified, whitespace beside
Chinese characters is dropped, and a word broken at a line end is joined.

## How the gold was checked

Two checks, both recorded in the set:

1. **A script, on every quote.** `eval/citations/checkSet.ts` reads a Document the way the app does
   (`processFile` in `src/core/documents/processing`), then checks every gold quote with the app's
   own `findQuote` and Location code (`quoteInUnits` in `src/shared/locations`): the quote is at its
   cited Location, it is there verbatim after the app's normalisation, and it is on no other Unit of
   its Document. It also checks every decoy the same way, that every table-figure or superseded
   figure is written in one of its quotes (a calculated answer's result is checked against the
   arithmetic by the second reader, not by the script), and the set's shape: 150 Questions, the counts above, 75 in each
   language, 15 cross-lingual, and a `checked` day on every Question. `tests/eval/citationsSet.test.ts`
   runs it with `npm test`, so a quote or a hash that drifts fails CI.

   ```sh
   npx vitest run tests/eval/citationsSet.test.ts
   ```

2. **A second reader, on every answer.** Every answer was checked against the page text by an
   independent reader who did not write it: that each quote is on its page, that the answer's
   figures, units, years and attribution match the text, that arithmetic holds, that a `conflict`
   answer names both Documents' values, that a `superseded` answer gives the current figure and not
   the decoy, and that an `absent` Question really is unanswered by the library. A Question whose
   answer did not pass was corrected and checked again; `checked` records the day it passed.

## Licence

The code in this folder is Apache-2.0, like the app. The Questions and their gold answers are
CC BY 4.0. Each Document stays under its own licence or statute, as the table above says.

## Known quirks of the prints

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
