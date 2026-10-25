/**
 * Reference records (#286): each Document's type, title, authors, date,
 * venue, volume, issue, pages, publisher, DOI, URL and language, read from
 * its file offline, edited by the User (edits outlive every later reading),
 * and filled by Look up from Crossref or arXiv, which sends the identifier
 * only, after consent, never in local mode. Through the core's public
 * interface, with small files built here and a local stand-in for the two
 * services: no test reaches the network.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  type Document,
  type ReferenceLookupResult,
} from "../../src/core";
import { METADATA_VERSION } from "../../src/core/documents/processing";
import { webPageReference } from "../../src/core/referenceRecords/read";
import { openDatabase } from "../../src/core/storage";
import { missingDetails } from "../../src/shared/references";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { corePropertiesXml, docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { recordedAnswer, startReferenceServices } from "../helpers/referenceServices";

const NUMPY_DOI = "10.1038/s41586-020-2649-2";
const CHINESE_DOI = "10.5555/chinese-heat-island";

/** XMP metadata as publishers write it: Dublin Core and PRISM properties. */
function xmp(properties: {
  title?: string;
  creators?: string[];
  doi?: string;
  journal?: string;
  volume?: string;
  number?: string;
  startingPage?: string;
  endingPage?: string;
  coverDate?: string;
  language?: string;
}): string {
  const element = (name: string, value: string | undefined) =>
    value === undefined ? "" : `<${name}>${value}</${name}>`;
  const list = (name: string, kind: string, values: string[] | undefined) =>
    values === undefined
      ? ""
      : `<${name}><rdf:${kind}>${values.map((value) => `<rdf:li>${value}</rdf:li>`).join("")}</rdf:${kind}></${name}>`;
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">${
    properties.title === undefined
      ? ""
      : `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${properties.title}</rdf:li></rdf:Alt></dc:title>`
  }${list("dc:creator", "Seq", properties.creators)}${list("dc:language", "Bag", properties.language ? [properties.language] : undefined)}${element("prism:doi", properties.doi)}${element("prism:publicationName", properties.journal)}${element("prism:volume", properties.volume)}${element("prism:number", properties.number)}${element("prism:startingPage", properties.startingPage)}${element("prism:endingPage", properties.endingPage)}${element("prism:coverDate", properties.coverDate)}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

const BOWLER_TITLE =
  "A systematic review of evidence for the added benefits to health of exposure to natural environments";

/** A paper whose publisher filled its XMP. */
const bowlerPdf = (title = BOWLER_TITLE, doi = "10.1186/1471-2458-10-456") =>
  buildPdf(
    [
      { lines: ["Background: There is increasing interest in the potential role of the"] },
      { lines: ["natural environment in human health and well-being."] },
    ],
    {
      xmp: xmp({
        title,
        creators: [
          "Diana E. Bowler",
          "Lisette M. Buyung-Ali",
          "Teri M. Knight",
          "Andrew S. Pullin",
        ],
        doi,
        journal: "BMC Public Health",
        volume: "10",
        number: "1",
        startingPage: "456",
        coverDate: "2010-08-04",
      }),
    },
  );

/**
 * A paper with no metadata of its own, but its DOI printed on its first page,
 * in the running header every page repeats (which the stored text leaves out).
 */
const numpyPdf = () =>
  buildPdf(
    [1, 2, 3].map((page) => ({
      lines: [
        `Nature | Vol 585 | https://doi.org/${NUMPY_DOI} | ${356 + page}`,
        page === 1 ? "Array programming with NumPy" : "Methods and results, continued.",
        "Array programming provides a powerful, compact and expressive syntax for accessing data.",
      ],
    })),
    { info: { Title: "Microsoft Word - numpy_final_v3.docx", Author: "Administrator" } },
  );

/** A Chinese paper: its title and authors in its Info dictionary, written in UTF-16. */
const chinesePdf = () =>
  buildPdf(
    [
      {
        chineseLines: [
          "城市绿地对热岛效应的缓解作用",
          "张三，李四，欧阳明",
          "摘要：本文研究了城市绿地对夏季夜间热岛效应的影响。",
          "关键词：城市热岛；绿地；夜间降温",
        ],
        lines: [`DOI: ${CHINESE_DOI}`],
      },
    ],
    { info: { Title: "城市绿地对热岛效应的缓解作用", Author: "张三；李四；欧阳明" } },
  );

