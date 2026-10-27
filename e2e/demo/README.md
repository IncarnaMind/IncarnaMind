# The README recorder

`npm run demo:record` films the built app, once in English and once in Chinese, and cuts the
README's eight feature pictures from the same take. See `readmeDemo.demo.ts` for the environment
variables, `sceneTable.ts` for what each scene shows, and `stills.ts` for the pictures' size.

## Its test Documents

Every file here is written by the recorder, invented for the recording, and never committed:
no company, person, figure or publisher's text is real. They are built as the shipped examples
are (`resources/examples`, `data/README.md`):

| File | Format | What it is for |
|---|---|---|
| `Northwind Retail · monthly sales 2025–2026.xlsx` | Excel | A `Sales` sheet of 288 monthly rows by region and channel, a `2026 by region` summary whose figures are those rows' own sums, and an `About` sheet saying so. The Analysis scene checks the summary against the rows, then the Note gets a cited table and a bar chart of it. |
| `Northwind Retail · expert interview guide.docx` | Word | The interview's guide, with the three topics the call is meant to cover (store traffic, supplier terms, pricing). Call help's Not covered yet cites the topics the talk missed. |
| `Northwind Retail · interview background.pptx` | PowerPoint | One slide of background on the fictional retailer, so the linked folders hold the four formats the README names. It repeats no guide topic, so the guide is the one Document Not covered yet cites. |
| `Callaway / Brackwater / Aldermoor Bank · term sheet.pdf` | PDF | Three fictional lenders' term sheets (`documents.ts`), compared in one table with every cell cited. |

The workbook, the guide and the deck arrive in a second linked folder (`Downloads`); the term
sheets arrive in a synced drive's `Lender documents`. Both are real folders under a temporary
`sources` folder, linked through the core's bridge before the first frame, as a User who had
linked them would have them.

`tests/demo/readmeFixtures.test.ts` reads every file as its format, checks the summary is the
monthly rows' sums, and checks the guide names its topics. It needs no model.
