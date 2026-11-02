/**
 * A sentence about a Document's file itself is checked against what the file records about
 * itself (#2458): its own created and modified dates, its author, its page, slide or sheet count,
 * its size and its file name. The model asks for them with its search and names, on its reply's
 * Property line, the properties its sentence states; the rules that hold its result are the
 * core's, whatever the model says.
 */
import { randomUUID } from "node:crypto";
import { utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { corePropertiesXml, docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/** How the scripted model checks a sentence about a file. */
interface Plan {
  /** Its search asks for the file properties: true unless false. */
  properties?: boolean;
  /** The Document its search names. */
  document?: string;
  verdict: "supported" | "unsupported" | "contradicted";
  /** The words it cites, from whichever Passage shown holds them. */
  quote?: string;
  /** What its Property line names; no line when null; "none" when absent. */
  property?: string | null;
  /** Its Property line once asked for it, none before. */
  propertyWhenAsked?: string;
  says?: string;
}

const PROPERTY_ASK = "Your reply has no Property line";

/** A model that checks each sentence as `plans` say: search, cite, then its verdict. */
function propertyModel(plans: Record<string, Plan>, calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (!isCheckRun(call)) throw new Error("Only checks run here.");
      const plan = plans[sentenceOf(call)] ?? { verdict: "unsupported" };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        const input = {
          query: sentenceOf(call),
          ...(plan.properties !== false && { properties: true }),
          ...(plan.document && { document: plan.document }),
        };
        const search = { tool: "search_documents", input };
        // A check in a Note names its sentence's parts in its first turn.
        if (!call.system.includes("Parts:")) return { calls: [search] };
        const parts = [{ kind: "fact", text: sentenceOf(call) }];
        return { text: `Parts: ${JSON.stringify(parts)}`, calls: [search] };
      }
      const shown = searches.flatMap((search) => shownPassages(search.text));
      const { quote } = plan;
      if (quote && !call.results.some((result) => result.tool === "cite")) {
        const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
        const citations = [{ marker: 1, passage: passage?.id, quote }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      const property =
        plan.propertyWhenAsked === undefined
          ? plan.property === undefined
            ? "none"
            : plan.property
          : call.prompt.includes(PROPERTY_ASK)
            ? plan.propertyWhenAsked
            : null;
      const lines = [
        `Verdict: ${plan.verdict}`,
        ...(property === null ? [] : [`Property: ${property}`]),
        "Absence: no",
        ...(plan.says ? [`${plan.says}${quote ? " [^1]" : ""}`] : []),
      ];
      return { text: lines.join("\n") };
    },
    { generate: checkGenerate({}) },
  );
}

const agreement = (core: { modified?: string; created?: string; creator?: string }) =>
  docxOf(
    [
      { text: "Services agreement", heading: 1 },
      { text: "This agreement was signed on 14 March 2026 between Halden Ltd and Orrin plc." },
      { text: "Author: Sam Smith" },
    ],
    { coreXml: corePropertiesXml({ created: "2026-10-01T08:00:00Z", ...core }) },
  );

/** A file to add, and the modified time this computer gives it before it is added. */
interface SourceFile {
  name: string;
  contents: string | Uint8Array;
  touched?: string;
}

/** Adds these files, and checks sentences about them as `plans` say in the interface's `language`. */
async function setUp(
  files: readonly SourceFile[],
  plans: Record<string, Plan>,
  language: Language = "en",
) {
  const calls: ModelCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(propertyModel(plans, calls)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  const paths = await Promise.all(
    files.map(async (file) => {
      const path = await writeSourceFile(sources, file.name, file.contents);
      if (file.touched) await utimes(path, new Date(file.touched), new Date(file.touched));
      return path;
    }),
  );
  const documents = await addAndProcess(core, paths);
  const named = (name: string): Document => {
    const found = documents.find((each) => each.path.endsWith(name));
    if (!found) throw new Error(`No Document of ${name}.`);
    return found;
  };
  /** Every word the check Runs were sent: their instructions, prompts and Tools' results. */
  const sent = () =>
    calls
      .flatMap((call) => [call.system, call.prompt, ...call.results.map((each) => each.text)])
      .join("\n");
  return { core, calls, named, sent };
}

const property = (name: string, value: string) => ({ kind: "properties", property: name, value });

const ISSUE = {
  en: "The file was last modified on 2026-11-02, which is not the agreement's own date.",
  "zh-CN": "该文件最后修改于 2026-11-02，这不是协议本身的日期。",
} as const;

describe.each(["en", "zh-CN"] as const)("a sentence about a Word file's modified date (%s)", (language) => {
  const sentence = ISSUE[language];
  // protects=a sentence about a .docx's modified date is checked against dcterms:modified and cites that property of the Document's own version; fails_when=a check reads only the Passages, and the sentence comes back Unsupported or cites the Document's text.
  test("is Supported by the file's own modified date, and Contradicted by another", async () => {
    const plan = (verdict: Plan["verdict"], quote: string): Record<string, Plan> => ({
      [sentence]: { verdict, quote, property: "modified", says: "The file records when." },
    });
    const right = await setUp(
      [
        {
          name: "Services agreement.docx",
          contents: agreement({ modified: "2026-11-02T09:00:00Z" }),
        },
      ],
      plan("supported", "Modified: 2026-11-02T09:00:00Z"),
      language,
    );
    const document = right.named("Services agreement.docx");

    expect(await right.core.checkClaim({ claim: sentence })).toMatchObject({
      verdict: "supported",
      evidence: {
        documentId: document.id,
        contentHash: document.contentHash,
        check: "found",
        location: property("modified", "2026-11-02T09:00:00Z"),
      },
      versions: [{ documentId: document.id, contentHash: document.contentHash }],
    });
    expect(right.sent()).toContain(`File properties of “${document.name}”`);
    // The time it was added to IncarnaMind is never shown, so it never decides.
    expect(right.sent()).not.toContain(document.createdAt);

    const wrong = await setUp(
      [
        {
          name: "Services agreement.docx",
          contents: agreement({ modified: "2026-10-30T16:45:00Z" }),
        },
      ],
      plan("contradicted", "Modified: 2026-10-30T16:45:00Z"),
      language,
    );
    const contradicted = await wrong.core.checkClaim({ claim: sentence });
    expect(contradicted).toMatchObject({
      verdict: "contradicted",
      evidence: { check: "found", location: property("modified", "2026-10-30T16:45:00Z") },
    });
    // A property's words are never a correction of the sentence's.
    expect(contradicted).not.toHaveProperty("correction");
  });
});

describe("A PDF, a deck and a workbook", () => {
  test("a PDF's modified date comes from its Info dictionary, else its XMP, at the offset it gives", async () => {
    const INFO = "Halden report.pdf was last modified on 2 November 2026.";
    const XMP = "Orrin memo.pdf was last modified on 30 October 2026.";
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:ModifyDate>2026-10-30T23:30:00-08:00</xmp:ModifyDate></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const setup = await setUp(
      [
        {
          name: "Halden report.pdf",
          contents: buildPdf([{ lines: ["Halden annual report"] }, { lines: ["Revenue rose."] }], {
            info: { ModDate: "D:20261102093000+01'00'", Author: "Halden Finance" },
          }),
        },
        { name: "Orrin memo.pdf", contents: buildPdf([{ lines: ["Orrin memo"] }], { xmp }) },
      ],
      {
        [INFO]: {
          verdict: "supported",
          document: "Halden report",
          quote: "Modified: 2026-11-02T09:30:00+01:00",
          property: "modified",
        },
        [XMP]: {
          verdict: "supported",
          document: "Orrin memo",
          quote: "Modified: 2026-10-30T23:30:00-08:00",
          property: "modified",
        },
      },
    );

    expect(await setup.core.checkClaim({ claim: INFO })).toMatchObject({
      verdict: "supported",
      evidence: {
        documentId: setup.named("Halden report.pdf").id,
        location: property("modified", "2026-11-02T09:30:00+01:00"),
      },
    });
    expect(setup.sent()).toContain("Pages: 2");
    expect(setup.sent()).toContain("Author: Halden Finance");
    // Late on 30 October where the file was saved is 31 October in UTC: the file's own day stands.
    expect(await setup.core.checkClaim({ claim: XMP })).toMatchObject({
      verdict: "supported",
      evidence: {
        documentId: setup.named("Orrin memo.pdf").id,
        location: property("modified", "2026-10-30T23:30:00-08:00"),
      },
    });
  });

  test("a deck's slide count counts its hidden slides", async () => {
    const slide = (text: string, attrs?: string) => ({
      shapes: sp({ body: txBody(para(`<a:r><a:t>${text}</a:t></a:r>`)) }),
      ...(attrs && { attrs }),
    });
    const RIGHT = "The Q3 deck has 3 slides.";
    const WRONG = "The Q3 deck has 5 slides.";
    const setup = await setUp(
      [
        {
          name: "Q3 deck.pptx",
          contents: pptxOf({
            slides: [slide("Q3 results"), slide("Backup", 'show="0"'), slide("Questions")],
          }),
        },
      ],
      {
        [RIGHT]: { verdict: "supported", quote: "Slides: 3", property: "slides" },
        [WRONG]: { verdict: "contradicted", quote: "Slides: 3", property: "slides" },
      },
    );

    expect(await setup.core.checkClaim({ claim: RIGHT })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("slides", "3") },
    });
    expect(await setup.core.checkClaim({ claim: WRONG })).toMatchObject({
      verdict: "contradicted",
      evidence: { location: property("slides", "3") },
    });
  });

  test("a workbook's sheets as it lists them, an empty one and a hidden one among them, and its author in Chinese", async () => {
    const SHEETS = "The budget workbook has 3 sheets.";
    const AUTHOR = "预算工作簿的作者是陈静。";
    const setup = await setUp(
      [
        {
          name: "Budget.xlsx",
          contents: xlsxOf(
            [
              { name: "Summary", rows: [["Line", "Amount"], ["Rent", 1200]] },
              { name: "Notes", rows: [] },
              { name: "Workings", rows: [["Draft", 1]], state: "hidden" },
            ],
            { coreXml: corePropertiesXml({ creator: "陈静" }) },
          ),
        },
      ],
      {
        [SHEETS]: { verdict: "supported", quote: "Sheets: 3", property: "sheets" },
        [AUTHOR]: { verdict: "supported", quote: "Author: 陈静", property: "author" },
      },
      "zh-CN",
    );

    expect(await setup.core.checkClaim({ claim: SHEETS })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("sheets", "3") },
    });
    expect(setup.sent()).toContain("Sheets: 3 (1 of them hidden)");
    expect(await setup.core.checkClaim({ claim: AUTHOR })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("author", "陈静") },
    });
  });
});