/** A preprint, as arXiv stamps its first page. */
const attentionPdf = () =>
  buildPdf([
    {
      lines: [
        "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023",
        "Attention Is All You Need",
        "The dominant sequence transduction models are based on complex recurrent networks.",
      ],
    },
  ]);

/** Adds these files, built above, and returns their Documents once processed, by file name. */
async function addFiles(core: Core, files: Record<string, string | Uint8Array>) {
  const sources = await createSourceFolder();
  const paths: Record<string, string> = {};
  for (const [name, contents] of Object.entries(files)) {
    paths[name] = await writeSourceFile(sources, name, contents);
  }
  const documents = await addAndProcess(core, Object.values(paths));
  const byName: Record<string, Document> = {};
  for (const [name, path] of Object.entries(paths)) {
    byName[name] = documents.find((document) => document.path === path) as Document;
  }
  return { documents: byName, paths };
}

async function startWithServices() {
  const services = await startReferenceServices({
    crossref: {
      [NUMPY_DOI]: recordedAnswer("crossref-numpy.json"),
      [CHINESE_DOI]: recordedAnswer("crossref-chinese.json"),
    },
    arxiv: { "1706.03762": recordedAnswer("arxiv-attention.xml") },
  });
  onTestFinished(() => services.close());
  const core = startCore(await createTempDataFolder(), {
    referenceLookup: { crossref: services.url, arxiv: services.url },
  });
  return { core, services };
}

/** Looks a Document up, answering the consent request it raises (if any) with `allow`. */
async function lookUp(core: Core, documentId: string, allow: boolean) {
  const stop = core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, allow);
  });
  try {
    return await core.lookUpReference(documentId);
  } finally {
    stop();
  }
}

const filled = (result: ReferenceLookupResult) => {
  if (result.outcome !== "filled") throw new Error(`Look up failed: ${result.message}`);
  return result;
};

