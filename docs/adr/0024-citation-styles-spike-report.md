# Citation-style engine spike (#288): report

The evidence behind [ADR-0016](0016-citation-styles-hayagriva-in-wasm.md). The question: can IncarnaMind format Citations and a Bibliography in CSL styles (#289) with an engine that fits the dependency rule in `AGENTS.md` (open source, permissive, maintained, small)? The JavaScript CSL processors don't fit it: citeproc-js is CPAL-1.0 or AGPL-3.0, and citeproc-rs is MPL-2.0 and archived. Hayagriva, the CSL engine in Typst, is MIT or Apache-2.0 but has no official wasm or npm build.

## Summary

- **Hayagriva builds to wasm.** Nothing had to be patched. A binding of about 240 lines of Rust (`spikes/288-csl-engine/binding`) takes a CSL style and CSL locales as XML and references as CSL JSON. It returns the citations and the bibliography as formatted runs, as plain text, or as Hayagriva's HTML.
- **Size:** 2,485,275 bytes of wasm (2.37 MiB) after `wasm-opt -Oz`, 789,410 bytes gzipped (771 KiB) and 573,638 with Brotli, plus 11,676 bytes of JavaScript glue. Almost half of the module (1.16 MB) is ICU4X data, which Hayagriva uses to sort Chinese by pinyin.
- **Speed, on one machine** (Apple M2 Max, Node 26.11.1, other work running): formatting the 30 references (34 citations and the bibliography) takes 38–132 ms cold in a new process, 27 ms warm for APA, 3–6 ms for the numeric and GB/T styles, and 69 ms for Chicago notes, the slowest style. Like for like, that is 1.4 to 2.1 times faster than citeproc-js cold, and 1.1 to 2.9 times faster warm. At 300 references APA takes 0.34 s and Chicago notes 0.75 s, so #289 should format in a worker, not on every keystroke.
- **Against citeproc-js as Zotero ships it,** across 11 styles: 338 of 374 citations (90%) and 269 of 330 bibliography entries (82%) are identical, with 7 more that differ only in spaces. Every difference is listed below. Fifteen kinds of difference account for all of them, and most are Hayagriva bugs that can be fixed upstream. The released 0.10.1 drops the authors in Vancouver. Its `main` branch, pinned here, fixes that.
- **Licences:** 73 crates in the build, 58 of them linked into the wasm. All are permissive (MIT, Apache-2.0, Unicode-3.0, BSL-1.0, Unlicense, 0BSD/CC0). Nothing is copyleft. The CSL styles and locales are CC BY-SA 3.0. Shipped unmodified next to our code, they form a "Collection" under the licence, so share-alike covers the style files and not IncarnaMind's code.
- **Recommendation: (A) Hayagriva in wasm,** behind an interface of our own. Accepted on 2026-10-11 as ADR-0016. Bugs get fixed upstream. A few gaps are left for the binding to bridge in #289, none of them built yet: no italics on Chinese text (the comparison above still shows them), English entries in GB/T styles rendered in English, and Zotero's rich text. See ADR-0016.

## What was built

| Piece | Version | Licence |
|---|---|---|
| Hayagriva | `main` at [`546c7c7`](https://github.com/typst/hayagriva/commit/546c7c721bbb5539f96ce458df5d4bb3f97c11e9) (2026-09-26; crate version still 0.10.1), also 0.10.1 from crates.io for comparison | MIT OR Apache-2.0 |
| Features | `default-features = false`, `csl-json`: no BibLaTeX parser, no bundled style archive | |
| Rust | stable 1.99.0, target `wasm32-unknown-unknown`, `opt-level = "s"`, LTO, one codegen unit, `panic = "abort"` | MIT OR Apache-2.0 |
| wasm-bindgen | 0.2.129 (crate and CLI), targets `nodejs` and `web` | MIT OR Apache-2.0 |
| wasm-opt | binaryen 132 (npm `binaryen`), `-Oz` | Apache-2.0 |

The toolchain was installed into a temporary folder: rustup with `--no-modify-path`, and `RUSTUP_HOME` and `CARGO_HOME` set there. No shell profile or global configuration was touched. `spikes/288-csl-engine/setup.sh` repeats this from scratch. The first `cargo build --target wasm32-unknown-unknown` succeeded. Hayagriva and its dependencies (quick-xml, ICU4X, url, serde) are pure Rust with no C code and nothing platform-specific, so nothing stood in the way.

The binding's interface, as JavaScript sees it:

```ts
const engine = new CslEngine(styleXml, [enUsXml, enGbXml, zhCnXml]); // parse once per style
const json = engine.render(referencesCslJson, citationsJson, "runs" | "text" | "html", locale?);
// → { citations: [...], bibliography: [{ id, firstField, text }], hangingIndent }
```

A citation is `{ items: [{ id, locator?, label? }], noteIndex? }`. The `runs` output is a list of `{ text, italic?, bold?, smallCaps?, underline?, script?: "sup" | "sub", link? }`. The editor and Word export can build their own nodes from it, with no markup to parse (see S4). A dependent style is refused; the app resolves it to its parent.

## Method

**References.** There are 30, written as CSL JSON (`tests/fixtures/citation-styles/references.json`, moved there by #289): 16 English and 14 Chinese. They include journal articles (1, 2, 3, 4 and 34 authors, diacritics such as Žídek and Łukasz, a particle in "van der Maaten", a romanised Chinese name with a hyphen), books (an edition with an original date, a translated book, institutional authors, two books by the OECD in one year), chapters in edited books, theses, conference papers, web pages (one with no date), reports, two standards (ISO 690:2021 and GB/T 7714—2015), two laws (the GDPR and the PRC Personal Information Protection Law), a newspaper article and an article with no author. Chinese names are family name first (`{"family": "钱", "given": "学森"}`). Several references lack a publisher, a place, a date or an author. Some of the Chinese ones are the examples printed in GB/T 7714—2015.

**Citations.** There are 34 (`tests/fixtures/citation-styles/citations.json`). Each reference is cited once in order, seven of them with a page locator. Then come a cite of three works (English and Chinese together), two later cites of one book (to test short notes and ibid), and a cite of the two OECD books (year suffixes and cite collapsing). Every citation carries a footnote number, which only note styles use.

**Oracle.** Zotero formats with citeproc-js. The owner's Zotero was not run. In its place is the `citeproc.js` that Zotero itself ships, taken from Zotero's repository at commit [`08880f7`](https://github.com/zotero/zotero/blob/08880f7a0e51021cc13b6aff248fdcbc96234c91/chrome/content/zotero/xpcom/citeproc.js) (processor version 1.4.61, the last change to that file, 2026-07-30). It ran in a temporary folder and was never added to this repository. It was set up as Zotero's [`Style.getCiteProc`](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/style.js) sets it up: locale `en-US` with the style's `default-locale` winning, `wrap_url_and_doi` on, `parse_names` off, and `uppercase_subtitles` for APA. Citations came from `rebuildProcessorState`, with `noteIndex` 0 for in-text styles. What this stand-in can't show is Zotero's own conversion of its items to CSL JSON, and anything its word-processor plugins add.

**Styles.** From [citation-style-language/styles](https://github.com/citation-style-language/styles) at `f2c83bb` (2026-10-09), unmodified. Locales `en-US`, `en-GB` and `zh-CN` came from [citation-style-language/locales](https://github.com/citation-style-language/locales) at `a89adec` (2026-09-10).

| Style asked for | CSL file | Title in the file |
|---|---|---|
| APA 7 | `apa.csl` | APA Style 7th edition |
| MLA 9 | `modern-language-association.csl` | MLA Handbook 9th edition (in-text citations) |
| Chicago, notes | `chicago-notes-bibliography.csl` | Chicago Manual of Style 18th edition (notes and bibliography) |
| Chicago, author-date | `chicago-author-date.csl` | Chicago Manual of Style 18th edition (author-date) |
| IEEE | `ieee.csl` | IEEE Reference Guide version 11.29.2023 |
| Vancouver | `nlm-citation-sequence.csl` | NLM/Vancouver: Citing Medicine 2nd edition (citation-sequence); the repository renamed `vancouver.csl` to this |
| Harvard | `harvard-cite-them-right.csl` | Cite Them Right 12th edition (author-date/Harvard), the common UK Harvard |
| GB/T 7714—2015 | `china-national-standard-gb-t-7714-2015-numeric.csl`, `…-2015-author-date.csl` | China National Standard GB/T 7714-2015 (numeric / author-date, 中文) |
| GB/T 7714—2025 | `china-national-standard-gb-t-7714-2025-numeric.csl`, `…-2025-author-date.csl` | China National Standard GB/T 7714-2025 (numeric / author-date, 中文), added to the repository in May 2026 |

**Comparison.** Both engines formatted every style in plain text and in HTML. A citation or entry counts as the same when the trimmed strings are equal. "Whitespace only" means equal after runs of spaces are collapsed. Formatting was compared by reducing both HTML outputs to italic, bold, small caps, superscript and subscript. A formatting difference is counted only where the text is the same. Bibliography entries are matched by reference, and their order is compared separately. `harness/compare.mjs` writes the full list to `spikes/288-csl-engine/results/details.md`.

## Results by style

Hayagriva `main` (`546c7c7`) against citeproc-js 1.4.61 as Zotero ships it. The D numbers are the kinds of difference described in the next section.

| Style | Citations the same (of 34) | Bibliography entries the same (of 30) | Bibliography order | Same text, different formatting | What differs |
|---|---|---|---|---|---|
| APA 7th | 32 | 24 | same | 0 | D1, D2, D4, D5, D8 (2 entries), D9, D14 |
| MLA 9th | 33 | 23 | 1 entry moves (D15) | 8 (D3) | D1 (1 citation, 4 entries), D4, D5, D7 |
| Chicago 18th, notes and bibliography | 28 | 24 | 1 entry moves (D15) | 13 (D3) | D1 (4 notes, 4 entries), D4 (1 note, 1 entry), D5, D10 |
| Chicago 18th, author-date | 32 | 24 | 1 entry moves (D15) | 6 (D3) | D1 (1 citation, 4 entries), D2, D4, D5 |
| IEEE | 34 | 22, and 7 more that differ only in spaces (D13) | same | 8 (D3) | D4 |
| Vancouver (NLM) | 34 | 19 | same | 0 | D12 (10 entries), D4 |
| Harvard (Cite Them Right 12th) | 33 | 27 | same | 9 (D3) | D2, D4, D10, D11 |
| GB/T 7714—2015 numeric | 34 | 28 | same | 0 | D4, D7 |
| GB/T 7714—2015 author-date | 22 | 28 | same | 0 | D6a (11 citations), D2, D4, D7 |
| GB/T 7714—2025 numeric | 34 | 25 | same | 0 | D6b (3 entries), D4, D7 |
| GB/T 7714—2025 author-date | 22 | 25 | same | 0 | D6a (11 citations), D6b (3 entries), D2, D4, D7 |
| **All 11** | **338 of 374 (90%)** | **269 of 330 (82%)** | 3 styles move 1 entry | | |

Hayagriva 0.10.1, the latest release, gives the same numbers except for Vancouver: 1 of 30 entries, because it drops every author and editor ([typst/hayagriva#519](https://github.com/typst/hayagriva/issues/519), fixed on `main` by [#520](https://github.com/typst/hayagriva/pull/520) after the release).

Both engines agree on the hard parts that matter most here. They agree on Chinese names in Chinese order without a space (钱学森), and on APA's 20-author rule with the ellipsis. So do the et al. rules (GB/T lists three names before 等, Vancouver six, Chicago three when there are seven or more). Short notes for repeated cites agree, and so do the numbering and the collapsing of numeric citations (`[2,4,18]`). Pinyin order for the Chinese entries in the GB/T author-date styles (昂温, 白, 丁, 费, 贾, 刘, 钱 …) is identical too. Under the English styles both sort Chinese by code point.

## The differences, one by one

Each kind is described with an example (citeproc-js first, then Hayagriva), the styles it affects, and a verdict against the [CSL 1.0.2 specification](https://docs.citationstyles.org/en/stable/specification.html).

- **D1. Title case lowercases words with inner capitals.** "ChatGPT" becomes "Chatgpt", "AlphaFold" becomes "Alphafold" and "t-SNE" becomes "t-Sne" (citeproc-js: "T-SNE"). The website name "CitationStyles.org" becomes "Citationstyles.org" (citeproc-js: "CitationStyles.Org"). Affects MLA and both Chicago styles, and APA where it cites a work with no author by its title. The specification says title case leaves "words in mixed or uppercase" as they are, and treats hyphenated parts as separate words, so "T-SNE" is correct. *Hayagriva bug.* Related: [#380](https://github.com/typst/hayagriva/issues/380). It matters for papers about ChatGPT, iPhone or COVID-19.
- **D2. Collapsed year suffixes get the wrong delimiter:** "(OECD, 2019a, 2019b)" against "(OECD, 2019a; 2019b)". Affects APA, Chicago author-date, Harvard, and both GB/T author-date styles. `cite-group-delimiter` defaults to ", ". *Hayagriva bug.*
- **D3. Italics on Chinese text.** Hayagriva italicises Chinese journal and book titles (*计算机研究与发展*). Zotero's citeproc-js leaves Chinese text upright, as Chinese typography does. Affects every style that italicises titles: MLA, Chicago, IEEE and Harvard, 6 to 13 citations and entries per style. The specification is silent on this. *Fix in the binding:* drop italics on Chinese runs, as citeproc-js does.
- **D4. A Chinese family name with Latin initials** (the translated authors 昂温 G and 昂温 P S). citeproc-js gives "昂温 G., 昂温 P. S." in APA and "昂温 G, 昂温 P S" in GB/T, which is the example printed in GB/T 7714—2015. Hayagriva treats the whole name as Chinese: "昂温G, 昂温P S". Affects all 11 styles, one reference. *Hayagriva bug.*
- **D5. Two institutional authors:** "国家质量监督检验检疫总局 & 中国国家标准化管理委员会" against "…总局, & 中国…" (and "and" in MLA and Chicago). Hayagriva applies `delimiter-precedes-last` to institutions as it does to people, and citeproc-js doesn't. The specification doesn't distinguish the two, but Zotero's output reads as expected. Affects APA, MLA and both Chicago styles.
- **D6. Space before 等 (et al.).** (a) GB/T author-date citations: "(Kahneman等, 1979)" against "(Kahneman 等, 1979)". The style's own comment says GB/T 7714 §10.2.2 requires a gap between the surname and "等". Hayagriva renders what the style says, and citeproc-js removes the space before a Chinese term. Hayagriva may be closer to the standard here; a Chinese reader should check this against the standard's text. (b) GB/T 2025 bibliography: "林衍凯，等" against "林衍凯， 等". Hayagriva puts a space after a full-width comma, which is wrong in Chinese typography. *Hayagriva bug.*
- **D7. A volume of "L 119"** (the GDPR's Official Journal issue). Hayagriva treats it as a number and adds the label: "vol. L 119" in MLA, "卷 L 119" in GB/T. citeproc-js doesn't. The specification's `is-numeric` allows prefixes ("L2d") but not a prefix with a space. *Minor Hayagriva bug.* Related: [#439](https://github.com/typst/hayagriva/issues/439) (第1卷).
- **D8. `capitalize-first` is skipped for Chinese references:** APA prints "(ed.)" and "trans." instead of "(Ed.)" and "Trans." for Chinese entries. Only title case is limited to English in the specification, so capitalize-first should still apply. *Hayagriva bug.*
- **D9. APA drops the pages and publisher of a conference paper in proceedings with an editor:** "In 中国图书馆学会 (Ed.), 中国图书馆学会年会论文集：2011年卷 (pp. 45–52). 国家图书馆出版社." becomes "In 中国图书馆学会 (ed.), 中国图书馆学会年会论文集：2011年卷." Side check S2 shows the same for an English paper. *Hayagriva bug.* It matters for theses that cite proceedings.
- **D10. Punctuation inside quotation marks** (`punctuation-in-quote` in en-US) is missed in two places. Chicago notes ends a cite of three works with “知识表示学习研究进展”. instead of “知识表示学习研究进展.”, and Harvard gives "…for their use”," instead of "…for their use,”". *Minor Hayagriva bug.*
- **D11. Harvard prints "in" before the proceedings of a paper with no editor.** The group that holds "in" and the editors should disappear, because every variable it calls is empty (specification, `cs:group`). *Hayagriva bug.*
- **D12. Vancouver**, on `main`: (a) a stray space, "1979 Mar ;47(2):263–91", in 5 entries; (b) "pp. 5998–6008" where the style asks for `plural="never"`, so "p. 5998–6008", in 5 entries; (c) editors come out as "In: , editorsKahneman D, Slovic P, Tversky A." in 3 entries, with the label put before the names because the style's `cs:names` has no `cs:name`, which is the rest of #519. *Hayagriva bugs.*
- **D13. IEEE double spaces:** "[Online].  Available:", "Curran Associates,  2017". Whitespace only, 7 entries. *Minor Hayagriva bug.*
- **D14. Em dash spacing in a title:** citeproc-js turns "Information and documentation — Guidelines" into "documentation—Guidelines" in APA, while Hayagriva keeps the title as entered. APA prefers the closed dash, but changing the data is debatable. One entry.
- **D15. Bibliography order:** in MLA and both Chicago styles, the article with no author, sorted by its title in quotation marks, comes first in Hayagriva and under "T" in Zotero. Hayagriva seems to sort on the quotation mark. *Hayagriva bug.*

Both engines share one limitation that matters for Chinese users. The official GB/T styles give "等" and "4 版" for **English** references too (*JUMPER J, EVANS R, PRITZEL A, 等* and *KUHN T S. … 4 版*), where GB/T 7714 wants "et al." and "4th ed.". The styles fix this only with a CSL-M layout that ships commented out (S5).

## Side checks outside the table

Run by `harness/side-checks.mjs`. The output is in `results/side-checks.txt`.

- **S1. Year suffixes follow citation order.** When the later title (PISA) is cited first, Hayagriva gives PISA "2019a", and the bibliography lists 2019b before 2019a. The specification says "the assignment of year-suffixes follows the order of the bibliographies entries". citeproc-js does that. *Hayagriva bug,* visible to any APA user who cites two works by one author from one year out of alphabetical order.
- **S2. Conference papers with editors** lose pages and publisher in English too (D9).
- **S3. Rich text in fields.** Zotero writes `<i>`, `<sub>`, `<sup>`, `<b>` and `<span class="nocase">` into titles in its CSL JSON. citeproc-js renders them. Hayagriva's CSL JSON path doesn't parse them. The tags come out as text and title case changes them: "Growth of <i>escherichia Coli</i> at 37 °c and the Co<sub>2</sub> Effect". It also lowercases the unit in "37 °C". #287 imports references from Zotero, so this has to be handled before the import ships. The options are to convert the markup in the binding (Hayagriva has its own rich-text type for its YAML format, but its CSL JSON path doesn't use it) or to contribute the parsing upstream.
- **S4. Hayagriva's HTML is not escaped.** A title containing `<img src=x onerror=alert(1)>` comes out as a live tag, and so would a URL with a quotation mark, inside `href="…"`. citeproc-js escapes both. Reference metadata comes from PDFs, DOI lookups and imports, so it is untrusted. The binding therefore returns runs, which are text plus formatting flags, and the app never uses Hayagriva's HTML. The same input as runs is `{"text":"Cats & dogs <img src=x onerror=alert(1)>"}`, plain text.
- **S5. CSL-M.** The GB/T 7714—2015 styles carry, commented out, a CSL-M layout (`<layout locale="en">`) that formats English entries with English terms. With it uncommented, citeproc-js gives "JUMPER J, EVANS R, PRITZEL A, et al." and "4th ed.". Hayagriva refuses the style ("Deserialization error occured at `bibliography`"). Typst's maintainers have said they have no capacity for CSL-M ([#460](https://github.com/typst/hayagriva/issues/460)). The 2025 styles have no CSL-M at all, only `<locale xml:lang="en">` terms. **A workaround, tested in the harness and not yet in the binding:** `side-checks.mjs` asks the binding for the bibliography twice, in the style's locale and in `en-US`, and keeps each entry in its reference's language. On the three references of this side check (two English, one Chinese), the result matches citeproc-js's CSL-M output exactly. #289 would move this into the binding, and citations could do the same through Hayagriva's per-item locale.

## Size

| Build | Raw (bytes) | gzip -9 | Brotli 11 |
|---|---|---|---|
| `cargo build`, opt-level s, LTO (before wasm-bindgen) | 2,759,305 | 735,058 | 548,864 |
| After wasm-bindgen | 2,631,816 | 741,961 | 541,336 |
| **After `wasm-opt -Oz` (recommended)** | **2,485,275** | **789,410** | **573,638** |
| opt-level 3 and `wasm-opt -O3` (faster, see below) | 2,559,813 | 844,940 | 621,010 |
| Hayagriva 0.10.1, `-Oz` | 2,482,013 | 788,128 | 579,247 |
| JavaScript glue (`--target web`) | 11,676 | 3,056 | |

Of the optimised module, 1.32 MB is code and 1.16 MB is data. Most of the data is ICU4X's compiled collation, normalisation and locale data, which Hayagriva uses for pinyin sorting. The data could shrink to the `zh` and `en` collations with a custom ICU4X data provider, but that needs a change in Hayagriva. Turning on Hayagriva's `archive` feature (about 100 bundled styles and 60 locales as CBOR, 3.4 MB on disk) adds nothing unless the binding calls it; we don't need it. `wasm-opt -Oz` makes the file smaller but the gzipped file larger. Installers compress, so either is fine. While running, the wasm memory was 2.9–5.0 MB after formatting the 30 references.

## Speed

One machine: Apple M2 Max (12 cores), 32 GB, macOS 26.5, Node 26.11.1. Other work was running, with a load average of 5 to 11, so treat differences under about 20% as noise. Each number is the median of 9 fresh processes, in milliseconds, for the 30 references, the 34 citations and the bibliography. Hayagriva returns runs and citeproc-js returns HTML. *Cold* is from process start: loading the glue, instantiating the wasm, parsing the style and three locales, and the first format. *Warm* is a later format with the same engine. *Warm, new engine* parses the style again each time, which is how the citeproc-js numbers were taken.

| Style | Hayagriva cold | parse style and locales | first format | Hayagriva warm | Hayagriva warm, new engine | Hayagriva warm, `-O3` build | citeproc-js cold | citeproc-js warm, new engine |
|---|---|---|---|---|---|---|---|---|
| APA 7th | 76 | 27 | 45 | 27.3 | 36.3 | 18.7 | 123 | 43.8 |
| MLA 9th | 55 | 24 | 27 | 8.2 | 13.9 | 6.5 | 116 | 40.0 |
| Chicago notes | 132 | 40 | 87 | 68.5 | 86.8 | 46.8 | 187 | 91.7 |
| Chicago author-date | 94 | 34 | 55 | 37.1 | 51.7 | 25.2 | 155 | 63.2 |
| IEEE | 38 | 22 | 13 | 2.6 | 7.4 | 2.1 | 68 | 13.6 |
| Vancouver | 39 | 21 | 15 | 3.7 | 8.5 | 2.8 | 67 | 14.6 |
| Harvard | 48 | 21 | 24 | 5.8 | 10.4 | 4.6 | 91 | 24.7 |
| GB/T 2015 numeric | 39 | 22 | 14 | 3.1 | 7.7 | 2.3 | 63 | 11.9 |
| GB/T 2015 author-date | 50 | 22 | 25 | 5.9 | 10.7 | 4.6 | 83 | 20.5 |
| GB/T 2025 numeric | 39 | 22 | 13 | 3.0 | 7.9 | 2.2 | 61 | 11.3 |
| GB/T 2025 author-date | 50 | 22 | 23 | 6.0 | 10.9 | 4.6 | 86 | 22.8 |

Instantiating the module takes about 2 ms, because V8 compiles wasm lazily, and that cost lands in the first format. The same code compiled natively (aarch64, also returning runs) takes 23.5 ms warm for APA and 59.8 ms for Chicago notes, so wasm costs about 15% here. The `-O3` build is about 30% faster on the heavy styles for 75 KB more. #289 can choose. At **300 references** (the fixtures ten times over, each cited once), warm: APA 339 ms, Chicago notes 751 ms, GB/T 2015 numeric 31 ms, GB/T 2025 author-date 77 ms. citeproc-js, measured the same way, took 561, 764, 99 and 282 ms. Author-date and note styles grow with disambiguation work, so the editor should format in a worker and update markers when formatting finishes, not on every keystroke.

## Licences

### The engine and everything compiled into it

`cargo metadata` for the wasm target resolves 73 crates. Following only normal dependencies, 58 are linked into the module. The other 15 are procedural macros and their dependencies, which run only at build time. Every licence is permissive and none is copyleft:

| Licence | Crates |
|---|---|
| MIT OR Apache-2.0 | 41 (including hayagriva and citationberg, from Typst; serde; url; wasm-bindgen) |
| Unicode-3.0 | 24 (ICU4X: collation, normalisation, locales and their data; 3 of them build time only) |
| MIT | 4 (quick-xml, libyaml-rs, zmij; synstructure at build time only) |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 (unicode-ident) |
| Apache-2.0 OR BSL-1.0 | 1 (ryu) |
| MIT OR Unlicense | 1 (memchr) |
| 0BSD OR CC0-1.0 | 1 (roman-numerals-rs) |

The Rust standard library compiled into the module is MIT OR Apache-2.0, and so is the glue that wasm-bindgen generates. MIT, BSL-1.0 and Unicode-3.0 ([text](https://www.unicode.org/license.txt)) each ask for their copyright and permission notice to go with copies, so the app's licence notices must list them, as `resources/notices/` already does for the model catalog. Hayagriva and citationberg each have a NOTICE file, and it covers only CC BY-SA styles in their tests and archive, none of which is compiled in. The tools that only run at build time are rustup, rustc and cargo (MIT OR Apache-2.0), wasm-bindgen-cli (MIT OR Apache-2.0), binaryen's wasm-opt (Apache-2.0) and cargo-license (MIT).

The full list, from `harness/licences.mjs` (the hayagriva row is `main` at `546c7c7`, whose crate version is still 0.10.1):

| Crate | Version | Licence | Where |
|---|---|---|---|
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | build time only |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | build time only |
| paste | 1.0.15 | MIT OR Apache-2.0 | build time only |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | build time only |
| quote | 1.0.47 | MIT OR Apache-2.0 | build time only |
| rustversion | 1.0.23 | MIT OR Apache-2.0 | build time only |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | build time only |
| syn | 3.0.7 | MIT OR Apache-2.0 | build time only |
| synstructure | 0.14.0 | MIT | build time only |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | build time only |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 | build time only |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 | build time only |
| yoke-derive | 0.8.4 | Unicode-3.0 | build time only |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | build time only |
| zerovec-derive | 0.11.6 | Unicode-3.0 | build time only |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | in the .wasm |
| citationberg | 0.7.0 | MIT OR Apache-2.0 | in the .wasm |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | in the .wasm |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | in the .wasm |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | in the .wasm |
| hayagriva | 0.10.1 (git `546c7c7`) | MIT OR Apache-2.0 | in the .wasm |
| icu_collator | 2.3.1 | Unicode-3.0 | in the .wasm |
| icu_collator_data | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_collections | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_locale | 2.3.1 | Unicode-3.0 | in the .wasm |
| icu_locale_core | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_locale_data | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_locale_fallback | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_locale_fallback_data | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_normalizer | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_properties | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_properties_data | 2.3.0 | Unicode-3.0 | in the .wasm |
| icu_provider | 2.3.1 | Unicode-3.0 | in the .wasm |
| idna | 1.1.0 | MIT OR Apache-2.0 | in the .wasm |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | in the .wasm |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | in the .wasm |
| itoa | 1.0.18 | MIT OR Apache-2.0 | in the .wasm |
| libyaml-rs | 0.3.0 | MIT | in the .wasm |
| litemap | 0.8.3 | Unicode-3.0 | in the .wasm |
| memchr | 2.8.3 | Unlicense OR MIT | in the .wasm |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | in the .wasm |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | in the .wasm |
| potential_utf | 0.1.6 | Unicode-3.0 | in the .wasm |
| quick-xml | 0.38.4 | MIT | in the .wasm |
| roman-numerals-rs | 3.1.0 | 0BSD OR CC0-1.0 | in the .wasm |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 | in the .wasm |
| serde | 1.0.229 | MIT OR Apache-2.0 | in the .wasm |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | in the .wasm |
| serde_json | 1.0.152 | MIT OR Apache-2.0 | in the .wasm |
| serde_path_to_error | 0.1.20 | MIT OR Apache-2.0 | in the .wasm |
| smallvec | 1.16.3 | MIT OR Apache-2.0 | in the .wasm |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | in the .wasm |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | in the .wasm |
| tinystr | 0.8.4 | Unicode-3.0 | in the .wasm |
| unic-langid | 0.9.6 | MIT OR Apache-2.0 | in the .wasm |
| unic-langid-impl | 0.9.6 | MIT OR Apache-2.0 | in the .wasm |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | in the .wasm |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | in the .wasm |
| unscanny | 0.1.0 | MIT OR Apache-2.0 | in the .wasm |
| url | 2.5.8 | MIT OR Apache-2.0 | in the .wasm |
| utf16_iter | 1.0.5 | Apache-2.0 OR MIT | in the .wasm |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | in the .wasm |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | in the .wasm |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | in the .wasm |
| write16 | 1.0.0 | Apache-2.0 OR MIT | in the .wasm |
| writeable | 0.6.4 | Unicode-3.0 | in the .wasm |
| yaml_serde | 0.10.7 | MIT OR Apache-2.0 | in the .wasm |
| yoke | 0.8.3 | Unicode-3.0 | in the .wasm |
| zerofrom | 0.1.8 | Unicode-3.0 | in the .wasm |
| zerotrie | 0.2.5 | Unicode-3.0 | in the .wasm |
| zerovec | 0.11.8 | Unicode-3.0 | in the .wasm |
| zmij | 1.0.23 | MIT | in the .wasm |

"In the .wasm" means reachable through normal dependencies. LTO then removes code nothing calls, such as Hayagriva's YAML support.

### The CSL styles and locales

Every style in the [styles repository](https://github.com/citation-style-language/styles#licensing) and every [locale file](https://github.com/citation-style-language/locales#licensing) is released under [Creative Commons Attribution-ShareAlike 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/legalcode). Each file carries `<rights license="http://creativecommons.org/licenses/by-sa/3.0/">` and its authors and contributors. What shipping them requires:

- **The licence goes with each file.** "You must include a copy of, or the Uniform Resource Identifier (URI) for, this License with every copy of the Work You Distribute" (§4(a)). The URI is already in every file. The app's licence notices add the licence text.
- **No restrictions on the files.** "You may not offer or impose any terms on the Work that restrict the terms of this License … You may not impose any effective technological measures on the Work" (§4(a)). Ship them as plain `.csl` and `.xml` files, as `resources/notices/` and `resources/skills` already ship, not encrypted or compiled into the binary.
- **Attribution.** "Keep intact all copyright notices for the Work and provide … the name of the Original Author … the title of the Work … the URI" (§4(c)). Keep each file's `<info>` block as it is. The repositories add their own condition for software that uses them: "any software using CSL styles from this repository must include a clear mention of the CSL project and a link to https://citationstyles.org/", and "the listings of authors and contributors in the style metadata must be kept as is". The locales README says the same for translators. So the notices name the CSL project, link to citationstyles.org, and list the shipped styles with their titles and authors.
- **Share-alike reaches the styles, not our code.** Share-alike applies to an "Adaptation" (§4(b)), and the licence excludes Collections from that: a Collection is a work "in which the Work is included in its entirety in unmodified form along with one or more other contributions, each constituting separate and independent works in themselves … A work that constitutes a Collection will not be considered an Adaptation" (§1(a)–(b)). Unmodified style files next to IncarnaMind's Apache-2.0 code, read at run time, are a Collection. If we ever change a style, the changed file is an Adaptation and is shared under CC BY-SA 3.0 or a later version (§4(b)), but only that file. Converting a style to another format, as Hayagriva's archive does, is allowed by §3: "the right to make such modifications as are technically necessary to exercise the rights in other media and formats".

### The engines not chosen

- **citeproc-js:** [CPAL-1.0 or AGPL-3.0](https://github.com/Juris-M/citeproc-js/blob/master/LICENSE). AGPL-3.0 would put the whole app under copyleft. [CPAL-1.0](https://opensource.org/license/cpal-1-0) is MPL-1.1 with two additions. §14 lets the original developer require "a prominent display of the Original Developer's Attribution Information" each time the program starts. §15 treats any use "made available as an application intended for use over a network" as distribution, which would bind the hosted version (ADR-0002) to publish its source. In this spike it served only as a test oracle in a temporary folder.
- **citeproc-rs:** [MPL-2.0](https://github.com/zotero/citeproc-rs/blob/master/LICENSE.md), file-level copyleft, which an Apache-2.0 app can use. But the repository was archived in 2024 and its last push was 2024-08-06, so there is no one to fix it.
- **Community wasm wrappers of Hayagriva on npm:** `citeme-engine-wasm` (MIT, repository created 2026-03, 2 stars) and `refkit-js` (Apache-2.0, repository created 2026-06, 0 stars). Each is young and has one maintainer. Owning a 240-line binding is less risk than depending on either.

## Maintenance and conformance

Hayagriva is Typst's bibliography engine, so it is maintained as long as Typst is: 53 commits to `main` in 2026, 43 merged pull requests among the last 50 closed, and releases 0.10.0 and 0.10.1 in June 2026. Bugs get fixed. The Vancouver report (#519) was fixed within days. But a Typst maintainer wrote in April 2026 that "Hayagriva is sadly not well-enough maintained as-is" ([#460](https://github.com/typst/hayagriva/issues/460)). Releases trail `main`: 0.10.1 lacks fixes made since June. Hayagriva passes 518 of the 860 tests in the [CSL processor test suite](https://github.com/citation-style-language/test-suite)'s `processor-tests/humans` (its own list, `tests/citeproc-pass.txt` at `546c7c7`). Its harness skips tests that use features it doesn't support, so that is a floor. citeproc-js is the processor the suite grew up with.

## The three routes

| | (A) Hayagriva in wasm | (B) An exception for an MPL or CPAL engine | (C) A few hand-written styles |
|---|---|---|---|
| Licence | MIT/Apache-2.0, all dependencies permissive | citeproc-js: CPAL's start-up attribution and network clause, or AGPL; citeproc-rs: MPL-2.0 is workable but the project is archived | Ours |
| Output against Zotero | 90% of citations and 82% of entries identical; known, listed, fixable differences | citeproc-js is what Zotero runs, so identical | Only as close as we make it, style by style |
| Styles | Any of the 10,000+ CSL styles, including ones a university hands out | Any | APA, IEEE, GB/T 2015 and 2025 at most |
| Chinese | Pinyin sorting, Chinese names; GB/T English entries through two renders (tested in the harness, to build in #289) | Full CSL-M | Whatever we write |
| Cost | A 240-line binding, a Rust build step, and upstream fixes | An exception to the dependency rule, attribution on screen, source obligations for the hosted version; or an unmaintained engine | Hundreds of rules per style (disambiguation, et al., name forms, year suffixes, sorting, locale terms), owned forever |
| Size and speed | 2.4 MB (0.8 MB gzipped); 3–70 ms for 30 references | 970 KB of JavaScript; 11–92 ms | Small and fast |

**Recommendation: (A).** It is the only route that keeps the dependency rule and still gives Users any CSL style. Its differences from Zotero are concrete and most are ordinary bugs we can fix upstream. Its Chinese support matches Zotero's on these fixtures apart from D3, D4 and D6. With the two-render workaround built into the binding, English entries in GB/T styles would come out as the standard asks, which Zotero's official styles don't do. (C) stays the fallback if Hayagriva stalls: the interface in ADR-0016 lets a hand-written style sit behind it.

## What is left uncertain

- **citeproc-js as a stand-in for Zotero.** The engine code and its options are Zotero's, but its conversion of items to CSL JSON and its word-processor plugins were not exercised, and the app was not run.
- **Decided in #289: the space before 等 follows Zotero.** There is none after a Chinese name in GB/T author-date citations, as most Chinese academics cite with Zotero, and none after a full-width comma in the 2025 entries; the binding removes both. The "&" between two institutional authors and the em dash in a title are judgement calls too.
- **Upstream timing.** Fixes for D1, D2, D4, D8, D9, D11, D12, D15 and S1 have to be written (by us, in Rust) and accepted, and then released or pinned. How fast Typst reviews them is unknown.
- **Rich text from Zotero (S3)** needs a design: convert in the binding, or parse upstream.
- **The build.** The app's build is npm only today. Either CI installs Rust and builds the wasm, or a built `.wasm` is committed with a script that reproduces it byte for byte. #289 decides.
- **Speed** comes from one machine that was busy. The ICU data could shrink, but that needs a change in Hayagriva.
- **The fixtures** are realistic but not checked against the original publications, and a few details (URLs, dates) may differ from the real records. They test formatting, not bibliographic truth.

## Reproducing this

`spikes/288-csl-engine/` holds everything the numbers above came from except third-party code. It is there because #289 starts from the binding and reuses the 30 references as its golden-test inputs.

```sh
WORK=/tmp/csl-spike sh spikes/288-csl-engine/setup.sh   # toolchain, styles, locales, Zotero's citeproc.js, all outside the repo
WORK=/tmp/csl-spike sh spikes/288-csl-engine/build.sh   # wasm into $WORK/pkg
node spikes/288-csl-engine/harness/compare.mjs /tmp/csl-spike /tmp/csl-spike/pkg /tmp/csl-spike/results
node spikes/288-csl-engine/harness/side-checks.mjs /tmp/csl-spike /tmp/csl-spike/pkg
node spikes/288-csl-engine/harness/bench-all.mjs /tmp/csl-spike /tmp/csl-spike/pkg 9
node spikes/288-csl-engine/harness/bench-all.mjs /tmp/csl-spike "" 9 --citeproc
node spikes/288-csl-engine/harness/sizes.mjs /tmp/csl-spike/pkg/web/csl_spike_bg.wasm
```

For the licence table: `cargo metadata --format-version 1 --filter-platform wasm32-unknown-unknown --manifest-path spikes/288-csl-engine/binding/Cargo.toml > meta.json`, then `node spikes/288-csl-engine/harness/licences.mjs meta.json`.

## Sources

- Hayagriva: https://github.com/typst/hayagriva (`Cargo.toml` licence field, `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`); issues [#339](https://github.com/typst/hayagriva/issues/339), [#380](https://github.com/typst/hayagriva/issues/380), [#439](https://github.com/typst/hayagriva/issues/439), [#460](https://github.com/typst/hayagriva/issues/460), [#519](https://github.com/typst/hayagriva/issues/519); pull request [#520](https://github.com/typst/hayagriva/pull/520)
- citationberg (Hayagriva's CSL parser): https://github.com/typst/citationberg
- CSL 1.0.2 specification: https://docs.citationstyles.org/en/stable/specification.html (Group, Disambiguation, Cite Grouping, Choose and `is-numeric`, Text-case)
- CSL-M, the extension citeproc-js supports: https://citeproc-js.readthedocs.io/en/latest/csl-m/index.html
- CSL styles: https://github.com/citation-style-language/styles (Licensing); locales: https://github.com/citation-style-language/locales (Licensing); processor test suite: https://github.com/citation-style-language/test-suite
- Creative Commons Attribution-ShareAlike 3.0 Unported, legal code: https://creativecommons.org/licenses/by-sa/3.0/legalcode
- Zotero's citeproc.js and its setup: https://github.com/zotero/zotero (`chrome/content/zotero/xpcom/citeproc.js`, `style.js`, `cite.js`)
- citeproc-js licence: https://github.com/Juris-M/citeproc-js/blob/master/LICENSE; CPAL-1.0: https://opensource.org/license/cpal-1-0; AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.html
- citeproc-rs: https://github.com/zotero/citeproc-rs (archived; `LICENSE.md`, MPL-2.0: https://www.mozilla.org/MPL/2.0/)
- Unicode License v3: https://www.unicode.org/license.txt; ICU4X: https://github.com/unicode-org/icu4x
- wasm-bindgen: https://github.com/wasm-bindgen/wasm-bindgen; binaryen: https://github.com/WebAssembly/binaryen; rustup: https://rustup.rs
