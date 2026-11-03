# Checks evaluation: sources and licences

Every Document the checks evaluation uses is synthetic, written for IncarnaMind's evaluations, or freely licensed. None holds personal data: the people, companies, places and figures in the synthetic Documents are invented, and none has contact details.

## Written for this set

The ten documents to verify (`received/`) and the two web pages (`web/`) were written for this set (#86) by `make-fixtures.py`, which writes the same bytes each time with the same library versions. They are synthetic and released under the repository's Apache-2.0 licence. The web pages are saved under `example.org` addresses from their HTML; nothing is fetched.

| Document | Format | Language | What it stands for |
|---|---|---|---|
| Hartley Building progress report 3.pdf | PDF | English | A contractor's progress report |
| Harbour Roasters press release draft.docx | Word | English | A PR agency's draft press release |
| Meridian Health Staffing proposal.pdf | PDF | English | A staffing agency's proposal |
| Cityride September 2026 operator report.pptx | PowerPoint | English | An operator's monthly report |
| Northgate Advisory memo on the heat study.docx | Word | English | A consultant's memo |
| 禾丰餐饮运营情况说明.docx | Word | Chinese | A caterer's memo to the client |
| 江城公交第三季度新闻稿.pdf | PDF | Chinese | A news agency's press release |
| 浙北乳品季度对账说明.pdf | PDF | Chinese | A supplier's statement |
| 江城晚报绿地降温报道.docx | Word | Chinese | A newspaper report |
| 冷链仓库第三方巡检报告.pdf | PDF | Chinese | A third party's inspection report |
| web/riverside-roof-contract.html | Web page | English | A council's news page |
| web/jiangcheng-n3-night-line.html | Web page | Chinese | A bus company's news page |

## Reused from the repository

| Documents | Source | Licence |
|---|---|---|
| The every-format set's 16 files in `eval/retrieval/formats/files/` (Word, PowerPoint, Excel, CSV, Markdown, plain text, PDF, WebVTT) | Synthetic, written for the every-format evaluation (#70); see `eval/retrieval/formats/ATTRIBUTION.md` | Apache-2.0 |
| `tests/fixtures/formats/Quarterly Research Update.pptx` and `Regional Revenue.xlsx` | Synthetic, written by the office-formats spike's generator; see `eval/retrieval/formats/ATTRIBUTION.md` | Apache-2.0 |
| `eval/retrieval/fixtures/维基百科-可持续发展目标.pdf` | The Chinese Wikipedia article [可持续发展目标](https://zh.wikipedia.org/w/index.php?oldid=94740074), revision 94740074, rendered by Wikimedia's PDF service; see `eval/retrieval/fixtures/ATTRIBUTION.md` | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), © Wikipedia contributors |

The seven sample PDFs in `data/` aren't used here: they were made for this repository on
2026-10-26, each in a fictional organisation's voice. They are licensed under Apache-2.0, like the rest of the repository (`data/README.md`).