describe("Reference records, read from the file", () => {
  test("a PDF's XMP gives its title, its authors in order, date, journal, volume, issue, pages and DOI", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, { "Bowler 2010.pdf": bowlerPdf() });

    const record = documents["Bowler 2010.pdf"]?.reference;
    expect(record?.fields).toEqual({
      type: "article-journal",
      title: BOWLER_TITLE,
      authors: [
        { family: "Bowler", given: "Diana E." },
        { family: "Buyung-Ali", given: "Lisette M." },
        { family: "Knight", given: "Teri M." },
        { family: "Pullin", given: "Andrew S." },
      ],
      issued: "2010-08-04",
      containerTitle: "BMC Public Health",
      volume: "10",
      issue: "1",
      pages: "456",
      publisher: "",
      doi: "10.1186/1471-2458-10-456",
      url: "",
      language: "en",
    });
    expect(record?.sources).toMatchObject({ title: "file", authors: "file", doi: "file" });
    expect(missingDetails(record as NonNullable<typeof record>)).toEqual([]);
  });

  test("a DOI printed on page 1, even in a running header, makes a journal article that needs details", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, { "s41586-020-2649-2.pdf": numpyPdf() });

    const record = documents["s41586-020-2649-2.pdf"]?.reference;
    // Software's title and author ("Microsoft Word - …", "Administrator") are no one's.
    expect(record?.fields).toMatchObject({
      type: "article-journal",
      title: "",
      authors: [],
      doi: NUMPY_DOI,
      language: "en",
    });
    expect(missingDetails(record as NonNullable<typeof record>)).toEqual([
      "title",
      "authors",
      "issued",
    ]);
  });

  test("a Word file's properties give its title, author and language", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, {
      "Field Methods.docx": docxOf(
        [
          { text: "Field methods", heading: 1 },
          { text: "How the sensors were placed in each park, and read every night." },
        ],
        {
          coreXml: corePropertiesXml({
            title: "Field methods for urban heat measurements",
            creator: "Morgan Lee",
            language: "en-GB",
          }),
        },
      ),
    });

    expect(documents["Field Methods.docx"]?.reference?.fields).toMatchObject({
      type: "document",
      title: "Field methods for urban heat measurements",
      authors: [{ family: "Lee", given: "Morgan" }],
      language: "en-GB",
    });
  });

  test("a Chinese paper keeps its authors whole, family name first, in their order", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, {
      "城市热岛.pdf": chinesePdf(),
      "城市热岛 XMP.pdf": buildPdf([{ chineseLines: ["城市绿地对热岛效应的缓解作用"] }], {
        xmp: xmp({ title: "城市绿地对热岛效应的缓解作用", creators: ["张三", "李四", "欧阳明"] }),
      }),
    });

    const authors = [{ literal: "张三" }, { literal: "李四" }, { literal: "欧阳明" }];
    expect(documents["城市热岛.pdf"]?.reference?.fields).toMatchObject({
      type: "article-journal",
      title: "城市绿地对热岛效应的缓解作用",
      authors,
      doi: CHINESE_DOI,
      language: "zh",
    });
    expect(documents["城市热岛 XMP.pdf"]?.reference?.fields).toMatchObject({
      title: "城市绿地对热岛效应的缓解作用",
      authors,
      language: "zh",
    });
  });

  test("an arXiv id on page 1 makes a preprint, with its arXiv address", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, { "attention.pdf": attentionPdf() });

    expect(documents["attention.pdf"]?.reference?.fields).toMatchObject({
      type: "article",
      url: "https://arxiv.org/abs/1706.03762",
      doi: "",
    });
  });

  test("a file that says nothing of itself is Other, which never needs details", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, {
      "Aldermoor MSA.pdf": buildPdf([
        { lines: ["MASTER SERVICES AGREEMENT", "This agreement is made between the parties."] },
      ]),
      "Notes.md": "# Shortlist\n\nCold-chain carriers to call on Thursday.\n",
    });

    for (const document of Object.values(documents)) {
      const record = document.reference;
      expect(record?.fields.type).toBe("document");
      expect(missingDetails(record as NonNullable<typeof record>)).toEqual([]);
    }
  });

  test("a web page gives its title, author, site, date and address (#261)", () => {
    const read = webPageReference(
      {
        address: "https://www.example.org/news/park-cooling",
        siteName: "Example News",
        author: "Priya Shah and Tom Okafor",
        published: "2026-05-14T08:30:00+01:00",
      },
      "Parks cool cities at night",
    );
    expect(read).toEqual({
      type: "webpage",
      title: "Parks cool cities at night",
      authors: [
        { family: "Shah", given: "Priya" },
        { family: "Okafor", given: "Tom" },
      ],
      issued: "2026-05-14",
      containerTitle: "Example News",
      url: "https://www.example.org/news/park-cooling",
    });
    expect(
      webPageReference(
        {
          address: "https://www.example.cn/a",
          siteName: "示例网",
          author: "王五",
          published: null,
        },
        "夜间降温",
      ),
    ).toMatchObject({ authors: [{ literal: "王五" }], containerTitle: "示例网" });
  });

  test("Documents indexed before reference records get theirs once, in the background", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const { documents } = await addFiles(first, { "s41586-020-2649-2.pdf": numpyPdf() });
    const id = documents["s41586-020-2649-2.pdf"]?.id as string;
    first.close();
    // As a database from before migration 42 leaves them: read by an older metadata version, no record.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("DELETE FROM reference_records");
    db.run("UPDATE documents SET metadata_version = ?", [BigInt(METADATA_VERSION - 1)]);
    db.close();

    const core = startCore(dataDir);
    const [read] = await waitForDocuments(core, (list) => {
      expect(list[0]?.reference).not.toBeNull();
    });
    expect(read?.id).toBe(id);
    // Its first page is read again as extracted: the DOI in the running header is found.
    expect(read?.reference?.fields.doi).toBe(NUMPY_DOI);
    expect(read?.contentHash).toBe(sha256(numpyPdf()));
  });
});

