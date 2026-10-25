/**
 * Find sources (#296): searching OpenAlex, arXiv and PubMed (and Crossref,
 * for a DOI) for papers, and adding them to the Library: an open-access
 * paper as a Document with its reference record, a paywalled one as its
 * reference record alone. Each provider asks for consent once and is sent
 * only the search words and filters; local mode sends nothing. Through the
 * core's public interface, against a local stand-in answering with
 * responses recorded from the real services: no test reaches the network.
 */
import { readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, PageLook } from "../../src/core";
import { asksForSources } from "../../src/core/sources/intent";
import { licenceOf } from "../../src/core/sources/licences";
import { createPace } from "../../src/core/sources/pace";
import { askAndFinish } from "../helpers/citations";
import { queryDatabase } from "../helpers/core";
import {
  add,
  answerConsent,
  found,
  requestsTo,
  searchOf,
  setUp,
  USER_AGENT,
  virtualTimers,
  work,
} from "../helpers/findSourcesTesting";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

describe("Find sources: searching", () => {
  test("a search returns ranked results from OpenAlex, arXiv and PubMed, sending only the words and the filters", async () => {
    const { core, services } = await setUp();
    answerConsent(core);

    const result = found(
      await core.findSources({ query: "CRISPR off-target detection", fromYear: 2021 }),
    );

    expect(result.providers).toEqual([
      { id: "openalex", name: "OpenAlex", count: 4, failure: null },
      { id: "arxiv", name: "arXiv", count: 2, failure: null },
      { id: "pubmed", name: "PubMed", count: 3, failure: null },
    ]);
    expect(result.works).toHaveLength(9);
    // Each provider's best come first, merged: reciprocal rank fusion keeps their order.
    expect(result.works.slice(0, 3).map((each) => each.foundBy[0]?.id)).toEqual(
      expect.arrayContaining(["openalex", "arxiv", "pubmed"]),
    );

    // Title, authors, year and venue; open access or not; which provider; citation counts.
    const nature = work(result.works, /^Improving the sensitivity of in vivo CRISPR/);
    expect(nature).toMatchObject({
      key: "doi:10.1038/s41592-023-01840-z",
      foundBy: [{ id: "openalex", name: "OpenAlex" }],
      citedBy: 51,
      access: {
        kind: "open",
        format: "pdf",
        version: "published",
        licence: { id: "cc-by", label: "CC BY", commercial: true },
      },
      inLibrary: null,
    });
    expect(nature.fields).toMatchObject({
      type: "article-journal",
      issued: "2023-04-06",
      containerTitle: "Nature Methods",
      doi: "10.1038/s41592-023-01840-z",
    });
    expect(nature.fields.authors[0]).toEqual({ family: "Zou", given: "Roger S." });
    expect(work(result.works, /^Advances in Off-Target Detection/).access).toEqual({
      kind: "closed",
    });
    const preprint = work(result.works, /^Guide-Guard/);
    expect(preprint).toMatchObject({
      key: "doi:10.1007/978-3-031-21753-1_41",
      foundBy: [{ id: "arxiv", name: "arXiv" }],
      citedBy: null,
      versionDate: "2026-02-18",
      access: { kind: "open", format: "pdf", version: "submitted", licence: null },
      landingUrl: "https://arxiv.org/abs/2602.16327v1",
    });
    expect(preprint.fields).toMatchObject({ type: "article", publisher: "arXiv" });
    const pubmed = work(result.works, /^Off-target effects in CRISPR\/Cas9 gene editing$/);
    expect(pubmed).toMatchObject({
      foundBy: [{ id: "pubmed", name: "PubMed" }],
      access: { kind: "open", format: "text" },
    });
    expect(pubmed.fields).toMatchObject({
      containerTitle: "Front Bioeng Biotechnol",
      issued: "2023-03-09",
      authors: [
        { family: "Guo", given: "C" },
        { family: "Ma", given: "X" },
        { family: "Gao", given: "F" },
        { family: "Guo", given: "Y" },
      ],
    });
    expect(work(result.works, /^Quantitative evaluation of chromosomal/).access).toEqual({
      kind: "closed",
    });

    // The words and the filters, and nothing else: no body, and IncarnaMind named.
    const openalex = searchOf(services, "openalex");
    expect(openalex.get("search")).toBe("CRISPR off-target detection");
    expect(openalex.get("filter")).toBe("from_publication_date:2021-01-01");
    expect(searchOf(services, "arxiv").get("search_query")).toBe(
      'all:"CRISPR" AND all:"off-target" AND all:"detection" AND submittedDate:[202101010000 TO 999912312359]',
    );
    const esearch = searchOf(services, "pubmed");
    expect([esearch.get("term"), esearch.get("mindate"), esearch.get("tool")]).toEqual([
      "CRISPR off-target detection",
      "2021",
      "IncarnaMind",
    ]);
    expect(esearch.has("email")).toBe(false);
    for (const request of services.requests) {
      expect(request).toMatchObject({ method: "GET", bodyLength: 0, userAgent: USER_AGENT });
    }
    // Crossref only looks DOIs up: a search of words doesn't go to it.
    expect(requestsTo(services, "crossref")).toEqual([]);
  });

  test("open access only asks each provider for open works, and keeps only works with an open copy", async () => {
    const { core, services } = await setUp();
    answerConsent(core);

    const result = found(
      await core.findSources({ query: "CRISPR off-target", openAccessOnly: true, toYear: 2024 }),
    );

    expect(searchOf(services, "openalex").get("filter")).toBe(
      "to_publication_date:2024-12-31,is_oa:true",
    );
    expect(searchOf(services, "pubmed").get("term")).toBe(
      "(CRISPR off-target) AND free full text[sb]",
    );
    expect(result.works.every((each) => each.access.kind === "open")).toBe(true);
  });

  test("a DOI is looked up at Crossref and OpenAlex, and the two records are one work", async () => {
    const { core, services } = await setUp();
    answerConsent(core);

    const result = found(
      await core.findSources({ query: "https://doi.org/10.3389/fbioe.2023.1143157" }),
    );

    expect(result.providers.map((each) => each.id)).toEqual(["openalex", "crossref"]);
    expect(result.works).toHaveLength(1);
    const [frontiers] = result.works;
    expect(frontiers).toMatchObject({
      key: "doi:10.3389/fbioe.2023.1143157",
      foundBy: [
        { id: "openalex", name: "OpenAlex" },
        { id: "crossref", name: "Crossref" },
      ],
      citedBy: 632,
      access: { kind: "open", format: "pdf", version: "published" },
    });
    // Crossref's record wins where both have a field; OpenAlex adds where its copies are.
    expect(frontiers?.fields).toMatchObject({
      title: "Off-target effects in CRISPR/Cas9 gene editing",
      containerTitle: "Frontiers in Bioengineering and Biotechnology",
      doi: "10.3389/fbioe.2023.1143157",
    });
    expect(requestsTo(services, "crossref").map((request) => request.path)).toEqual([
      "/crossref/works/10.3389%2Ffbioe.2023.1143157",
    ]);
    expect(requestsTo(services, "arxiv")).toEqual([]);
  });

  test("the same search again soon is answered from what was found, without asking again", async () => {
    const { core, services } = await setUp();
    answerConsent(core);
    // As an Answer searches: every provider, unnamed.
    const first = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const asked = services.requests.length;

    // As the Library's "Show results" searches it again: the same providers, named.
    const again = found(
      await core.findSources({
        query: "  CRISPR   off-target detection ",
        providers: ["openalex", "arxiv", "pubmed"],
      }),
    );

    expect(again.works.map((each) => each.key)).toEqual(first.works.map((each) => each.key));
    expect(services.requests).toHaveLength(asked);
    // One provider fewer is another search.
    await core.findSources({ query: "CRISPR off-target detection", providers: ["openalex"] });
    expect(services.requests).toHaveLength(asked + 1);
  });

  test("a provider that fails says why, and the others' results still come", async () => {
    const { core, services } = await setUp();
    answerConsent(core);
    services.fail("pubmed", 429);

    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));

    expect(result.providers.find((each) => each.id === "pubmed")).toMatchObject({
      count: 0,
      failure: { reason: "rate-limited" },
    });
    expect(result.works.length).toBeGreaterThan(0);
    expect(result.works.every((each) => each.foundBy.every((by) => by.id !== "pubmed"))).toBe(true);
  });

  test("requests to arXiv are at least three seconds apart, its searches and its PDFs alike", async () => {
    const { core, services, waits } = await setUp();
    answerConsent(core);
    const result = found(
      await core.findSources({ query: "Guide-Guard CRISPR", providers: ["arxiv"] }),
    );

    await add(core, work(result.works, /^Guide-Guard/).key);

    expect(requestsTo(services, "arxiv").map((request) => request.path)).toEqual([
      expect.stringMatching(/^\/arxiv\/api\/query\?/),
      "/arxiv/pdf/2602.16327v1",
    ]);
    expect(waits).toEqual([3000]);
  });
});

