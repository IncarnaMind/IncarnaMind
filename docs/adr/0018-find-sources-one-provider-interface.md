# Find sources: one Source provider interface, asked with consent, adding only open copies

## Context

Users need to find and add the sources they cite without leaving IncarnaMind (#296). Academic papers come first; laws, regulations, filings, drug labels and clinical trials next (#303–#307). Each must be a small provider added to one framework, not a change to it.

## Decision

Find sources searches public services from the core (the main process, never the window), merges what they find into one ranked list, and adds a work the User chooses to the Library: an open-access copy as a Document with its reference record (#286) filled, or, with no open copy, the reference record alone. The same search is a Tool an Answer can call (ADR-0013). The code is in `src/core/sources/`.

### The provider interface

A Source provider (CONTEXT.md) is one module implementing `SourceProvider` (`src/core/sources/types.ts`), registered in `src/core/sources/providers/index.ts` with its strings (`sources.provider.<id>.about`, English and Chinese) and an entry in this record. It names the `service` consent is asked for, once per provider, and its `terms`: where its operator states them, and `intervalMs`, the least time between two requests. A work it returns carries its identifiers, so works two providers share merge into one, its open copies best first, and the **date of the version** it describes: laws and labels change and preprints have versions, so the version a Document holds is recorded, and a Citation is checked against that stored text (ADR-0010).

The framework does the rest, the same for every provider: consent, pacing and backoff, merging (by any shared identifier, ranked by reciprocal rank fusion with k = 60), downloading, saving, recording where a Document came from, the Answer's Tool and the Library's results.

**Full text, by its shape:**

- **"pdf":** kept as it came; its Locations are pages.
- **"sections":** Markdown, one heading per section; its Locations are sections (ADR-0011), and the quote check reads the section the quote is in. PubMed Central's JATS XML uses it, and so do laws: each provision is a section headed as it is cited ("s. 3(2)", "Art. 6(1)(f)"), without its own "§", so the Location reads "§ 240.10b-5(b)" once.
- **"html":** a web page, saved as Add a web page saves one (#261), as a snapshot in the data folder's "Web pages". The providers' reference record is filled first, so the page fills only what they left empty. A page that can't be saved (a sign-in, too little text) leaves the reference record.

**Keys, and what comes later:**

- **A User's own key** is stored only through `src/core/secrets.ts` (`sources.<id>.key`), set from a line under Find sources' search, sent in a header, never in the address, and never shared across Users, which the services penalise. openFDA's is optional (`takesKey`). GovInfo's is needed (`needsKey`): without it GovInfo is off, nothing is sent and no consent is asked, and the result says why with "Add key…". For such a provider, consent also says the key is sent ("provider-key", for that service alone, through `consent.ts`'s `sendsTo`).
- **A paid provider** is an optional Connector on the User's own key or subscription, never shipped with the app. Results it may not let IncarnaMind store are reference-only, with no checked Citation.
- **A User-Agent with a contact address** (SEC EDGAR answered 403 to `SOURCE_USER_AGENT`, which names only the project): a project mailbox the maintainer supplies in the build configuration, never invented and never the User's. EDGAR waits for it (#558).
- **Licence and terms flags** beyond commercial use (may the text be stored, is a licence application needed) come with the first provider that needs them. A provider whose terms forbid storing its text offers no open copies, so its works are added as reference records.
- **A local copy searched offline** (Taiwan's law database, #307) is a provider whose `search` reads its own file, refreshed at most once a day after consent.

### Privacy and terms

- **Consent.** The data flow "find-sources" sends "search-terms" (the words and filters) and "work-ids" (the identifier of a work added). Nothing from the User's Documents or Minds is sent. Consent is asked once per provider, through `src/core/consent.ts`, before its first request. A declined provider is skipped, and the results say so. A provider the User has decided on is listed on the Privacy page, to revoke.
- **Local mode** turns Find sources off: nothing is searched or downloaded, and Answers aren't offered the Tool.
- **Downloading an open copy** from a publisher's or repository's address sends no User data: it is a work the User chose, fetched once, without cookies, within 60 seconds and 100 MB, as a web page is (#261). So it isn't a consent flow, and `docs/privacy.md` says so. A copy fetched through a provider (arXiv's PDFs, PubMed Central's text) is under that provider's consent.
- **Only open copies, never from behind a paywall.** IncarnaMind fetches only addresses a provider lists as open access, and keeps only the file asked for: a "PDF" that is a sign-in page is dropped and the next copy tried. A work with no open copy is added as its reference record, and "Get the PDF…" opens its page in the User's browser.
- **Licences** show on each result; one that rules out commercial use says "non-commercial use only". A Document's licence and version are kept with it (`Document.found`).
- **Pacing.** Requests to one service go one at a time, `intervalMs` apart from the end of the last, shared app-wide (Look up, #286, shares arXiv's). A 429 or 503 with a Retry-After of at most 30 seconds waits and tries once more; otherwise that provider's part fails as "rate-limited". Searches are cached for 30 minutes. Nothing is bulk-downloaded: one copy, when the User adds a work.

### The providers, as their operators state their terms

Each provider's module keeps its service's details (endpoints, error codes, quirks). Here is what each operator asks, and what IncarnaMind does.

Academic papers (checked 2026-10-11):

| Provider | Gives | The operator's terms | IncarnaMind |
|---|---|---|---|
| **OpenAlex** | search, metadata, open-copy locations, citation counts | CC0; no key needed; keyless budget $0.10 a day at $0.001 a search (about 100), one work free; cached PDFs $0.01 each ([limits](https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication)) | 100 ms apart; downloads open copies from where OpenAlex says they are; no `mailto`, as it describes no polite pool |
| **arXiv** | preprints, all open | "No more than one request every three seconds, and limit requests to a single connection at a time"; e-prints for personal or research use ([terms](https://info.arxiv.org/help/api/tou.html)) | 3 s apart on one lane, PDFs included; a PDF only when the User adds a paper |
| **PubMed, PubMed Central** | articles, PMC full text | 3 requests a second without a key, with a `tool` name; the `email` must be a developer's; PMC allows automated retrieval only through its own services ([E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/), [PMC](https://pmc.ncbi.nlm.nih.gov/tools/amdataset)) | 400 ms apart; no `email`; full text by EFetch as JATS XML, never from PMC's pages, and an article whose publisher withholds it stays a reference |
| **Crossref** | a DOI's record, when the User types a DOI | metadata is facts; the public pool allows 5 single-record requests a second, the polite pool needs a `mailto` ([limits](https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/)) | never invents a `mailto`; one request a second; OpenAlex, asked alongside, gives the open copies |

**Drug labels and clinical trials** (#305, checked 2026-10-11) and **US federal regulations and the US Code** (#304, checked 2026-10-12) are asked only when chosen (`searchedByDefault: false`): a drug name sent to the FDA with every search about CRISPR would be a data flow nobody asked for. The Library's panel starts with them off, and the Answer's Tool names them with `kind` ("drug_labels", "clinical_trials", "us_law"). An NCT number, a label's set id or a citation the User types ("17 CFR 240.10b-5", "42 U.S.C. § 1983") is looked up in its provider whichever are chosen. Each is a service of its own for consent, and `SOURCE_USER_AGENT` names the project and no one.

| Provider | Gives | The operator's terms | IncarnaMind |
|---|---|---|---|
| **openFDA** | a label, a field per section | CC0 unless marked; without a key 240 requests a minute and 1,000 a day, with one 120,000 a day ([terms](https://open.fda.gov/terms/)) | 600 ms apart; the User's optional key as `X-Api-Key` (`sources.openfda.key`), never in the address, never given back, in no error; shows and keeps its disclaimer, and adds no advice |
| **DailyMed** | labels by name or set id, the whole label as SPL XML | states no limit; NLM's general API terms, seen only in a search result, ask for at most 20 a second | half a second apart; keeps no cookies; a section's number read from its title |
| **ClinicalTrials.gov** | trials by condition, drug or words, and by NCT number | its limit and terms couldn't be read; third-party guides say about 50 a minute | one second apart until the operator's figure is read; a record (up to 2 MB) only when the User adds it |
| **The eCFR** | the CFR as amended to date, by words or citation | its developer pages turn automated readers away; its operators call it "an unofficial editorial compilation … not an official legal edition" ([about](https://www.archives.gov/federal-register/cfr/about-ecfr)) | one second apart; each result, the Answer's Tool and the Document's "About this text" say "Unofficial compilation, not the official edition" |
| **GovInfo** | the US Code, and the CFR's annual edition, by citation only | an api.data.gov key, 1,000 requests an hour, then 429 for up to an hour; no copyright (17 U.S.C. § 105) | 500 ms apart; the User's key (`needsKey`), linking its [sign-up page](https://www.govinfo.gov/api-signup); never `DEMO_KEY` (10 requests, then a 14-hour wait); a 429 stops the lookup, and an add that meets one keeps nothing, so adding again works |

- **Which reads a label.** DailyMed first, since its sections keep their subsections and numbers ("5.1 Lactic Acidosis" is a Passage of its own); openFDA when DailyMed isn't allowed, doesn't answer or lacks the label (openFDA lags it and doesn't name every label, so a search by name goes to DailyMed). A label both found is one work, by its set id.
- **A CFR section's version.** The eCFR reads a citation as of its title's latest day, or the date the User gives ("… as of 2019-06-30"), back to January 2017. A section removed since is found as removed, with its text as in force the day before. The eCFR's text and GovInfo's edition of one section are two works, never merged: different editions, as of different days. GovInfo only looks citations up; words go to the eCFR.
- **SEC EDGAR**, the third provider #304 asked for, waits for a declared contact address (#558).
- **Locations.** A label's Document starts with "About this label" (set id, version, effective date, and openFDA's disclaimer when read there), then a section for each of the label's own (`§ 5.1 Lactic Acidosis`). A trial's has "Overview", "Conditions and design", "Arms and interventions", "Primary outcome", "Secondary outcomes", "Eligibility criteria" and, when results are posted, three "Results:" sections. A regulation or statute starts with "About this text" (the citation, the edition, the day it is as of), and each section, and each paragraph it numbers, is a section headed as it is cited without its "§" ("240.10b-5(b)", `provisions.ts`). The version date is the label's effective date, the trial record's last update, or the day the legal text is as of. `found_sources.work_key` holds `setid:…`, `nct:…`, `cfr:…` and `govinfo:…`, with no migration.

### The Answer's Tool

`find_sources` (`src/core/sources/tool.ts`) runs the same search under the same consent. Its results are public records, not the User's data, so the chat flow doesn't count them as "tool-results". Its Effects are network calls to each provider's service, which consent covers, so it runs without an approval card.

- **Offered only to a Question that names scholarly works or asks to find sources** (`src/core/sources/intent.ts`): papers, preprints, a DOI, 论文 or 文献; "find sources on …", "查找一些关于……的资料"; a US citation, or "find the federal regulations on …" (#304). "Published", or "article" without such a verb, doesn't count ("When are the tide tables published?", a contract's "Article 5"). Offered to every Answer, a model could send searches out, and put a consent request in front of the User, for a Question about their own Documents, and a small local model's window would carry the Tool for nothing. The Library's Find sources covers what the words miss.
- A model that cites with structured output, as small local models do (ADR-0007), is offered no Tools, so it doesn't search; its User finds sources in the Library.
- What it finds is never cited with a marker. The Answer names the works, and the Tool-call row's "Show results" opens them in the Library to add.

## Considered options

- **Searching from the window:** the window reaches nothing on the network, and SEC data has no CORS.
- **OpenAlex's cached PDFs:** $0.01 a PDF, 10% of the keyless daily budget.
- **PubMed Central's pages or its OA Web Service:** automated retrieval from the pages isn't allowed, and the OA Web Service is retired in 2026.
- **Unpaywall for open copies:** OpenAlex carries its data, and it needs an email on every request.
- **Offering the Tool to every Answer:** rejected for now, as above.
- **Keeping found copies in the Output location (#124):** saved text and web pages live in the data folder, so found copies do too, in its "Sources" folder; otherwise the first save would ask where new files go in the middle of adding a paper. A copy deleted permanently is removed from it.

## Consequences

- Migration 49 adds `found_sources`: one row per Document, or reference record with no Document, that Find sources added, with the provider, the work's key, the address the text came from, its licence, version and version date, and when it was fetched. The record's fields are written as Look up's ("lookup") before the file is read, so reading the file fills only what the providers left empty, and the User's edits stay theirs.
- `reference_records.document_id` stays NULL for a reference added alone; adding the work later with an open copy links that record to the new Document.
- Tests never reach the services. A local stand-in (`tests/helpers/sourceServices.ts`) answers with responses recorded from each provider on 2026-10-11, trimmed (`tests/fixtures/sources/`), and the core's tests point every provider at an address nothing answers unless a test gives its stand-in.
