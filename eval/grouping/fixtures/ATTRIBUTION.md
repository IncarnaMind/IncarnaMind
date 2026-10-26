# Grouping fixtures: sources and licences

These files were made for the grouping check, removed on 2026-10-10 (`eval/grouping/README.md`), beside the evaluation's existing Documents: the seven sample PDFs in `data/` (made for this repository and licensed under Apache-2.0; see `data/README.md`), the five Chinese Wikipedia PDFs in `eval/retrieval/fixtures/` and the two tea examples in `resources/examples/`. Each file's subject and language are listed in `eval/grouping/set.json`, which the local classification comparison (`eval/classification/`) reads.

Everything here was made or downloaded on 2026-10-07 and 2026-10-08.

## Wikipedia excerpts (CC BY-SA 4.0)

The text is © Wikipedia contributors, licensed under [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/). If you redistribute these files, keep this attribution and the same licence.

**Changes:** each file is an excerpt: the introduction and the first sections, at most about 7,000 characters in English and 2,600 in Chinese, as plain text read through the MediaWiki API's TextExtracts. References, images, tables, formulas and the sections "See also" and "References" (参见, 参考文献…) are left out, so a few sentences stop where an inline formula was. The section headings are written as Markdown headings under a first heading with the article's name. The Chinese text was converted to simplified script by Wikipedia's own converter (`variant=zh-cn`); the articles 气候变化 and 药品 are titled 氣候變化 and 藥品 on the site.