describe("Find sources: consent and local mode", () => {
  test("each provider asks for consent once, saying what is sent; a declined one is never sent anything", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core, ["arXiv"]);

    const first = found(await core.findSources({ query: "CRISPR off-target detection" }));
    await core.findSources({ query: "base editing" });

    expect(asked.map((request) => request.flow)).toEqual([
      {
        id: "find-sources",
        service: { id: "https://api.openalex.org", name: "OpenAlex" },
        sends: ["search-terms", "work-ids"],
      },
      {
        id: "find-sources",
        service: { id: "https://export.arxiv.org", name: "arXiv" },
        sends: ["search-terms", "work-ids"],
      },
      {
        id: "find-sources",
        service: { id: "https://eutils.ncbi.nlm.nih.gov", name: "PubMed" },
        sends: ["search-terms", "work-ids"],
      },
    ]);
    expect(first.providers.find((each) => each.id === "arxiv")).toMatchObject({
      count: 0,
      failure: { reason: "declined" },
    });
    expect(requestsTo(services, "arxiv")).toEqual([]);
    expect(await core.listSourceProviders()).toMatchObject([
      { id: "openalex", searches: true, consent: "accepted" },
      { id: "arxiv", searches: true, consent: "declined" },
      { id: "pubmed", searches: true, consent: "accepted" },
      { id: "crossref", searches: false, consent: "not-asked" },
      {
        id: "openfda",
        searches: true,
        consent: "not-asked",
        searchedByDefault: false,
        key: "unset",
      },
      {
        id: "dailymed",
        searches: true,
        consent: "not-asked",
        searchedByDefault: false,
        key: "none",
      },
      { id: "clinicaltrials", searches: true, consent: "not-asked", searchedByDefault: false },
      { id: "ecfr", searches: true, consent: "not-asked", searchedByDefault: false, key: "none" },
      { id: "govinfo", searches: false, consent: "not-asked", key: "unset", keyNeeded: true },
    ]);
  });

  test("Undo of stopping a provider searched before brings it back, though no search goes to it now (#1463)", async () => {
    const { core } = await setUp();
    const asked = answerConsent(core);
    await core.findSources({ query: "CRISPR off-target detection", providers: ["arxiv"] });
    const arxiv = { id: "https://export.arxiv.org", name: "arXiv" };
    const arxivDecision = async () =>
      (await core.listDataFlows()).find(
        (each) => each.flow.id === "find-sources" && each.flow.service.id === arxiv.id,
      );
    const before = await arxivDecision();
    expect(before).toMatchObject({ consent: "accepted" });

    const revokedAt = await core.revokeConsent("find-sources", arxiv.id);
    expect(await arxivDecision()).toBeUndefined();
    if (!revokedAt) throw new Error("There was no decision to revoke.");
    await core.restoreConsent("find-sources", arxiv.id, revokedAt);

    expect(await arxivDecision()).toEqual(before);
    const asking = asked.length;
    await core.findSources({ query: "base editing", providers: ["arxiv"] });
    expect(asked).toHaveLength(asking);
  });

  test("local mode blocks every provider: nothing is asked or sent, and nothing can be added", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const asking = asked.length;
    const sent = services.requests.length;
    await core.setLocalOnly(true);

    expect(await core.findSources({ query: "base editing" })).toEqual({ outcome: "local-mode" });
    expect(await core.addFoundSource({ key: work(result.works, /^Improving/).key })).toMatchObject({
      outcome: "failed",
      reason: "local-mode",
    });
    expect(asked).toHaveLength(asking);
    expect(services.requests).toHaveLength(sent);
    // The Privacy page lists each provider decided on, to revoke.
    const flows = await core.listRegisteredDataFlows();
    expect(
      flows
        .find((flow) => flow.id === "find-sources")
        ?.services.map((each) => each.flow.service.name),
    ).toEqual(["OpenAlex", "arXiv", "PubMed"]);
  });
});

