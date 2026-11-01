# Every-format fixtures: source and licence

The files in `files/` were written for IncarnaMind's evaluation (#70): all by `make-fixtures.py` but the two WebVTT Transcripts and the six Web pages, written by hand. All their text is synthetic, written for this project: no third-party text is reproduced. People, places, companies, institutions, products and figures are fictional, and no contact details appear. They are released under the repository's Apache-2.0 licence.

| Format | Written with |
|---|---|
| Word | python-docx 1.2.0: comments with its own call, footnotes added as a footnotes part |
| PowerPoint | python-pptx 1.0.2: charts with their cached values, and the workbook PowerPoint keeps beside each chart (XlsxWriter 3.2.9) |
| Excel | openpyxl 3.1.5 |
| CSV, Markdown, plain text | written as UTF-8 text |
| WebVTT Transcripts (#136) | written by hand as UTF-8 WebVTT, one cue per line said, each with its speaker |
| Web pages (#155) | written by hand as UTF-8 HTML in `files/web/`: four short pages with a heading-led section, a table and a list each, and two article-length pages with header, navigation and footer, in English and Chinese |
| PDF | reportlab 5.0.1 in its invariant mode: Helvetica for Latin text, reportlab's built-in STSong-Light CID font for Chinese (not embedded; pdf.js maps it with its CMaps), figures drawn by reportlab |

With the same library versions, `make-fixtures.py` writes the same bytes again: fixed document dates, fixed ZIP timestamps (also inside the workbooks charts embed) and reportlab's invariant mode.

The set also asks about files already in the repository:

- `tests/fixtures/formats/`: Coastal Flood Risk Review.docx, Quarterly Research Update.pptx, Regional Revenue.xlsx and Orders.csv. Synthetic, written by the office-formats spike's generator with docx 9.9.0, pptxgenjs 4.0.1 and exceljs 4.4.0 (see `tests/core/formats.test.ts`). Other libraries than the ones above, so each format is read from more than one writer.
- `tests/fixtures/organize/files/`: IMG_2201.pdf, scan_0042.pdf, IMG_3307.pdf and IMG_4410.pdf, image-only scans of synthetic text (see `tests/fixtures/organize/ATTRIBUTION.md`).
