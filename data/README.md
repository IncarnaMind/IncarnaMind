# Sample PDFs

The seven generated PDFs in this folder and the six real Documents in `real/` are the Documents
the evaluations and some tests read (`eval/README.md`, `tests/core/sampleDocuments.test.ts`,
`tests/eval/realDocuments.test.ts`).

## The generated samples

All seven were made for this repository, each in the voice of a fictional organisation. No real
company, agency or body is named or described in them — in the text, the running heads, the file
names or the documents' metadata (Title, Author, Subject and Keywords) — and their figures are
illustrative. Nothing in them is third-party content: no sentence, table or figure is quoted from
another work, and each file is licensed under the repository's licence, Apache-2.0.

`npm run samples:generate` writes all seven from `scripts/sampleDocuments/`, and
`tests/core/sampleDocuments.test.ts` checks that each file in this folder is what the generator
writes, that every sentence the tests and evaluations quote is stored on the page they cite, and
that it is on no other page. It also checks that no Document repeats a run of twelve words from the
four third-party papers this folder held before 2026-10-25:
`tests/fixtures/old-paper-12-word-runs.txt` holds a digest of every such run.

| File | Fictional publisher | Title | Pages | Licence |
|---|---|---|---|---|
| `MPMA Code of Practice for the Pharmaceutical Industry 2021.pdf` | Marlowmere Pharmaceutical Manufacturers Association | Code of Practice for the Pharmaceutical Industry 2021 | 68 | Apache-2.0 |
| `Weighted Keys Shorter Paths.pdf` | Calventis Institute for Machine Intelligence | Weighted Keys, Shorter Paths | 15 | Apache-2.0 |
| `Tuning the Tuner.pdf` | Torvane Laboratory for Optimisation Research | Tuning the Tuner | 12 | Apache-2.0 |
| `What a Corpus Teaches.pdf` | Wrennick Research | What a Corpus Teaches | 24 | Apache-2.0 |
| `Demonstrations Not Weights.pdf` | Brellan AI Research | Demonstrations, Not Weights | 75 | Apache-2.0 |
| `Vantrell Financial Group 2022 ESG Report.pdf` | Vantrell Financial Group | 2022 Environmental, Social and Governance Report | 74 | Apache-2.0 |
| `Norvath Assembly Annual Report 2022.pdf` | The Norvath Assembly | Annual Report of the Norvath Assembly 2022 | 67 | Apache-2.0 |

## Real Documents in `real/`

