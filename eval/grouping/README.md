# The grouping fixture set

The grouping check (`npm run eval:grouping`, #51) measured whether Documents could be grouped into generated Topics by clustering their vectors, before the Library was built. With the built-in embedding model they couldn't: the Topics split by language (see Results). ADR-0012 replaced Topics with Folders and Tags, and on 2026-10-10 the check was removed with the Topic code it measured (`src/core/topics/`). Its code, how to run it and its full report were last on `main` at commit `145c3a4`.

What stays here is the fixture set, because the local classification comparison (`eval/classification/`) reads it: `set.json` gives each Document's path, subject and language, and `fixtures/` holds the files that were new for the check, with their sources and licences in `fixtures/ATTRIBUTION.md`. The check's own cases (`choosing`, `heldOut`, `sharedNames`, `lateArrivals` and `corrections`) were removed from `set.json` too, because nothing reads them; they are in the history at commit `145c3a4`.

## The fixture set

47 Documents on 12 subjects.

| Subject | English | Chinese | Deck or spreadsheet |
|---|---|---|---|
| Attention and sequence models | Weighted Keys Shorter Paths (PDF) | 维基百科-注意力机制 (PDF), 维基百科-Transformer架构 | Transformer architecture (deck) |
| Gradient descent | Tuning the Tuner (PDF), Stochastic gradient descent · Wikipedia | 维基百科-梯度下降法 (PDF) | 梯度下降法讲义 (deck, Chinese) |
| Large language models | Demonstrations Not Weights, What a Corpus Teaches (PDFs) | 维基百科-大型语言模型 (PDF), 维基百科-GPT-3 | |
| The Assembly and the development goals | Norvath Assembly Annual Report 2022 (PDF) | 维基百科-可持续发展目标 (PDF), 维基百科-千年发展目标 | SDGs overview (deck) |
| ESG | Vantrell 2022 ESG Report (PDF), Socially responsible investing · Wikipedia | 维基百科-环境、社会和公司治理 (PDF) | ESG reporting basics (deck) |
| Medicines and the pharmaceutical industry | MPMA Code of Practice (PDF), Pharmaceutical marketing · Wikipedia | 维基百科-药品 | |
| Tea | Tea · Wikipedia, Green tea · Wikipedia | 茶 · 维基百科 | 茶叶加工流程 (deck, Chinese) |
| Earthquakes | Earthquake · Wikipedia | 维基百科-地震, 维基百科-地震学 | usgs_significant_quakes_2023 (CSV, USGS) |
| Climate change | Climate change · Wikipedia | 维基百科-气候变化, 维基百科-温室气体 | co2_annmean_mlo (XLSX, NOAA) |
| Mars | Mars · Wikipedia | 维基百科-火星, 维基百科-火星探测 | Mars fact sheet (NASA) (XLSX) |
| Photosynthesis | Photosynthesis · Wikipedia, Chlorophyll · Wikipedia | 维基百科-光合作用 | 光合作用课件 (deck, Chinese) |
| Inflation | Inflation · Wikipedia, Consumer price index · Wikipedia | 维基百科-通货膨胀 | CPI-U 2015-2024 (XLSX, BLS) |

The PDFs are the evaluation's own: the seven samples in `data/` (made for this repository and licensed under Apache-2.0; see [`data/README.md`](../../data/README.md)) and the five Chinese Wikipedia articles in `eval/retrieval/fixtures/`. The tea pair is the app's example Documents (`resources/examples/`).

## Results

Measured on 2026-10-08 at commit `02a5216`, on an Apple M2 Max (12 cores) with Node v25.5.0, with the built-in model, multilingual-e5-small. Each Document's vector was the mean of its Passage vectors, grouped by spherical k-means with k = 12, one cluster per subject.

**The bars failed.** With every Document vector, 0 of the 5 held-out English–Chinese pairs landed in one Topic (the bar was 4). Decks and spreadsheets passed with the chosen vector, 4 of 5 (the bar was 3).

| Document vector | Choosing: pairs | Choosing: decks | Held-out: pairs | Held-out: decks | Purity | Topics (not grouped yet) | Topics with both languages |
|---|---|---|---|---|---|---|---|
| **Names included (chosen)** | 0/6 | 3/5 | **0/5** | **4/5** | 35% | 6 (10) | 0 |
| Name's direction removed | 0/6 | 2/5 | 0/5 | 2/5 | 32% | 6 (9) | 0 |
| Name-free | 0/6 | 2/5 | 0/5 | 3/5 | 28% | 5 (11) | 0 |

**Why: the Topics followed the language.** No Topic of any vector held both English and Chinese Documents. Every pair missed because its two Documents were in two Topics of one language each, or one wasn't grouped. ADR-0009 found the same bias in search: the built-in model favours Documents in the Question's language.

**Names weren't the cause.** Of the 130 pairs of "维基百科-…" Documents on different subjects, 54 shared a Topic with names included and 54 with name-free embeddings: they were together for being Chinese, not for their prefix.