describe("Editing a reference record", () => {
  test("an edited field is the User's: reading a new version of the file never replaces it", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents, paths } = await addFiles(core, { "Bowler 2010.pdf": bowlerPdf() });
    const id = documents["Bowler 2010.pdf"]?.id as string;

    const changed = nextEvent(core, "references.changed");
    const edited = await core.updateReference(id, {
      title: "Health benefits of natural environments: a systematic review",
      authors: [],
    });
    expect((await changed).map((document) => document.id)).toEqual([id]);
    expect(edited.reference?.fields.title).toBe(
      "Health benefits of natural environments: a systematic review",
    );
    expect(edited.reference?.sources).toMatchObject({ title: "user", authors: "user" });

    // A new version, with another title and DOI in its XMP.
    const next = bowlerPdf("Another title entirely", "10.1186/1471-2458-10-999");
    await writeFile(paths["Bowler 2010.pdf"] as string, next);
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [id]);
    expect(processed?.contentHash).toBe(sha256(next));

    expect(processed?.reference?.fields).toMatchObject({
      // The User's: kept, the cleared authors too.
      title: "Health benefits of natural environments: a systematic review",
      authors: [],
      // The file's: this version's.
      doi: "10.1186/1471-2458-10-999",
      containerTitle: "BMC Public Health",
    });
  });

  test("what the User types is checked: a DOI loses its address, a date reads as written", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, { "attention.pdf": attentionPdf() });
    const id = documents["attention.pdf"]?.id as string;

    const edited = await core.updateReference(id, {
      doi: "https://doi.org/10.48550/arXiv.1706.03762.",
      issued: "2017年6月12日",
      url: "arxiv.org/abs/1706.03762",
      authors: [{ family: " Vaswani ", given: " Ashish" }, { literal: "  " }],
    });
    expect(edited.reference?.fields).toMatchObject({
      doi: "10.48550/arXiv.1706.03762",
      issued: "2017-06-12",
      url: "https://arxiv.org/abs/1706.03762",
      authors: [{ family: "Vaswani", given: "Ashish" }],
    });

    await expect(core.updateReference(id, { issued: "next spring" })).rejects.toThrow(/date/);
    await expect(core.updateReference(id, { doi: "not a doi" })).rejects.toThrow(/DOI/);
    await expect(core.updateReference(id, { type: "poem" as never })).rejects.toThrow();
    await expect(core.updateReference(id, { colour: "red" } as never)).rejects.toThrow();
  });

  test("Undo puts fields back as they were, with where each came from", async () => {
    const core = startCore(await createTempDataFolder());
    const { documents } = await addFiles(core, { "Bowler 2010.pdf": bowlerPdf() });
    const document = documents["Bowler 2010.pdf"] as Document;
    const before = document.reference;
    if (!before) throw new Error("No record was read.");

    await core.updateReference(document.id, { title: "Wrong", publisher: "BioMed Central" });
    const restored = await core.restoreReference(document.id, before, ["title", "publisher"]);

    expect(restored.reference?.fields).toEqual(before.fields);
    expect(restored.reference?.sources).toEqual(before.sources);

    // A record that couldn't have been: nothing is put back from it.
    const malformed = {
      ...before,
      fields: { ...before.fields, authors: "Bowler" },
      sources: { ...before.sources, authors: "user" },
    };
    await expect(
      core.restoreReference(document.id, malformed as never, ["authors"]),
    ).rejects.toThrow(/authors/);
    await expect(
      core.restoreReference(
        document.id,
        { ...before, sources: { ...before.sources, title: "guess" } } as never,
        ["title"],
      ),
    ).rejects.toThrow(/title/);
    expect((await core.listDocuments())[0]?.reference?.fields).toEqual(before.fields);
  });
});