const COMPUTER_LINE = {
  en: "Only this computer’s date is known: 2 Nov 2026. Copying or downloading a file changes it.",
  "zh-CN": "只有这台电脑记录的日期：2026年11月2日。复制或下载文件会改变这个日期。",
} as const;

describe.each(["en", "zh-CN"] as const)("A file that records no date of its own (%s)", (language) => {
  // protects=this computer's dates never decide: a sentence about a date of a file that records none is Unsupported with the ruled line naming this computer's date, even when the model calls it Supported or Contradicted on that date; fails_when=the file's modified time on this computer backs or contradicts the sentence.
  test("is Unsupported with the line that only this computer's date is known, whatever the model said", async () => {
    const SUPPORTED = "Meeting notes.md was last modified on 2 November 2026.";
    const CONTRADICTED = "Meeting notes.md was last modified on 5 November 2026.";
    const UNSUPPORTED = "Meeting notes.md was last modified in 2026.";
    const onComputer = "Modified on this computer: 2026-11-02T12:00:00.000Z";
    const setup = await setUp(
      [
        {
          name: "Meeting notes.md",
          contents: "# Notes\n\nWe met and agreed the budget.\n",
          touched: "2026-11-02T12:00:00Z",
        },
      ],
      {
        [SUPPORTED]: { verdict: "supported", quote: onComputer, property: "modified" },
        [CONTRADICTED]: { verdict: "contradicted", quote: onComputer, property: "modified" },
        [UNSUPPORTED]: { verdict: "unsupported", property: "modified" },
      },
      language,
    );
    for (const claim of [SUPPORTED, CONTRADICTED, UNSUPPORTED]) {
      const result = await setup.core.checkClaim({ claim });
      expect(result, claim).toMatchObject({
        verdict: "unsupported",
        evidence: null,
        unsupported: { reason: COMPUTER_LINE[language], found: true },
      });
    }
    expect(setup.sent()).toContain(onComputer);
  });
});