describe("Find sources: adding", () => {
  test("an open-access paper is downloaded and added as a Document in the Folder, with its reference record and where it came from", async () => {
    const { core, services, dataDir } = await setUp();
    answerConsent(core);
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));

    const { result: added, document } = await add(
      core,
      work(result.works, /^Improving the sensitivity/).key,
      folder.id,
    );

    expect(added).toMatchObject({ outcome: "document", existing: false });
    expect(document?.status).toBe("ready");
    expect(document?.kind).toBe("pdf");
    expect(document?.name).toBe(
      "Improving the sensitivity of in vivo CRISPR off-target detection with DISCOVER-Seq+",
    );
    expect(document?.path).toBe(join(await realpath(dataDir), "Sources", `${document?.name}.pdf`));
    // The published PDF, from where OpenAlex said it was; nothing from PMC or the preprint.
    expect(requestsTo(services, "files").map((request) => request.path)).toEqual([
      "/files/nature-methods.pdf",
    ]);
    expect(document?.found).toEqual({
      provider: { id: "openalex", name: "OpenAlex" },
      address: `${services.url}/files/nature-methods.pdf`,
      licence: { id: "cc-by", label: "CC BY", commercial: true },
      version: "published",
      versionDate: "2023-04-06",
      fetchedAt: expect.any(String),
    });
    // Its record is the providers', kept through the reading of the file.
    expect(document?.reference?.fields).toMatchObject({
      type: "article-journal",
      title: "Improving the sensitivity of in vivo CRISPR off-target detection with DISCOVER-Seq+",
      containerTitle: "Nature Methods",
      volume: "20",
      issue: "5",
      pages: "706–713",
      doi: "10.1038/s41592-023-01840-z",
    });
    expect(document?.reference?.sources).toMatchObject({ title: "lookup", doi: "lookup" });
    // Filed in the Folder, and its words can be searched.
    const library = await core.getLibrary();
    expect(library.assignments.find((each) => each.documentId === document?.id)?.groupId).toBe(
      folder.id,
    );
    const passages = await core.searchPassages("fivefold more off-target sites", { limit: 3 });
    expect(passages[0]?.documentId).toBe(document?.id);
    // Found again, it says it's in the Library.
    const again = found(await core.findSources({ query: "CRISPR off-target detection" }));
    expect(work(again.works, /^Improving the sensitivity/).inLibrary).toEqual({
      documentId: document?.id,
      recordId: document?.reference?.id,
    });
    // Adding it again gives the same Document.
    expect(
      await core.addFoundSource({ key: work(again.works, /^Improving the sensitivity/).key }),
    ).toMatchObject({ outcome: "document", existing: true, document: { id: document?.id } });
  });

  test("a PubMed Central article is added by section, after the publisher's 'PDF' turns out to be a sign-in page", async () => {
    const { core, services } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "10.3389/fbioe.2023.1143157" }));

    const { document } = await add(core, result.works[0]?.key ?? "");

    // The paywalled address gave a page, not a PDF: nothing of it is kept; PMC gave the text.
    expect(requestsTo(services, "files").map((request) => request.path)).toEqual([
      "/files/paywall.pdf",
    ]);
    expect(
      requestsTo(services, "pubmed").map((request) =>
        new URL(request.path, services.url).searchParams.get("id"),
      ),
    ).toEqual(["PMC10034092"]);
    expect(document?.kind).toBe("markdown");
    expect(document?.found).toMatchObject({
      provider: { id: "pubmed", name: "PubMed" },
      licence: { id: "cc-by", label: "CC BY", commercial: true },
      versionDate: "2023-03-09",
    });
    expect(document?.reference?.fields).toMatchObject({
      title: "Off-target effects in CRISPR/Cas9 gene editing",
      authors: [
        { family: "Guo", given: "Congting" },
        { family: "Ma", given: "Xiaoteng" },
        { family: "Gao", given: "Fei" },
        { family: "Guo", given: "Yuxuan" },
      ],
      doi: "10.3389/fbioe.2023.1143157",
    });
    // Each section is a Unit under its heading, so a Citation names the section its quote is in.
    const text = await core.readDocumentText(document?.id ?? "");
    const headings = text.pages.map((unit) => unit.label?.path?.at(-1));
    expect(headings).toEqual(
      expect.arrayContaining([
        "Abstract",
        "1 Introduction",
        "2 In silico prediction",
        "3 Experimental detection",
        "3.1 Cell-free methods",
      ]),
    );
    const introduction = text.pages.find((unit) => unit.label?.path?.at(-1) === "1 Introduction");
    expect(introduction?.text).toContain("Genome editing tools hold great promise");
    expect(introduction?.text).not.toContain("<xref");
  });

  test("a paywalled paper is added as its reference record alone, with its page to get the PDF from", async () => {
    const { core, services, dataDir } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const closed = work(result.works, /^Advances in Off-Target Detection/);
    const asked = services.requests.length;

    const added = await core.addFoundSource({ key: closed.key });

    expect(added).toEqual({
      outcome: "reference",
      recordId: expect.any(String),
      reason: "closed",
      landingUrl: "https://doi.org/10.1089/hum.2022.198",
      existing: false,
    });
    // Nothing was downloaded, and no Document made.
    expect(services.requests).toHaveLength(asked);
    expect(await core.listDocuments()).toEqual([]);
    const [record] = queryDatabase<{ document_id: string | null; fields: string }>(
      dataDir,
      "SELECT document_id, fields FROM reference_records",
    );
    expect(record?.document_id).toBeNull();
    expect(JSON.parse(record?.fields ?? "{}")).toMatchObject({
      title: {
        value: "Advances in Off-Target Detection for CRISPR-Based Genome Editing",
        source: "lookup",
      },
      doi: { value: "10.1089/hum.2022.198", source: "lookup" },
    });
    const again = found(await core.findSources({ query: "CRISPR off-target detection" }));
    expect(work(again.works, /^Advances in Off-Target Detection/).inLibrary).toEqual({
      documentId: null,
      recordId: added.outcome === "reference" ? added.recordId : "",
    });
  });

  test("an open copy that can't be had leaves the reference record, and nothing of what came instead", async () => {
    const { core, dataDir } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));

    // PMC holds this article, but its publisher doesn't let PMC give its text.
    const added = await core.addFoundSource({
      key: work(result.works, /^Drag-and-drop genome insertion/).key,
    });

    expect(added).toMatchObject({ outcome: "reference", reason: "download-failed" });
    expect(await readdir(join(dataDir, "Sources")).catch(() => [])).toEqual([]);
  });

  test("a work whose open text is a web page is saved as a web page Document in the Folder, with the providers' reference record", async () => {
    const { core, services, dataDir } = await setUp();
    answerConsent(core);
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const chopoff = work(result.works, /^CHOPOFF/);
    expect(chopoff.access).toMatchObject({ kind: "open", format: "web-page", version: "accepted" });
    const page = `${services.url}/files/chopoff.html`;

    const { result: added, document } = await add(core, chopoff.key, folder.id);

    // Saved as Add a web page saves one: a snapshot in the data folder, and the address it came from.
    expect(added).toMatchObject({ outcome: "document", existing: false });
    expect(document).toMatchObject({ kind: "web", status: "ready" });
    expect(await realpath(dirname(document?.path ?? ""))).toBe(
      join(await realpath(dataDir), "Web pages"),
    );
    expect(document?.web).toMatchObject({ address: page, siteName: "bioRxiv" });
    expect(document?.found).toMatchObject({
      provider: { id: "openalex", name: "OpenAlex" },
      address: page,
      licence: { id: "cc-by-nc-nd", commercial: false },
      version: "accepted",
    });
    // Its record is the providers', not the page's: the page fills only what they left empty.
    expect(document?.reference?.fields).toMatchObject({
      title: "CHOPOFF: symbolic alignments enable fast and sensitive CRISPR off-target detection",
      doi: "10.1101/2025.01.06.603201",
      authors: expect.arrayContaining([expect.objectContaining({ family: "Labun" })]),
    });
    expect(document?.reference?.sources).toMatchObject({ title: "lookup", doi: "lookup" });
    const library = await core.getLibrary();
    expect(library.assignments.find((each) => each.documentId === document?.id)?.groupId).toBe(
      folder.id,
    );
    const passages = await core.searchPassages("index of the genome once", { limit: 3 });
    expect(passages[0]?.documentId).toBe(document?.id);
    // Found again, it's in the Library; added again, it's the same Document.
    const again = found(await core.findSources({ query: "CRISPR off-target detection" }));
    expect(work(again.works, /^CHOPOFF/).inLibrary).toEqual({
      documentId: document?.id,
      recordId: document?.reference?.id,
    });
    expect(await core.addFoundSource({ key: chopoff.key })).toMatchObject({
      outcome: "document",
      existing: true,
      document: { id: document?.id },
    });
  });

  test("with pages kept as they look by default, a web page it adds is never loaded whole", async () => {
    const asked: string[] = [];
    const pageLook: PageLook = {
      async render(address) {
        asked.push(address);
        return { pdf: new TextEncoder().encode("%PDF-1.7") };
      },
    };
    const { core } = await setUp({ pageLook });
    answerConsent(core);
    await core.updateSettings({ user: { keepWebPageLook: true } });
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));

    const { document } = await add(core, work(result.works, /^CHOPOFF/).key);

    expect(document?.kind).toBe("web");
    expect(document?.web?.look).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a web page that can't be saved leaves the reference record, with its page; tried again, it is saved", async () => {
    const { core, services } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const key = work(result.works, /^CHOPOFF/).key;
    services.fail("files", 403);

    const added = await core.addFoundSource({ key });

    expect(added).toMatchObject({
      outcome: "reference",
      reason: "download-failed",
      landingUrl: `${services.url}/files/chopoff.html`,
      existing: false,
    });
    expect(await core.listDocuments()).toEqual([]);

    // Tried again once the site answers, the page is saved, and the record kept is its record.
    services.fail("files", null);
    const { result: again, document } = await add(core, key);
    expect(again).toMatchObject({ outcome: "document", existing: false });
    expect(document?.reference?.id).toBe(added.outcome === "reference" ? added.recordId : "");
  });

  test("a found paper or web page deleted permanently has its copy removed at once", async () => {
    const { core, dataDir } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "CRISPR off-target detection" }));
    const { document: paper } = await add(
      core,
      work(result.works, /^Improving the sensitivity/).key,
    );
    const { document: page } = await add(core, work(result.works, /^CHOPOFF/).key);
    const ids = [paper?.id ?? "", page?.id ?? ""];
    expect(await readdir(join(dataDir, "Sources"))).toHaveLength(1);
    expect(await readdir(join(dataDir, "Web pages"))).toHaveLength(1);

    for (const id of ids) await core.deleteDocument(id);
    await core.deletePermanently(ids.map((id) => ({ kind: "document" as const, id })));

    expect(await readdir(join(dataDir, "Sources"))).toEqual([]);
    expect(await readdir(join(dataDir, "Web pages"))).toEqual([]);
    // Their rows go too, so nothing is removed again at the next start.
    expect(
      queryDatabase<{ deleted_at: string | null }>(
        dataDir,
        "SELECT deleted_at FROM found_sources WHERE document_id IN (?, ?)",
        ids,
      ).map((row) => row.deleted_at),
    ).toEqual([expect.any(String), expect.any(String)]);
  });

  test("a work not found this session can't be added: search again", async () => {
    const { core } = await setUp();
    expect(await core.addFoundSource({ key: "doi:10.1000/never-found" })).toMatchObject({
      outcome: "failed",
      reason: "not-found",
    });
  });
});