Six real third-party Documents, each under a licence or statute that allows redistribution inside
this public repository. They are added beside the generated samples so the evaluations are not read
on clean generated files only (issue #2019): the five readable ones to the gating set
(`eval/retrieval/questions.json`) and the everyday set's `reports` library, and all six to the hard
tier's library (`eval/hard/library.json`). The one-page scan, `real/scanned/`, is added to the hard
tier only: it has no text, and the gating and everyday runs require every Document to be readable. Each source, the licence and the day it was read, the
basis in the licence's or the statute's own words, and the file's SHA-256 are below; the hard tier's
manifest and the gating set carry the same values, and `tests/eval/realDocuments.test.ts` checks
them against the files, so a replaced or corrupted file fails the test instead of silently changing
what the evaluations read.

| File | Publisher and title (attribution) | Pages | Source | Licence (read) | Basis, in the licence's or the statute's words | SHA-256 |
|---|---|---|---|---|---|---|
| `real/Mamba Linear-Time Sequence Modeling with Selective State Spaces.pdf` | Albert Gu and Tri Dao, "Mamba: Linear-Time Sequence Modeling with Selective State Spaces", arXiv:2312.00752v2 | 36 | https://arxiv.org/abs/2312.00752 (file: https://arxiv.org/pdf/2312.00752v2) | CC BY 4.0 (2026-10-26) | "You are free to share — copy and redistribute the material in any medium or format for any purpose, even commercially." (CC BY 4.0 deed) | `adf70ed1803c85b1899dec3e21f3af0b124411439e8654b840ea65f7b9f52b2e` |
| `real/World Development Report 2023 Migrants Refugees and Societies.pdf` | World Bank, "World Development Report 2023: Migrants, Refugees, and Societies" (© 2023 International Bank for Reconstruction and Development / The World Bank) | 348 | https://openknowledge.worldbank.org/bitstreams/18158725-499e-4600-814c-0d0c956aa2a1/download (handle: https://hdl.handle.net/10986/39696) | CC BY 3.0 IGO (2026-10-26) | "This work is available under the Creative Commons Attribution 3.0 IGO license … you are free to copy, distribute, transmit, and adapt this work, including for commercial purposes, under the following conditions: Attribution." (its copyright page) | `d14e62b3c335091881181bb9e591fe6fe2e70d33349967e0b79c59f2f5c6366e` |
| `real/National Risk Register 2023.pdf` | Cabinet Office, "National Risk Register 2023 edition" (© Crown copyright 2023) | 192 | https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/1175834/2023_NATIONAL_RISK_REGISTER_NRR.pdf (publication: https://www.gov.uk/government/publications/national-risk-register-2023) | Open Government Licence v3.0 (2026-10-26) | "This publication is licensed under the terms of the Open Government Licence v3.0 except where otherwise stated." (its last page) | `4d3a29e5eb530efeb78bccf574521699c7f7df6fa15b614f8a22aabf203094cd` |
| `real/中国金融稳定报告2024.pdf` | 中国人民银行金融稳定分析小组, 《中国金融稳定报告2024》 | 120 | https://www.pbc.gov.cn/jinrongwendingju/146766/146772/08b4b564775242619f8386232f9f4fae/2025010317243072518.pdf (publication: https://www.pbc.gov.cn/jinrongwendingju/146766/146772/08b4b564775242619f8386232f9f4fae/index.html) | Copyright Law of the PRC, article 5 (2026-10-26) | "本法不适用于：……（一）法律、法规，国家机关的决议、决定、命令和其他具有立法、行政、司法性质的文件，及其官方正式译文。" (official documents of state organs are not protected) | `f72c45fe00031753b846b8fe404d7cac5ed0722c1d477bea9079a81e7dbcd69e` |
| `real/FOMC Historical Minutes 13 June 1950.pdf` | Board of Governors of the Federal Reserve System, minutes of the Federal Open Market Committee meeting of 13 June 1950 | 14 | https://www.federalreserve.gov/monetarypolicy/files/FOMChistmin19500614.pdf (historical materials: https://www.federalreserve.gov/monetarypolicy/fomchistorical1950.htm) | US federal public domain, 17 U.S.C. 105 (2026-10-26) | "Unless otherwise indicated, information on Board's website is in the public domain and may be copied and distributed without permission. Please cite to the Board as the source of the information." (the Board's disclaimer) | `d74aea9b91bcb79836ab6e9cdc8c45942b3b4fecb9eb0840dc7e168370f0027e` |
| `real/scanned/CIA Reading Room record 22 October 1965.pdf` | US Central Intelligence Agency, CIA-RDP75-00149R000800170070-2, 22 October 1965 (CIA Reading Room) | 1 | https://archive.org/download/cia-readingroom-document-cia-rdp75-00149r000800170070-2/cia-rdp75-00149r000800170070-2.pdf (the record: https://www.cia.gov/readingroom/document/cia-rdp75-00149r000800170070-2; the CIA site serves the reading room through a script, so the file comes from the Internet Archive's mirror of the record) | US federal public domain, 17 U.S.C. 105 (2026-10-26) | "Copyright protection under this title is not available for any work of the United States Government." (17 U.S.C. 105) | `764e4ea530cbcb4818c31f21481e596eb119004deadea43e6f7247260407e9ba` |

### What the real files bring

| File | Shapes |
|---|---|
| `Mamba…` | Two-column pages; page-bottom footnotes (p. 1); figures with labelled axes |
| `World Development Report 2023…` | Charts with numbers in them (Figure O.1, a population pyramid with its age bands and values, p. 33); eleven image-only full-page figures and maps |
| `National Risk Register 2023.pdf` | A table that runs across a page break (Table 2, pp. 12-13); a risk matrix with its 1-5 likelihood and impact scales and percentages (pp. 11-13) |
| `中国金融稳定报告2024.pdf` | Chinese; tables that run across pages (续表, pp. 72 and 115); charts with numbers (图1-1 etc.) |
| `FOMC Historical Minutes 13 June 1950.pdf` | Scanned typewritten pages (images with an OCR text layer) |
| `scanned/CIA Reading Room record 22 October 1965.pdf` | A scanned page with no text layer at all: the reader finds no text |

## What was here before

Until 2026-10-25 this folder held seven third-party PDFs: published research papers, a trade
association's code of practice, a bank's ESG report and an international organisation's annual
report. None of their publishers' terms allowed this repository to redistribute the file, so on
2026-10-25 they were removed and replaced with the fictional documents above, each the same number
of pages and shape, with tables, charts and the text the tests and evaluations read.

The original files remain only in the repository's history. Removing them from the history would
take a rewrite, which the repository's audit of 2026-10-25 advised against.