describe("What decides a sentence", () => {
  const FILE = "Services agreement.docx";
  const files = () => [
    { name: FILE, contents: agreement({ modified: "2026-11-02T09:00:00Z", creator: "Jo Jones" }) },
  ];
  const MODIFIED = "The agreement's file was last modified on 2 November 2026.";
  const SIGNED = "The agreement was signed on 2 November 2026.";
  const FILE_AUTHOR = "The file's author is Jo Jones.";
  const FILE_AUTHOR_SMITH = "The file's author is Sam Smith.";
  const TEXT_AUTHOR = "The agreement names Sam Smith as its author.";

  // protects=a property decides only a sentence whose Property line names that very property; fails_when=a content sentence is backed by the file's date, or the created date backs a sentence about the modified one.
  test("a property decides only a sentence whose Property line names it", async () => {
    const setup = await setUp(files(), {
      [MODIFIED]: { verdict: "supported", quote: "Modified: 2026-11-02T09:00:00Z", property: "modified" },
      [SIGNED]: { verdict: "supported", quote: "Modified: 2026-11-02T09:00:00Z", property: "none" },
      "The agreement's file was created on 2 November 2026.": {
        verdict: "supported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        property: "created",
      },
    });

    expect(await setup.core.checkClaim({ claim: MODIFIED })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("modified", "2026-11-02T09:00:00Z") },
    });
    expect(await setup.core.checkClaim({ claim: SIGNED })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    expect(
      await setup.core.checkClaim({ claim: "The agreement's file was created on 2 November 2026." }),
    ).toMatchObject({ verdict: "unsupported", evidence: null });
  });

  // protects=a reply with no readable Property line is asked for it once, and a property never decides without one; fails_when=a property backs a sentence with no Property line.
  test("a reply without a Property line is asked for one once; without one, no property decides", async () => {
    const setup = await setUp(files(), {
      [MODIFIED]: {
        verdict: "supported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        propertyWhenAsked: "modified",
      },
      "The file was last saved on 2 November 2026.": {
        verdict: "supported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        property: null,
      },
    });

    expect(await setup.core.checkClaim({ claim: MODIFIED })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("modified", "2026-11-02T09:00:00Z") },
    });
    expect(setup.sent()).toContain(PROPERTY_ASK);
    expect(
      await setup.core.checkClaim({ claim: "The file was last saved on 2 November 2026." }),
    ).toMatchObject({ verdict: "unsupported", evidence: null });
  });

  // protects=a sentence the reply says is about a file property is Supported only with that property's Citation, never by text that looks like one; fails_when=the body's "Author: Sam Smith" backs a sentence about the file's author, who is Jo Jones.
  test("a sentence about a property is Supported only by it; a sentence about the text, by the text", async () => {
    const setup = await setUp(files(), {
      [FILE_AUTHOR]: { verdict: "supported", quote: "Author: Jo Jones", property: "author" },
      [FILE_AUTHOR_SMITH]: { verdict: "supported", quote: "Author: Sam Smith", property: "author" },
      [TEXT_AUTHOR]: { verdict: "supported", quote: "Author: Sam Smith", property: "none" },
    });
    const document = setup.named(FILE);

    expect(await setup.core.checkClaim({ claim: FILE_AUTHOR })).toMatchObject({
      verdict: "supported",
      evidence: { location: property("author", "Jo Jones") },
    });
    expect(await setup.core.checkClaim({ claim: FILE_AUTHOR_SMITH })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    const text = await setup.core.checkClaim({ claim: TEXT_AUTHOR });
    expect(text).toMatchObject({
      verdict: "supported",
      evidence: { documentId: document.id, contentHash: document.contentHash, check: "found" },
    });
    expect(text.verdict === "supported" && text.evidence?.location?.kind).not.toBe("properties");
  });

  // protects=a quote is of a property only on that property's one line; fails_when=the heading, or a quote across two properties, backs a sentence.
  test("a quote of the heading or across two lines is no property", async () => {
    const setup = await setUp(files(), {
      [MODIFIED]: {
        verdict: "supported",
        quote: "File properties of “Services agreement”",
        property: "modified",
      },
      "The file was created on 1 October 2026 and last modified on 2 November 2026.": {
        verdict: "supported",
        quote:
          "Created: 2026-10-01T08:00:00Z (the file’s own date)\nModified: 2026-11-02T09:00:00Z",
        property: "created, modified",
      },
    });

    for (const claim of [
      MODIFIED,
      "The file was created on 1 October 2026 and last modified on 2 November 2026.",
    ]) {
      expect(await setup.core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "unsupported",
        evidence: null,
      });
    }
  });

  test("a search that doesn't ask for them shows no properties, and the sentence is checked as before", async () => {
    const setup = await setUp(files(), {
      [SIGNED]: { verdict: "unsupported", properties: false },
    });

    expect(await setup.core.checkClaim({ claim: SIGNED })).toMatchObject({ verdict: "unsupported" });
    expect(setup.sent()).not.toContain("File properties of");
    expect(setup.sent()).not.toContain("2026-11-02T09:00:00Z");
  });
});