describe("Look up", () => {
  test("nothing is sent without consent, and a declined Look up sends nothing later either", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, { "s41586-020-2649-2.pdf": numpyPdf() });
    const id = documents["s41586-020-2649-2.pdf"]?.id as string;

    const requested = nextEvent(core, "consent.requested");
    const result = core.lookUpReference(id);
    const request = await requested;
    // The dialog says what goes where: the identifier only, to Crossref.
    expect(request.flow).toEqual({
      id: "reference-lookup",
      service: { id: "https://api.crossref.org", name: "Crossref" },
      sends: ["identifiers"],
    });
    expect(services.requests).toEqual([]);

    await core.respondToConsent(request.requestId, false);
    expect(await result).toMatchObject({ outcome: "failed", reason: "declined" });
    expect(await lookUp(core, id, true)).toMatchObject({ outcome: "failed", reason: "declined" });
    expect(services.requests).toEqual([]);
    expect((await core.listDocuments())[0]?.reference?.fields.title).toBe("");
  });

  test("with consent, it fills the empty fields and leaves the edited ones, sending only the DOI", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, { "s41586-020-2649-2.pdf": numpyPdf() });
    const id = documents["s41586-020-2649-2.pdf"]?.id as string;
    await core.updateReference(id, { containerTitle: "Nature (London)", pages: "" });

    const result = filled(await lookUp(core, id, true));

    expect(result.service).toEqual({ id: "https://api.crossref.org", name: "Crossref" });
    expect(result.document.reference?.fields).toEqual({
      type: "article-journal",
      title: "Array programming with NumPy",
      authors: [
        { family: "Harris", given: "Charles R." },
        { family: "Millman", given: "K. Jarrod" },
        { family: "van der Walt", given: "Stéfan J." },
        { family: "Gommers", given: "Ralf" },
      ],
      issued: "2020-09-16",
      // The User's edit stays.
      containerTitle: "Nature (London)",
      volume: "585",
      issue: "7825",
      // Cleared by the User: an empty field, so Look up fills it.
      pages: "357–362",
      publisher: "Springer Science and Business Media LLC",
      doi: NUMPY_DOI,
      url: "",
      language: "en",
    });
    expect(result.filled.sort()).toEqual(
      ["title", "authors", "issued", "volume", "issue", "pages", "publisher"].sort(),
    );
    expect(result.document.reference?.sources).toMatchObject({
      title: "lookup",
      containerTitle: "user",
      doi: "file",
    });
    expect(result.document.reference?.lookedUpAt).not.toBeNull();
    expect(missingDetails(result.document.reference as NonNullable<Document["reference"]>)).toEqual(
      [],
    );
    // One GET, with the DOI in its address and nothing else.
    expect(services.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/works/${encodeURIComponent(NUMPY_DOI)}`,
        bodyLength: 0,
      }),
    ]);

    // Asked once: the next Look up asks nothing.
    let asked = false;
    core.on("consent.requested", () => {
      asked = true;
    });
    expect(filled(await core.lookUpReference(id)).filled).toEqual([]);
    expect(asked).toBe(false);
  });

  test("a preprint is looked up at arXiv, by its arXiv id", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, { "attention.pdf": attentionPdf() });
    const id = documents["attention.pdf"]?.id as string;

    const result = filled(await lookUp(core, id, true));

    expect(result.service).toEqual({ id: "https://export.arxiv.org", name: "arXiv" });
    expect(result.document.reference?.fields).toMatchObject({
      type: "article",
      title: "Attention Is All You Need",
      authors: [
        { family: "Vaswani", given: "Ashish" },
        { family: "Shazeer", given: "Noam" },
        { family: "Parmar", given: "Niki" },
      ],
      issued: "2017-06-12",
      publisher: "arXiv",
      doi: "10.48550/arXiv.1706.03762",
      url: "https://arxiv.org/abs/1706.03762",
    });
    expect(services.requests.map((request) => request.path)).toEqual([
      "/api/query?id_list=1706.03762&max_results=1",
    ]);
  });

  test("Chinese names Crossref gives in parts stay whole, family name first, in order", async () => {
    const { core } = await startWithServices();
    const { documents } = await addFiles(core, {
      "热岛.pdf": buildPdf([{ lines: [`DOI: ${CHINESE_DOI}`] }]),
    });
    const id = documents["热岛.pdf"]?.id as string;

    const result = filled(await lookUp(core, id, true));

    expect(result.document.reference?.fields).toMatchObject({
      title: "城市绿地对热岛效应的缓解作用",
      authors: [{ literal: "张三" }, { literal: "李四" }, { literal: "欧阳明" }],
      issued: "2020-01",
      containerTitle: "地理学报",
      pages: "61–74",
    });
    // A DOI's own address isn't kept as the URL.
    expect(result.document.reference?.fields.url).toBe("");
  });

  test("the type read from the file is a guess the service corrects, but the User's choice stays", async () => {
    const chapter = JSON.stringify({
      status: "ok",
      message: {
        type: "book-chapter",
        DOI: "10.5555/a-chapter",
        title: ["Parks and the urban heat island"],
        "container-title": ["Urban Climates"],
      },
    });
    const services = await startReferenceServices({
      crossref: { "10.5555/a-chapter": chapter, "10.5555/b-chapter": chapter },
    });
    onTestFinished(() => services.close());
    const core = startCore(await createTempDataFolder(), {
      referenceLookup: { crossref: services.url, arxiv: services.url },
    });
    const { documents } = await addFiles(core, {
      "guessed.pdf": buildPdf([{ lines: ["DOI: 10.5555/a-chapter"] }]),
      "chosen.pdf": buildPdf([{ lines: ["DOI: 10.5555/b-chapter"] }]),
    });
    const guessed = documents["guessed.pdf"] as Document;
    const chosen = documents["chosen.pdf"] as Document;
    expect(guessed.reference?.fields.type).toBe("article-journal");
    await core.updateReference(chosen.id, { type: "report" });

    const corrected = filled(await lookUp(core, guessed.id, true));
    expect(corrected.document.reference?.fields.type).toBe("chapter");
    expect(corrected.document.reference?.sources.type).toBe("lookup");
    expect(corrected.filled).toContain("type");

    const kept = filled(await lookUp(core, chosen.id, true));
    expect(kept.document.reference?.fields.type).toBe("report");
    expect(kept.document.reference?.sources.type).toBe("user");
    expect(kept.filled).not.toContain("type");
  });

  test("in local mode it sends nothing and asks nothing", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, { "s41586-020-2649-2.pdf": numpyPdf() });
    await core.setLocalOnly(true);
    let asked = false;
    core.on("consent.requested", () => {
      asked = true;
    });

    const result = await core.lookUpReference(documents["s41586-020-2649-2.pdf"]?.id as string);

    expect(result).toMatchObject({ outcome: "failed", reason: "local-mode" });
    expect(asked).toBe(false);
    expect(services.requests).toEqual([]);
  });

  test("local mode turned on while it waits for consent: the prompt closes, it says local mode, and nothing is sent", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, { "s41586-020-2649-2.pdf": numpyPdf() });
    const requested = nextEvent(core, "consent.requested");
    const result = core.lookUpReference(documents["s41586-020-2649-2.pdf"]?.id as string);
    const request = await requested;
    const closed = nextEvent(core, "consent.resolved");

    await core.setLocalOnly(true);

    expect(await closed).toEqual({ requestId: request.requestId, accepted: false });
    expect(await result).toMatchObject({ outcome: "failed", reason: "local-mode" });
    await core.respondToConsent(request.requestId, true);
    expect(services.requests).toEqual([]);
    expect(await core.listDataFlows()).not.toContainEqual(
      expect.objectContaining({ flow: expect.objectContaining({ id: "reference-lookup" }) }),
    );
  });

  test("an unknown DOI, a service that fails, or no identifier says so and changes nothing", async () => {
    const { core, services } = await startWithServices();
    const { documents } = await addFiles(core, {
      "unknown.pdf": buildPdf([{ lines: ["DOI: 10.5555/not-registered"] }]),
      "Aldermoor MSA.pdf": buildPdf([{ lines: ["MASTER SERVICES AGREEMENT"] }]),
    });
    const unknown = documents["unknown.pdf"] as Document;

    expect(await lookUp(core, unknown.id, true)).toMatchObject({
      outcome: "failed",
      reason: "not-found",
    });
    services.fail(503);
    expect(await lookUp(core, unknown.id, true)).toMatchObject({
      outcome: "failed",
      reason: "service-error",
    });
    expect(await lookUp(core, (documents["Aldermoor MSA.pdf"] as Document).id, true)).toMatchObject(
      { outcome: "failed", reason: "no-identifier" },
    );
    const after = (await core.listDocuments()).find((document) => document.id === unknown.id);
    expect(after?.reference?.fields).toEqual(unknown.reference?.fields);
  });
});