| File | Article | Revision | Revision date |
|---|---|---|---|
| Earthquake · Wikipedia.md | [Earthquake](https://en.wikipedia.org/wiki/Earthquake) | [1378213144](https://en.wikipedia.org/w/index.php?oldid=1378213144) | 2026-10-03 |
| Climate change · Wikipedia.md | [Climate change](https://en.wikipedia.org/wiki/Climate_change) | [1377826917](https://en.wikipedia.org/w/index.php?oldid=1377826917) | 2026-10-01 |
| Mars · Wikipedia.md | [Mars](https://en.wikipedia.org/wiki/Mars) | [1375821898](https://en.wikipedia.org/w/index.php?oldid=1375821898) | 2026-09-20 |
| Photosynthesis · Wikipedia.md | [Photosynthesis](https://en.wikipedia.org/wiki/Photosynthesis) | [1371284103](https://en.wikipedia.org/w/index.php?oldid=1371284103) | 2026-08-25 |
| Inflation · Wikipedia.md | [Inflation](https://en.wikipedia.org/wiki/Inflation) | [1377062796](https://en.wikipedia.org/w/index.php?oldid=1377062796) | 2026-09-27 |
| 维基百科-地震.md | [地震](https://zh.wikipedia.org/wiki/%E5%9C%B0%E9%9C%87) | [91053040](https://zh.wikipedia.org/w/index.php?oldid=91053040) | 2026-01-10 |
| 维基百科-气候变化.md | [氣候變化](https://zh.wikipedia.org/wiki/%E6%B0%A3%E5%80%99%E8%AE%8A%E5%8C%96) | [94727141](https://zh.wikipedia.org/w/index.php?oldid=94727141) | 2026-10-03 |
| 维基百科-火星.md | [火星](https://zh.wikipedia.org/wiki/%E7%81%AB%E6%98%9F) | [94500484](https://zh.wikipedia.org/w/index.php?oldid=94500484) | 2026-09-22 |
| 维基百科-光合作用.md | [光合作用](https://zh.wikipedia.org/wiki/%E5%85%89%E5%90%88%E4%BD%9C%E7%94%A8) | [94770718](https://zh.wikipedia.org/w/index.php?oldid=94770718) | 2026-10-05 |
| 维基百科-通货膨胀.md | [通货膨胀](https://zh.wikipedia.org/wiki/%E9%80%9A%E8%B4%A7%E8%86%A8%E8%83%80) | [94657299](https://zh.wikipedia.org/w/index.php?oldid=94657299) | 2026-09-30 |
| Stochastic gradient descent · Wikipedia.md | [Stochastic gradient descent](https://en.wikipedia.org/wiki/Stochastic_gradient_descent) | [1376343264](https://en.wikipedia.org/w/index.php?oldid=1376343264) | 2026-09-23 |
| Socially responsible investing · Wikipedia.md | [Socially responsible investing](https://en.wikipedia.org/wiki/Socially_responsible_investing) | [1376158461](https://en.wikipedia.org/w/index.php?oldid=1376158461) | 2026-09-22 |
| Pharmaceutical marketing · Wikipedia.md | [Pharmaceutical marketing](https://en.wikipedia.org/wiki/Pharmaceutical_marketing) | [1376965298](https://en.wikipedia.org/w/index.php?oldid=1376965298) | 2026-09-27 |
| Green tea · Wikipedia.md | [Green tea](https://en.wikipedia.org/wiki/Green_tea) | [1376987353](https://en.wikipedia.org/w/index.php?oldid=1376987353) | 2026-09-27 |
| Chlorophyll · Wikipedia.md | [Chlorophyll](https://en.wikipedia.org/wiki/Chlorophyll) | [1376154661](https://en.wikipedia.org/w/index.php?oldid=1376154661) | 2026-09-22 |
| Consumer price index · Wikipedia.md | [Consumer price index](https://en.wikipedia.org/wiki/Consumer_price_index) | [1376660670](https://en.wikipedia.org/w/index.php?oldid=1376660670) | 2026-09-25 |
| 维基百科-Transformer架构.md | [Transformer架构](https://zh.wikipedia.org/wiki/Transformer%E6%9E%B6%E6%9E%84) | [93692639](https://zh.wikipedia.org/w/index.php?oldid=93692639) | 2026-07-29 |
| 维基百科-GPT-3.md | [GPT-3](https://zh.wikipedia.org/wiki/GPT-3) | [92990431](https://zh.wikipedia.org/w/index.php?oldid=92990431) | 2026-06-08 |
| 维基百科-千年发展目标.md | [千年发展目标](https://zh.wikipedia.org/wiki/%E5%8D%83%E5%B9%B4%E5%8F%91%E5%B1%95%E7%9B%AE%E6%A0%87) | [94811585](https://zh.wikipedia.org/w/index.php?oldid=94811585) | 2026-10-07 |
| 维基百科-药品.md | [藥品](https://zh.wikipedia.org/wiki/%E8%97%A5%E5%93%81) | [94256931](https://zh.wikipedia.org/w/index.php?oldid=94256931) | 2026-09-09 |
| 维基百科-地震学.md | [地震学](https://zh.wikipedia.org/wiki/%E5%9C%B0%E9%9C%87%E5%AD%A6) | [89817123](https://zh.wikipedia.org/w/index.php?oldid=89817123) | 2025-11-05 |
| 维基百科-温室气体.md | [温室气体](https://zh.wikipedia.org/wiki/%E6%B8%A9%E5%AE%A4%E6%B0%94%E4%BD%93) | [94735125](https://zh.wikipedia.org/w/index.php?oldid=94735125) | 2026-10-03 |
| 维基百科-火星探测.md | [火星探测](https://zh.wikipedia.org/wiki/%E7%81%AB%E6%98%9F%E6%8E%A2%E6%B5%8B) | [94737114](https://zh.wikipedia.org/w/index.php?oldid=94737114) | 2026-10-03 |

The Chinese files are named like the retrieval fixtures ("维基百科-…"), so the shared-prefix row has seventeen Documents on eleven subjects.

## Decks (CC BY-SA 4.0)

Six short decks, written for the grouping check and generated with python-pptx 1.0.2 from its default template. Their facts come from the Wikipedia articles on the same subjects (Transformer, Tea processing, Environmental, social, and governance, Photosynthesis, Gradient descent, Sustainable Development Goals, in English and Chinese), so they are shared under the same licence, CC BY-SA 4.0. Some slides have speaker notes.

| File | Language | Subject |
|---|---|---|
| Transformer architecture.pptx | English | Attention and the Transformer |
| 茶叶加工流程.pptx | Chinese | Tea |
| ESG reporting basics.pptx | English | ESG |
| 光合作用课件.pptx | Chinese | Photosynthesis |
| 梯度下降法讲义.pptx | Chinese | Gradient descent |
| SDGs overview.pptx | English | The UN and the SDGs |

## Spreadsheets (public domain, US government data)

Works of the US federal government are in the public domain in the United States. Each sheet was generated with openpyxl 3.1.5 (or written as CSV) from the source below, with a title row and a source line added; nothing else was changed except as noted.

| File | Source | Changes |
|---|---|---|
| usgs_significant_quakes_2023.csv | U.S. Geological Survey, [ComCat earthquake catalog](https://earthquake.usgs.gov/fdsnws/event/1/): every earthquake of magnitude 7 or more in 2023 (19). | Only the columns time, latitude, longitude, depth, magnitude, magnitude type and place, renamed. |
| co2_annmean_mlo.xlsx | NOAA Global Monitoring Laboratory, [Mauna Loa CO₂ annual mean](https://gml.noaa.gov/ccgg/trends/) (`co2_annmean_mlo.csv`, file of 2026-09-05). Dr. Xin Lan, NOAA/GML. | Years 1975 to 2025 only: the file's earlier years come from the Scripps Institution of Oceanography. An "increase on previous year" column, computed. |
| Mars fact sheet (NASA).xlsx | NASA Space Science Data Coordinated Archive, [Mars Fact Sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html) by Dr. David R. Williams: the bulk and orbital parameter tables. | Superscripts written with "^". |
| CPI-U 2015-2024.xlsx | U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban Consumers, series CUUR0000SA0, through the [BLS public data API](https://www.bls.gov/developers/). | One row per year; the annual average and the December-to-December change are computed from the monthly values. |