describe("Which Documents' properties a check shows", () => {
  test("a renamed Document's file name is its file's own; a copy re-saved shows its own properties", async () => {
    const NAME = "The draft's file is named Draft v3.docx.";
    const COPY = "Final copy.docx was last modified on 5 November 2026.";
    const setup = await setUp(
      [
        { name: "Draft v3.docx", contents: agreement({ modified: "2026-11-02T09:00:00Z" }) },
        { name: "Final copy.docx", contents: agreement({ modified: "2026-11-05T10:00:00Z" }) },
      ],
      {
        [NAME]: {
          verdict: "supported",
          document: "Services agreement",
          quote: "File name: Draft v3.docx",
          property: "name",
        },
        [COPY]: {
          verdict: "supported",
          document: "Final copy",
          quote: "Modified: 2026-11-05T10:00:00Z",
          property: "modified",
        },
      },
    );
    const draft = setup.named("Draft v3.docx");
    await setup.core.renameDocument(draft.id, "Services agreement");

    expect(await setup.core.checkClaim({ claim: NAME })).toMatchObject({
      verdict: "supported",
      evidence: { documentId: draft.id, location: property("name", "Draft v3.docx") },
    });
    expect(await setup.core.checkClaim({ claim: COPY })).toMatchObject({
      verdict: "supported",
      evidence: {
        documentId: setup.named("Final copy.docx").id,
        location: property("modified", "2026-11-05T10:00:00Z"),
      },
    });
  });

  // protects=properties are Document content: a Document outside the check's scope, or kept as the User's own workings, never shows them; fails_when=a property of a Document the check may not use decides the sentence.
  test("only Documents the check may use show theirs: none outside its scope or kept as workings", async () => {
    const SENTENCE = "Orrin memo.docx was last modified on 5 November 2026.";
    const setup = await setUp(
      [
        { name: "Services agreement.docx", contents: agreement({ modified: "2026-11-02T09:00:00Z" }) },
        { name: "Orrin memo.docx", contents: agreement({ modified: "2026-11-05T10:00:00Z" }) },
      ],
      {
        [SENTENCE]: {
          verdict: "supported",
          quote: "Modified: 2026-11-05T10:00:00Z",
          property: "modified",
        },
      },
    );
    const services = setup.named("Services agreement.docx");
    const memo = setup.named("Orrin memo.docx");
    const scope = { folderIds: [], tagIds: [], documentIds: [services.id] };

    // The quote the model gives is in no Passage it was shown, so nothing backs the sentence.
    expect(await setup.core.checkClaim({ claim: SENTENCE, scope })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(setup.sent()).not.toContain("2026-11-05T10:00:00Z");

    await setup.core.setNotCited(memo.id, true);
    expect(await setup.core.checkClaim({ claim: SENTENCE })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(setup.sent()).not.toContain("2026-11-05T10:00:00Z");

    await setup.core.setNotCited(memo.id, false);
    expect(await setup.core.checkClaim({ claim: SENTENCE })).toMatchObject({
      verdict: "supported",
      evidence: { documentId: memo.id, location: property("modified", "2026-11-05T10:00:00Z") },
    });
  });

  // protects=a Folder that keeps its work inside it keeps property Citations inside it too; fails_when=a Note outside the wall is shown, or cites, the walled Document's properties.
  test("a walled Folder's Documents show theirs only to a Note inside the wall", async () => {
    const SENTENCE = "Client lease.docx was last modified on 2 November 2026.";
    const setup = await setUp(
      [{ name: "Client lease.docx", contents: agreement({ modified: "2026-11-02T09:00:00Z" }) }],
      {
        [SENTENCE]: {
          verdict: "supported",
          quote: "Modified: 2026-11-02T09:00:00Z",
          property: "modified",
        },
      },
    );
    const lease = setup.named("Client lease.docx");
    const client = await setup.core.createLibraryGroup({ name: "Client", description: "" });
    await setup.core.assignDocumentGroup(lease.id, client.id);
    await setup.core.updateLibraryGroup(client.id, {
      name: "Client",
      description: "",
      keepInside: true,
    });
    const checkIn = async (folderId: string | null) => {
      const note = await setup.core.createMind({ title: "Lease note", folderId });
      const mind = await connectToMind(setup.core, note.id);
      writeMind(mind, [
        { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: SENTENCE }] },
      ]);
      await mind.settled();
      await setup.core.checkSentences({
        requestId: `check-${randomUUID()}`,
        mindId: note.id,
        action: "check-against-documents",
        from: { blockId: "one", offset: 0 },
        to: { blockId: "one", offset: SENTENCE.length },
        allDocuments: true,
      });
      await mind.settled();
      const check: ClaimCheckAttributes | undefined = claimSpans(readMind(mind))[0]?.check;
      return check;
    };

    const outside = await checkIn(null);
    expect(outside?.state).not.toBe("supported");
    expect(outside?.evidence ?? null).toBeNull();
    expect(setup.sent()).not.toContain("2026-11-02T09:00:00Z");

    const inside = await checkIn(client.id);
    expect(inside).toMatchObject({
      state: "supported",
      evidence: { documentId: lease.id, location: property("modified", "2026-11-02T09:00:00Z") },
    });
  });
});
