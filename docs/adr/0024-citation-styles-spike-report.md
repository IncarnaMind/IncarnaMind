# Citation-style engine spike (#288): report

The evidence behind [ADR-0016](0016-citation-styles-hayagriva-in-wasm.md). The question: can IncarnaMind format Citations and a Bibliography in CSL styles (#289) with an engine that fits the dependency rule in `AGENTS.md` (open source, permissive, maintained, small)? The JavaScript CSL processors don't fit it: citeproc-js is CPAL-1.0 or AGPL-3.0, and citeproc-rs is MPL-2.0 and archived. Hayagriva, the CSL engine in Typst, is MIT or Apache-2.0 but has no official wasm or npm build.

## Summary

- **Hayagriva builds to wasm** with nothing patched, through a binding of about 240 lines of Rust (`spikes/288-csl-engine/binding`).
- **Against citeproc-js as Zotero ships it,** across 11 styles: 338 of 374 citations (90%) and 269 of 330 bibliography entries (82%) are identical, with 7 more that differ only in spaces. Fifteen kinds of difference account for all the rest, and most are Hayagriva bugs that can be fixed upstream.
- **Size:** 2.37 MiB of wasm (771 KiB gzipped), almost half of it ICU4X data for sorting Chinese by pinyin.
- **Speed:** 30 references format in 3–70 ms warm, faster than citeproc-js; 300 references take up to 0.75 s, so formatting belongs in a worker.
- **Licences:** every crate compiled in is permissive, none copyleft. The CSL styles and locales are CC BY-SA 3.0; shipped unmodified beside our code, they form a "Collection", so share-alike covers the style files and not IncarnaMind's code.
- **Recommendation: (A) Hayagriva in wasm,** behind an interface of our own. Accepted on 2026-10-11 as ADR-0016.

## What was tried

- **The engine.** Hayagriva `main` at [`546c7c7`](https://github.com/typst/hayagriva/commit/546c7c721bbb5539f96ce458df5d4bb3f97c11e9) (2026-09-26; crate version still 0.10.1), and the released 0.10.1 for comparison, with `default-features = false` and `csl-json` (no BibLaTeX parser, no bundled style archive). Rust 1.99.0 to `wasm32-unknown-unknown` (`opt-level = "s"`, LTO, one codegen unit, `panic = "abort"`), wasm-bindgen 0.2.129, binaryen 132's `wasm-opt -Oz`. The toolchain was installed in a temporary folder, touching no shell profile (`spikes/288-csl-engine/setup.sh`). Hayagriva and its dependencies are pure Rust, with nothing platform-specific.
- **The binding** takes a CSL style and CSL locales as XML and references as CSL JSON, and returns the citations and the bibliography as formatted runs (text with italic, bold, small caps, superscript, subscript and link flags), as plain text, or as Hayagriva's HTML. A dependent style is refused; the app resolves it to its parent.
- **The fixtures:** 30 references in CSL JSON, 16 English and 14 Chinese, and 34 citations of them (`tests/fixtures/citation-styles/`, moved there by #289). They cover journal articles with 1 to 34 authors, diacritics and name particles, books (editions, translations, institutional authors, two by the OECD in one year), chapters, theses, conference papers, web pages, reports, two standards, two laws, a newspaper article and an article with no author, several missing a publisher, place, date or author; some Chinese ones are the examples printed in GB/T 7714—2015. The citations add a cite of three works in both languages, repeated cites (short notes, ibid), and a cite of the two OECD books (year suffixes, collapsing).
- **The oracle:** the `citeproc.js` Zotero ships, from Zotero's repository at [`08880f7`](https://github.com/zotero/zotero/blob/08880f7a0e51021cc13b6aff248fdcbc96234c91/chrome/content/zotero/xpcom/citeproc.js) (processor 1.4.61), set up as Zotero's [`Style.getCiteProc`](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/style.js) sets it up. It ran in a temporary folder and was never added to this repository. Zotero itself was not run, so its conversion of items to CSL JSON and its word-processor plugins weren't exercised.
- **The styles**, unmodified, from [citation-style-language/styles](https://github.com/citation-style-language/styles) at `f2c83bb` (2026-10-09), with the `en-US`, `en-GB` and `zh-CN` locales from [citation-style-language/locales](https://github.com/citation-style-language/locales) at `a89adec`: APA 7, MLA 9, Chicago 18th (notes and bibliography; author-date), IEEE, Vancouver (`nlm-citation-sequence.csl`), Harvard (Cite Them Right 12th), and GB/T 7714—2015 and —2025, each numeric and author-date.
- **The comparison.** Both engines formatted every style in plain text and HTML. A citation or entry counts as the same when the trimmed strings are equal; formatting was compared on italic, bold, small caps, superscript and subscript where the text is the same. Bibliography entries are matched by reference, and their order compared apart. Per-style counts are in `spikes/288-csl-engine/results/summary.md`, every difference in `results/details.md`.

## Results

- **Output.** Every style matched at least 22 of 34 citations and 19 of 30 entries; IEEE, Vancouver and the GB/T numeric styles matched every citation. Hayagriva 0.10.1 matched only 1 of 30 Vancouver entries, because it drops every author and editor ([typst/hayagriva#519](https://github.com/typst/hayagriva/issues/519), fixed on `main` by [#520](https://github.com/typst/hayagriva/pull/520) after the release).
- **Where both agree:** Chinese names in Chinese order without a space (钱学森), APA's 20-author rule, the et al. rules (GB/T three names before 等, Vancouver six, Chicago three when there are seven or more), short notes for repeated cites, numbering and collapsing of numeric citations (`[2,4,18]`), and pinyin order for the Chinese entries in the GB/T author-date styles. Under the English styles both sort Chinese by code point.
- **Size.** 2,485,275 bytes after `wasm-opt -Oz` (789,410 gzipped, 573,638 with Brotli), plus 11,676 bytes of JavaScript glue: 1.32 MB of code and 1.16 MB of ICU4X data (collation, normalisation, locales). The data could shrink to the `zh` and `en` collations only with a change in Hayagriva. An `opt-level = 3` and `wasm-opt -O3` build is 2,559,813 bytes and about 30% faster on the heavy styles. The wasm memory was 2.9–5.0 MB after formatting the 30 references.
- **Speed** (Apple M2 Max, Node 26.11.1, other work running, the median of 9 fresh processes): for the 30 references, 38–132 ms cold; warm, 3–6 ms for the numeric and GB/T styles, 27 ms for APA and 69 ms for Chicago notes. That is 1.4 to 2.1 times faster than citeproc-js cold and 1.1 to 2.9 times warm. At 300 references, warm: APA 339 ms and Chicago notes 751 ms, against citeproc-js's 561 and 764 ms. wasm costs about 15% against the same code compiled natively.
- **Licences of the engine.** `cargo metadata` for the wasm target resolves 73 crates; 58 are linked into the module, and 15 are procedural macros that run only at build time. Their licences: MIT OR Apache-2.0 (41, including hayagriva, citationberg, serde, url, wasm-bindgen), Unicode-3.0 (24, ICU4X), MIT (4), (MIT OR Apache-2.0) AND Unicode-3.0 (1), Apache-2.0 OR BSL-1.0 (1), MIT OR Unlicense (1), 0BSD OR CC0-1.0 (1). The full list is in `spikes/288-csl-engine/results/licences.md`. MIT, BSL-1.0 and Unicode-3.0 ask for their notice to go with copies, so the app's licence notices list them. Hayagriva's and citationberg's NOTICE files cover only CC BY-SA styles in their tests and archive, none of which is compiled in.
- **Licences of the styles and locales:** [CC BY-SA 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/legalcode). Shipping them requires:
  - the licence with each file (§4(a)): the URI is in every file, and the app's notices add the text;
  - no restrictions on the files (§4(a)): plain `.csl` and `.xml` files, not encrypted or compiled into the binary;
  - attribution (§4(c)): each file's `<info>` block kept as it is, and, as the repositories ask, a clear mention of the CSL project with a link to https://citationstyles.org/, and the authors and contributors listed as they are;
  - share-alike reaches only the styles: unmodified files next to IncarnaMind's Apache-2.0 code, read at run time, are a Collection, which is not an Adaptation (§1(a)–(b)). A style we change is an Adaptation, shared under CC BY-SA 3.0 or later (§4(b)), but only that file. Converting a style to another format is allowed by §3.
- **Maintenance.** Hayagriva is maintained as long as Typst is (53 commits to `main` in 2026; 0.10.0 and 0.10.1 in June 2026), and the Vancouver report was fixed within days. But a Typst maintainer wrote in April 2026 that "Hayagriva is sadly not well-enough maintained as-is" ([#460](https://github.com/typst/hayagriva/issues/460)), and releases trail `main`. It passes at least 518 of the 860 tests in the [CSL processor test suite](https://github.com/citation-style-language/test-suite)'s `processor-tests/humans`.

## The differences, one by one

Each against the [CSL 1.0.2 specification](https://docs.citationstyles.org/en/stable/specification.html), citeproc-js's output first.

- **D1. Title case lowercases words with inner capitals:** "ChatGPT" becomes "Chatgpt", "t-SNE" "t-Sne", "CitationStyles.org" "Citationstyles.org". MLA, both Chicago styles, and APA for a work cited by its title. *Hayagriva bug* (related: [#380](https://github.com/typst/hayagriva/issues/380)).
- **D2. Collapsed year suffixes get the wrong delimiter:** "(OECD, 2019a, 2019b)" against "(OECD, 2019a; 2019b)". APA, Chicago author-date, Harvard and both GB/T author-date styles. *Hayagriva bug.*
- **D3. Italics on Chinese text.** Hayagriva italicises Chinese titles; citeproc-js leaves Chinese upright, as Chinese typography does. Every style that italicises titles. The specification is silent. *Fix in the binding.*
- **D4. A Chinese family name with Latin initials:** "昂温 G, 昂温 P S" (as printed in GB/T 7714—2015) against "昂温G, 昂温P S". All 11 styles, one reference. *Hayagriva bug.*
- **D5. Two institutional authors:** Hayagriva applies `delimiter-precedes-last` to institutions as to people ("…总局, & 中国…"); citeproc-js doesn't, and reads as expected. APA, MLA, both Chicago styles.
- **D6. Space before 等.** (a) GB/T author-date citations: "(Kahneman 等, 1979)" in Hayagriva, as the style's own comment asks, against citeproc-js's "(Kahneman等, 1979)". (b) GB/T 2025 entries: a space after a full-width comma ("林衍凯， 等"), which is wrong in Chinese. *Hayagriva bug* in (b).
- **D7. A volume of "L 119"** (the GDPR's Official Journal issue) gets a volume label in Hayagriva. *Minor Hayagriva bug* (related: [#439](https://github.com/typst/hayagriva/issues/439)).
- **D8. `capitalize-first` is skipped for Chinese references:** "(ed.)", "trans." in APA. *Hayagriva bug.*
- **D9. APA drops the pages and publisher of a conference paper in proceedings with an editor,** in Chinese and English (S2). *Hayagriva bug.*
- **D10. Punctuation inside quotation marks** (`punctuation-in-quote` in en-US) is missed in two places, in Chicago notes and Harvard. *Minor Hayagriva bug.*
- **D11. Harvard prints "in" before the proceedings of a paper with no editor,** where the group should disappear (`cs:group`). *Hayagriva bug.*
- **D12. Vancouver**, on `main`: a stray space before ";" (5 entries); "pp." where the style asks for `plural="never"` (5 entries); editors as "In: , editorsKahneman D, …", the rest of #519 (3 entries). *Hayagriva bugs.*
- **D13. IEEE double spaces** ("[Online].  Available:"), 7 entries. *Minor Hayagriva bug.*
- **D14. Em dash spacing in a title:** citeproc-js closes "documentation — Guidelines" in APA; Hayagriva keeps the title as entered. One entry; changing the data is debatable.
- **D15. Bibliography order:** in MLA and both Chicago styles, the article with no author sorts first in Hayagriva, apparently on the quotation mark, and under "T" in Zotero. *Hayagriva bug.*

Both engines share one limit that matters for Chinese users: the official GB/T styles give "等" and "4 版" for English references too, where GB/T 7714 wants "et al." and "4th ed." (S5).

**Side checks** (`harness/side-checks.mjs`, output in `results/side-checks.txt`):

- **S1. Year suffixes follow citation order,** not bibliography order as the specification says: cite the later title first and it gets "2019a". *Hayagriva bug,* visible to any APA user.
- **S2. Conference papers with editors** lose pages and publisher in English too (D9).
- **S3. Rich text in fields.** Zotero writes `<i>`, `<sub>`, `<sup>`, `<b>` and `<span class="nocase">` into titles; Hayagriva's CSL JSON path prints them as text, and title case then changes them.
- **S4. Hayagriva's HTML is not escaped:** a title holding `<img src=x onerror=alert(1)>` comes out as a live tag, and so would a URL with a quotation mark. Reference metadata is untrusted, so the binding returns runs, and the app never uses Hayagriva's HTML.
- **S5. CSL-M.** The GB/T 7714—2015 styles carry, commented out, a CSL-M layout for English entries, which Hayagriva refuses, and Typst has no capacity for CSL-M ([#460](https://github.com/typst/hayagriva/issues/460)). A workaround tested in the harness: format the bibliography twice, in the style's locale and in `en-US`, and keep each entry in its reference's language. It matched citeproc-js's CSL-M output exactly on the three references tried.

## The three routes

- **(A) Hayagriva in wasm.** Permissive throughout; any of the 10,000+ CSL styles; 90% and 82% identical to Zotero, with known, fixable differences; pinyin sorting and Chinese names; 2.4 MB (0.8 MB gzipped). Its cost: a 240-line binding, a Rust build step, and upstream fixes.
- **(B) An exception for an MPL or CPAL engine.** citeproc-js matches Zotero by definition and supports CSL-M, but [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) would put the app under copyleft, and [CPAL-1.0](https://opensource.org/license/cpal-1-0)'s §14 lets the author require an attribution display at every start and §15 treats network use as distribution, binding the hosted version (ADR-0002) to publish its source. [citeproc-rs](https://github.com/zotero/citeproc-rs) is MPL-2.0, which we could live with, but archived since 2024 (last push 2024-08-06).
- **(C) A few hand-written styles** (APA, IEEE, GB/T 2015 and 2025 at most): hundreds of rules each (disambiguation, et al., name forms, year suffixes, sorting, locale terms), owned forever, and no style a university hands out.
- Community wasm wrappers of Hayagriva on npm (`citeme-engine-wasm`, `refkit-js`) are months old with one maintainer each; owning a 240-line binding is less risk.

**Recommendation: (A).** It is the only route that keeps the dependency rule and still gives Users any CSL style. Its differences from Zotero are concrete, and most are ordinary bugs we can fix upstream. (C) stays the fallback if Hayagriva stalls, behind the same interface.

## What ADR-0016 took from it

- Hayagriva in wasm with a binding of our own, behind a `CitationStyleEngine` interface, pinned to `546c7c7` until a release carries the fixes.
- Runs only, never Hayagriva's HTML (S4).
- What the binding adds: Chinese runs never italic (D3), English entries in GB/T styles through two renders (S5), and Zotero's rich text (S3).
- Formatting off the window's thread, since 300 references take up to 0.75 s.
- The bugs fixed in Hayagriva itself, not in our copy: D1, D2, D4, D8, D9, D11, D12, D15 and S1 are ours to write in Rust and get accepted, at a pace Typst sets.

The spike left some questions that ADR-0016's amendments since settled: the built `.wasm` is committed and CI shows it reproduces; the `-O3` build ships; there is no space between a Chinese name and 等, as Zotero writes it (#289); and rich text needs nothing yet, since reference records keep fields as plain text. The fixtures are realistic but not checked against the original publications: they test formatting, not bibliographic truth.

## Reproducing this

`spikes/288-csl-engine/` holds everything the numbers came from except third-party code; #289 started from its binding and reuses the 30 references as golden-test inputs.

```sh
WORK=/tmp/csl-spike sh spikes/288-csl-engine/setup.sh   # toolchain, styles, locales, Zotero's citeproc.js, all outside the repo
WORK=/tmp/csl-spike sh spikes/288-csl-engine/build.sh   # wasm into $WORK/pkg
node spikes/288-csl-engine/harness/compare.mjs /tmp/csl-spike /tmp/csl-spike/pkg /tmp/csl-spike/results
node spikes/288-csl-engine/harness/side-checks.mjs /tmp/csl-spike /tmp/csl-spike/pkg
node spikes/288-csl-engine/harness/bench-all.mjs /tmp/csl-spike /tmp/csl-spike/pkg 9
node spikes/288-csl-engine/harness/bench-all.mjs /tmp/csl-spike "" 9 --citeproc
node spikes/288-csl-engine/harness/sizes.mjs /tmp/csl-spike/pkg/web/csl_spike_bg.wasm
```

For the licence list: `cargo metadata --format-version 1 --filter-platform wasm32-unknown-unknown --manifest-path spikes/288-csl-engine/binding/Cargo.toml > meta.json`, then `node spikes/288-csl-engine/harness/licences.mjs meta.json`.

## Sources

- Hayagriva: https://github.com/typst/hayagriva; citationberg, its CSL parser: https://github.com/typst/citationberg
- CSL 1.0.2 specification: https://docs.citationstyles.org/en/stable/specification.html; CSL-M: https://citeproc-js.readthedocs.io/en/latest/csl-m/index.html
- CSL styles: https://github.com/citation-style-language/styles; locales: https://github.com/citation-style-language/locales; test suite: https://github.com/citation-style-language/test-suite
- Zotero's citeproc.js and its setup: https://github.com/zotero/zotero (`chrome/content/zotero/xpcom/citeproc.js`, `style.js`, `cite.js`); citeproc-js's licence: https://github.com/Juris-M/citeproc-js/blob/master/LICENSE
- Unicode License v3: https://www.unicode.org/license.txt; ICU4X: https://github.com/unicode-org/icu4x