describe("Find sources: the Answer's Tool", { timeout: 30_000 }, () => {
  test("asked to find papers, an Answer searches with find_sources and lists what it found, with no citation marker", async () => {
    let sawSystem = "";
    const model = scriptedModel((call: ModelCall) => {
      sawSystem = call.system;
      const searched = call.results.find((result) => result.tool === "find_sources");
      if (!searched) {
        return {
          calls: [
            {
              tool: "find_sources",
              input: { query: "CRISPR off-target detection", from_year: 2021 },
            },
          ],
        };
      }
      const first = /1\. "([^"]+)"/.exec(searched.text)?.[1] ?? "";
      return { text: `The most relevant paper is ${first}.` };
    });
    const { core, services } = await setUp({
      createChatModel: scriptedModels(model).createChatModel,
    });
    answerConsent(core);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Reading" });
    const client = await connectToMind(core, mind.id);

    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "Find papers since 2021 on CRISPR off-target detection",
    );

    expect(model.doStreamCalls[0]?.tools?.map((each) => each.name)).toEqual(["find_sources"]);
    expect(sawSystem).toMatch(/call find_sources/);
    expect(answerText(client, answerId)).toMatch(/^The most relevant paper is .+\.$/);
    const calls = JSON.parse(
      String(answerIn(client, answerId).attrs.toolCalls),
    ) as AnswerToolCall[];
    expect(calls).toEqual([
      {
        id: expect.any(String),
        tool: "find_sources",
        source: "sources",
        input: { query: "CRISPR off-target detection", from_year: 2021 },
        status: "done",
        resultCount: 9,
      },
    ]);
    expect(searchOf(services, "openalex").get("filter")).toBe("from_publication_date:2021-01-01");
  });

  test("a Question that doesn't ask for papers or sources isn't offered find_sources", async () => {
    const model = scriptedModel(() => ({ text: "OK." }));
    const { core, services } = await setUp({
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Lease" });
    const client = await connectToMind(core, mind.id);

    await askAndFinish(core, client, mind.id, "How much notice must the tenant give?");

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect(services.requests).toEqual([]);
    expect(asksForSources("Find papers since 2021 on CRISPR off-target detection")).toBe(true);
    expect(asksForSources("帮我找几篇关于 CRISPR 脱靶检测的论文")).toBe(true);
    expect(asksForSources("What does the literature say about urban heat islands?")).toBe(true);
    expect(asksForSources("租户需要提前多久通知？")).toBe(false);
    expect(asksForSources("When are the tide tables published?")).toBe(false);
    expect(asksForSources("What does Article 5 of the lease say?")).toBe(false);
    expect(asksForSources("What are the sources of revenue in the report?")).toBe(false);
    expect(asksForSources("Find sources on urban heat islands")).toBe(true);
    expect(asksForSources("Can you search for some recent articles about base editing?")).toBe(
      true,
    );
    expect(asksForSources("帮我查找一些关于城市热岛的资料")).toBe(true);
  });

  test("in local mode, an Answer isn't offered find_sources", async () => {
    const model = scriptedModel(() => ({ text: "OK." }));
    const { core, services } = await setUp({
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await core.setLocalOnly(true);
    const mind = await core.createMind({ title: "Reading" });
    const client = await connectToMind(core, mind.id);

    await askAndFinish(core, client, mind.id, "Find papers on CRISPR off-target detection");

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect(services.requests).toEqual([]);
  });
});

describe("Licences, as providers write them", () => {
  test("an id or a Creative Commons address is a licence; words about reuse are none", () => {
    expect(licenceOf("cc-by-nc-nd")).toEqual({
      id: "cc-by-nc-nd",
      label: "CC BY-NC-ND",
      commercial: false,
    });
    expect(licenceOf("https://creativecommons.org/licenses/by/4.0/")).toEqual({
      id: "cc-by",
      label: "CC BY",
      commercial: true,
    });
    expect(licenceOf("https://creativecommons.org/publicdomain/zero/1.0/")).toMatchObject({
      id: "cc0",
      commercial: true,
    });
    expect(licenceOf("other-oa")).toEqual({ id: "other-oa", label: "other-oa", commercial: null });
    expect(
      licenceOf(
        "This file is available for text mining. It may also be used consistent with the principles of fair use under the copyright law.",
      ),
    ).toBeNull();
    expect(licenceOf(null)).toBeNull();
  });
});

describe("The pace of requests to one service", () => {
  test("a lane runs one request at a time, each the interval after the last ended", async () => {
    const { timers, waits } = virtualTimers();
    const pace = createPace(timers);
    const order: string[] = [];
    const signal = new AbortController().signal;
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        pace.run(
          "arxiv",
          3000,
          async () => {
            order.push(name);
          },
          signal,
        ),
      ),
    );
    await pace.run("other", 3000, async () => order.push("other"), signal);
    expect(order).toEqual(["a", "b", "c", "other"]);
    expect(waits).toEqual([3000, 3000]);
  });
});
