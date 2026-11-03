/**
 * A sentence about a Document's file itself is checked against what the file records about
 * itself (#2458): its own created and modified dates, its author, its page, slide or sheet count,
 * its size and its file name. The model asks for them with its search and names, on its reply's
 * Property line, the properties its sentence states; the rules that hold its result are the
 * core's, whatever the model says.
 */
import { randomUUID } from "node:crypto";
import { utimes } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { ClaimCheckAttributes, Core, Document } from "../../src/core";
import { declaredProperties } from "../../src/core/answers/checks/fileProperties";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, isCheckRun, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { corePropertiesXml, docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";
import { transcribingCore } from "../helpers/transcription";

/** How the scripted model checks a sentence about a file. */
interface Plan {
  /** Its search asks for the file properties: true unless false. */
  properties?: boolean;
  /** Its search's words: the sentence's unless given. */
  query?: string;
  /** It searches the same words without the file properties first. */
  searchesTextFirst?: boolean;
  /** After its first search, it searches for this other Document's properties too. */
  alsoNames?: string;
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
  /** For contradicted: the sentence's words to change, and to what, from its quote. */
  change?: [string, string];
  /** For unsupported: what its quote covers of the sentence, and what it doesn't. */
  covered?: [string, string];
}

const PROPERTY_ASK = "Your reply has no Property line";

/** A model that checks each sentence as `plans` say: search, cite, then its verdict. */
function propertyModel(plans: Record<string, Plan>, calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      // A Meeting's notes are filled by the model too: it writes none.
      if (!isCheckRun(call)) return { text: "" };
      const plan = plans[sentenceOf(call)] ?? { verdict: "unsupported" };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      const first = searches.length === 0;
      const again = searches.length === 1 && (plan.searchesTextFirst || plan.alsoNames);
      if (first || again) {
        const document = again && plan.alsoNames ? plan.alsoNames : plan.document;
        const input = {
          query: plan.query ?? sentenceOf(call),
          ...(plan.properties !== false &&
            !(plan.searchesTextFirst && first) && { properties: true }),
          ...(document && { document }),
        };
        const search = { tool: "search_documents", input };
        // A check in a Note names its sentence's parts in its first turn.
        if (!first || !call.system.includes("Parts:")) return { calls: [search] };
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
        "Topic: found",
        ...(plan.says ? [`${plan.says}${quote ? " [^1]" : ""}`] : []),
        ...(plan.change ? [`Change 1: ${plan.change[0]}`, `To 1: ${plan.change[1]} [^1]`] : []),
        ...(plan.covered ? [`Covered: ${plan.covered[0]}`, `Not covered: ${plan.covered[1]}`] : []),
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
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
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
  return { core, dataDir, calls, named, sent };
}

const property = (name: string, value: string) => ({ kind: "properties", property: name, value });

/** Writes `sentence` in a new Note in `folderId` and checks it there, as Check against Documents does. */
async function checkInNote(core: Core, sentence: string, folderId: string | null) {
  const note = await core.createMind({ title: "Lease note", folderId });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
  ]);
  await mind.settled();
  await core.checkSentences({
    requestId: `check-${randomUUID()}`,
    mindId: note.id,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: sentence.length },
    allDocuments: true,
  });
  await mind.settled();
  const check: ClaimCheckAttributes | undefined = claimSpans(readMind(mind))[0]?.check;
  return { check, noteId: note.id };
}

const ISSUE = {
  en: "The file was last modified on 2026-11-02, which is not the agreement's own date.",
  "zh-CN": "该文件最后修改于 2026-11-02，这不是协议本身的日期。",
} as const;

describe.each(["en", "zh-CN"] as const)(
  "a sentence about a Word file's modified date (%s)",
  (language) => {
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
        // What the Document says is the reply's sentence, never its Property line.
        says: "The file records when.",
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
        {
          [sentence]: {
            ...plan("contradicted", "Modified: 2026-10-30T16:45:00Z")[sentence],
            verdict: "contradicted",
            change: ["2026-11-02", "2026-10-30T16:45:00Z"],
          },
        },
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
  },
);

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
              {
                name: "Summary",
                rows: [
                  ["Line", "Amount"],
                  ["Rent", 1200],
                ],
              },
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

describe.each(["en", "zh-CN"] as const)(
  "A file that records no date of its own (%s)",
  (language) => {
    // protects=this computer's dates never decide: a sentence about a date of a file that records none is Unsupported with the ruled line naming this computer's date, even when the model calls it Supported or Contradicted on that date; fails_when=the file's modified time on this computer backs or contradicts the sentence.
    test("is Unsupported with the line that only this computer's date is known, whatever the model said", async () => {
      const SUPPORTED = "Meeting notes.md was last modified on 2 November 2026.";
      const CONTRADICTED = "Meeting notes.md was last modified on 25 October 2026.";
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
  },
);

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
      [MODIFIED]: {
        verdict: "supported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        property: "modified",
      },
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
    // Nor does the Note's mark keep it anywhere, a part's row included: it backs nothing here.
    const { check: marked } = await checkInNote(setup.core, SIGNED, null);
    expect(marked?.state).toBe("unsupported");
    expect(JSON.stringify(marked)).not.toContain('"kind":"properties"');
    expect(
      await setup.core.checkClaim({
        claim: "The agreement's file was created on 2 November 2026.",
      }),
    ).toMatchObject({ verdict: "unsupported", evidence: null });
  });

  // protects=a sentence the reply says is about a file property is Contradicted only by that property, never by the Document's text that looks like one; fails_when=a footer's "Last revised" date contradicts a sentence about the file's own modified date.
  test("a sentence about a property is Contradicted only by it, not by a date its text gives", async () => {
    const FOOTER = "Last revised 30 October 2026";
    const BY_TEXT = "The agreement file was last modified on 1 November 2026.";
    const BY_PROPERTY = "The agreement file was last modified on 3 November 2026.";
    const setup = await setUp(
      [
        {
          name: FILE,
          contents: docxOf([{ text: "Services agreement" }, { text: FOOTER }], {
            coreXml: corePropertiesXml({ modified: "2026-11-02T09:00:00Z" }),
          }),
        },
      ],
      {
        [BY_TEXT]: { verdict: "contradicted", quote: FOOTER, property: "modified" },
        [BY_PROPERTY]: {
          verdict: "contradicted",
          quote: "Modified: 2026-11-02T09:00:00Z",
          property: "modified",
        },
      },
    );

    expect(await setup.core.checkClaim({ claim: BY_TEXT })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    expect(await setup.core.checkClaim({ claim: BY_PROPERTY })).toMatchObject({
      verdict: "contradicted",
      evidence: { location: property("modified", "2026-11-02T09:00:00Z") },
    });
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
      "The file was created on 1 October 2026.": {
        verdict: "supported",
        quote: "2026-10-01T08:00:00Z (the file’s own date)\nModified: 2026-11-02T09:00:00Z",
        property: "created",
      },
    });

    for (const claim of [MODIFIED, "The file was created on 1 October 2026."]) {
      expect(await setup.core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "unsupported",
        evidence: null,
      });
    }
    // Both quotes are word for word in the properties shown: they are only of no one property.
    expect(setup.sent()).toContain("Recorded [^1].");
    expect(setup.sent()).not.toContain("isn't word for word");
  });

  // protects=a property's words are never offered as the sentence's correction: Fix would put the file's property in the Note as a Document's words; fails_when=a Contradicted sentence about the file's slides offers "3" from the file's properties as its fix.
  test("a sentence a property contradicts is offered no correction from it", async () => {
    const WRONG_COUNT = "The deck has 5 slides.";
    const slide = { shapes: sp({ body: txBody(para("<a:r><a:t>Plan</a:t></a:r>")) }) };
    const setup = await setUp(
      [{ name: "Plan.pptx", contents: pptxOf({ slides: [slide, slide, slide] }) }],
      {
        [WRONG_COUNT]: {
          verdict: "contradicted",
          quote: "Slides: 3",
          property: "slides",
          says: "The file has 3 slides.",
          change: ["5", "3"],
        },
      },
    );

    const contradicted = await setup.core.checkClaim({ claim: WRONG_COUNT });
    expect(contradicted).toMatchObject({
      verdict: "contradicted",
      evidence: { location: property("slides", "3") },
    });
    expect(contradicted).not.toHaveProperty("correction");
  });

  // protects=an Unsupported sentence shows a property as its nearest line, or as the part it covers, only when its Property line names that property; fails_when=the file's modified date is shown as "the Documents say something different" for when the agreement was signed.
  test("a property is a nearest line or a covered part only of a sentence about it", async () => {
    const NEAR_TEXT = "The agreement was signed on 3 November 2026.";
    // Its words are nearest the Modified line, though the reply says it is about the text.
    const NEAR_PROPERTY = "The agreement's date in the file is 2026-11-03, as modified.";
    const BY_WHOM = "The file was last modified on 2 November 2026 by its third reviewer.";
    const SIGNED_ALSO = "The agreement was signed on 2 November 2026, as its file's date shows.";
    const plans: Record<string, Plan> = {
      [NEAR_TEXT]: { verdict: "unsupported", property: "none" },
      [NEAR_PROPERTY]: { verdict: "unsupported", property: "none" },
      [BY_WHOM]: {
        verdict: "unsupported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        property: "modified",
        covered: ["the modified date", "the third reviewer"],
      },
      [SIGNED_ALSO]: {
        verdict: "unsupported",
        quote: "Modified: 2026-11-02T09:00:00Z",
        property: "none",
        covered: ["the date", "the signing"],
      },
    };
    const setup = await setUp(files(), plans);
    const document = setup.named(FILE);

    expect(await setup.core.checkClaim({ claim: NEAR_TEXT })).toMatchObject({
      verdict: "unsupported",
      evidence: { documentId: document.id, contentHash: document.contentHash, check: "found" },
    });
    expect(setup.sent()).toContain("Modified: 2026-11-02T09:00:00Z");
    expect(await setup.core.checkClaim({ claim: NEAR_PROPERTY })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    expect(await setup.core.checkClaim({ claim: BY_WHOM })).toMatchObject({
      verdict: "unsupported",
      unsupported: { quoted: { location: property("modified", "2026-11-02T09:00:00Z") } },
    });
    const signed = await setup.core.checkClaim({ claim: SIGNED_ALSO });
    expect(signed).toMatchObject({
      verdict: "unsupported",
      unsupported: { covered: null, uncovered: null },
    });
    expect(signed.verdict === "unsupported" && signed.unsupported).not.toHaveProperty("quoted");
    expect(signed.verdict === "unsupported" && signed.unsupported).not.toHaveProperty("found");
  });

  test("a search that doesn't ask for them shows no properties, and the sentence is checked as before", async () => {
    const setup = await setUp(files(), {
      [SIGNED]: { verdict: "unsupported", properties: false },
    });

    expect(await setup.core.checkClaim({ claim: SIGNED })).toMatchObject({
      verdict: "unsupported",
    });
    expect(setup.sent()).not.toContain("File properties of");
    expect(setup.sent()).not.toContain("2026-11-02T09:00:00Z");
  });
});

describe("Which Documents' properties a check shows", () => {
  test("a renamed Document's file name is its file's own; a copy re-saved shows its own properties", async () => {
    const NAME = "The draft's file is named Draft v3.docx.";
    const COPY = "Final copy.docx was last modified on 25 October 2026.";
    const setup = await setUp(
      [
        { name: "Draft v3.docx", contents: agreement({ modified: "2026-11-02T09:00:00Z" }) },
        { name: "Final copy.docx", contents: agreement({ modified: "2026-10-25T10:00:00Z" }) },
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
          quote: "Modified: 2026-10-25T10:00:00Z",
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
        location: property("modified", "2026-10-25T10:00:00Z"),
      },
    });
  });

  // protects=the line that only this computer's date is known names a date only when the Run was shown one Document's properties: never another file's; fails_when=a sentence about a PDF with no modified date says only this computer's date is known, giving the notes file's.
  test("a Run shown two files' properties never gives one's computer date for the other", async () => {
    const SENTENCE = "Report.pdf was last modified on 2 November 2026.";
    const setup = await setUp(
      [
        {
          name: "Report.pdf",
          contents: buildPdf([{ lines: ["Report"] }], { info: { CreationDate: "D:20261001" } }),
        },
        { name: "Site notes.md", contents: "# Notes\n", touched: "2026-10-28T12:00:00Z" },
      ],
      {
        [SENTENCE]: {
          verdict: "unsupported",
          document: "Site notes",
          alsoNames: "Report",
          property: "modified",
        },
        "Site notes.md was last modified on 2 November 2026.": {
          verdict: "unsupported",
          document: "Site notes",
          property: "modified",
        },
      },
    );

    const report = await setup.core.checkClaim({ claim: SENTENCE });
    expect(setup.sent()).toContain("File properties of “Report”");
    expect(setup.sent()).toContain("File properties of “Site notes”");
    expect(report).toMatchObject({ verdict: "unsupported" });
    const reason = report.verdict === "unsupported" ? report.unsupported?.reason : null;
    expect(reason ?? "").not.toContain("this computer");
    expect(
      await setup.core.checkClaim({ claim: "Site notes.md was last modified on 2 November 2026." }),
    ).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: COMPUTER_LINE.en.replace("2 Nov 2026", "28 Oct 2026") },
    });
  });

  // protects=a search for the properties shows one Document's alone, the one it names, when it could be about several: every file has lines like the others', so another file's never decides a sentence; fails_when=the memo's modified date backs a sentence about the lease.
  test("a search that could be about several files shows none until it names one, then that one's alone", async () => {
    const UNNAMED = "Client lease.docx was last modified on 25 October 2026.";
    const NAMED = "The client lease file was last modified on 25 October 2026.";
    const setup = await setUp(
      [
        { name: "Client lease.docx", contents: agreement({ modified: "2026-11-02T09:00:00Z" }) },
        { name: "Orrin memo.docx", contents: agreement({ modified: "2026-10-25T10:00:00Z" }) },
      ],
      {
        [UNNAMED]: {
          verdict: "supported",
          quote: "Modified: 2026-10-25T10:00:00Z",
          property: "modified",
        },
        [NAMED]: {
          verdict: "contradicted",
          document: "Client lease",
          quote: "Modified: 2026-11-02T09:00:00Z",
          property: "modified",
        },
      },
    );

    expect(await setup.core.checkClaim({ claim: UNNAMED })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(setup.sent()).not.toContain("File properties of");
    expect(setup.sent()).toContain("No file properties are shown: this sentence could be about");
    expect(setup.sent()).toContain("“Client lease”");
    expect(setup.sent()).toContain("“Orrin memo”");

    expect(await setup.core.checkClaim({ claim: NAMED })).toMatchObject({
      verdict: "contradicted",
      evidence: {
        documentId: setup.named("Client lease.docx").id,
        location: property("modified", "2026-11-02T09:00:00Z"),
      },
    });
    expect(setup.sent()).not.toContain("2026-10-25T10:00:00Z");
  });

  // protects=properties are Document content: a Document outside the check's scope, or kept as the User's own workings, never shows them; fails_when=a property of a Document the check may not use decides the sentence.
  test("only Documents the check may use show theirs: none outside its scope or kept as workings", async () => {
    const SENTENCE = "Orrin memo.docx was last modified on 25 October 2026.";
    const CITING = "The memo this cites was last modified on 25 October 2026.";
    const TEXT = "The memo is between Halden Ltd and Orrin plc.";
    const setup = await setUp(
      [
        {
          name: "Services agreement.docx",
          contents: agreement({ modified: "2026-11-02T09:00:00Z" }),
        },
        { name: "Orrin memo.docx", contents: agreement({ modified: "2026-10-25T10:00:00Z" }) },
      ],
      {
        [SENTENCE]: {
          verdict: "supported",
          document: "Orrin memo",
          quote: "Modified: 2026-10-25T10:00:00Z",
          property: "modified",
        },
        // Naming no Document, it is shown the one the sentence cites: never one outside the scope.
        [CITING]: {
          verdict: "supported",
          quote: "Modified: 2026-10-25T10:00:00Z",
          property: "modified",
        },
        [TEXT]: {
          verdict: "supported",
          properties: false,
          document: "Orrin memo",
          quote: "between Halden Ltd and Orrin plc",
        },
      },
    );
    const services = setup.named("Services agreement.docx");
    const memo = setup.named("Orrin memo.docx");
    const scope = { folderIds: [], tagIds: [], documentIds: [services.id] };
    const quoted = await setup.core.checkClaim({ claim: TEXT });
    const passageId = quoted.verdict === "supported" ? quoted.evidence?.passageId : undefined;
    expect(quoted).toMatchObject({ verdict: "supported", evidence: { documentId: memo.id } });
    // A sentence citing the memo, checked where the memo isn't, is shown nothing of it.
    const cited = [
      { documentName: memo.name, quote: "between Halden Ltd and Orrin plc", passageId },
    ];

    // The quote the model gives is in no Passage it was shown, so nothing backs the sentence.
    for (const claim of [SENTENCE, CITING]) {
      expect(await setup.core.checkClaim({ claim, scope, cited }), claim).toMatchObject({
        verdict: "not-checked",
        reason: "no-evidence",
      });
    }
    expect(setup.sent()).not.toContain("File properties of “Orrin memo”");

    await setup.core.setNotCited(memo.id, true);
    expect(await setup.core.checkClaim({ claim: SENTENCE })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(setup.sent()).not.toContain("File properties of “Orrin memo”");

    await setup.core.setNotCited(memo.id, false);
    expect(await setup.core.checkClaim({ claim: SENTENCE })).toMatchObject({
      verdict: "supported",
      evidence: { documentId: memo.id, location: property("modified", "2026-10-25T10:00:00Z") },
    });
    // Where the memo is in the scope, the sentence citing it is shown its properties.
    expect(await setup.core.checkClaim({ claim: CITING, cited })).toMatchObject({
      verdict: "supported",
      evidence: { documentId: memo.id, location: property("modified", "2026-10-25T10:00:00Z") },
    });
  });

  // protects=a file IncarnaMind keeps itself, a Meeting's Transcript, has no properties of the User's file to show; fails_when=a check is shown the name, size or dates of IncarnaMind's own Transcript file as the file's.
  test("a Meeting's Transcript, a file IncarnaMind keeps itself, shows none", async () => {
    const SENTENCE = "The meeting's transcript file was last modified on 2 November 2026.";
    const calls: ModelCall[] = [];
    const model = propertyModel(
      { [SENTENCE]: { verdict: "unsupported", property: "modified" } },
      calls,
    );
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      model,
      engine: { lines: ["Dana will send the contract by Friday"] },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(9_000);
    const now = async () => (await core.listMeetings()).find((each) => each.id === meeting.id);
    await vi.waitFor(async () => expect((await now())?.transcript?.lines ?? 0).toBeGreaterThan(0));
    await core.stopMeeting(meeting.id);
    await vi.waitFor(async () => expect((await now())?.transcript?.state).toBe("saved"));
    const transcript = (await core.listDocuments()).find((each) => each.kind === "transcript");
    expect(transcript).toMatchObject({ keptByApp: true, status: "ready" });

    await core.checkClaim({ claim: SENTENCE });
    const sent = calls.flatMap((call) => call.results.map((result) => result.text)).join("\n");
    // The search read the Transcript's text, and was shown no properties of its file.
    expect(sent).toContain("Dana will send the contract by Friday");
    expect(sent).not.toContain("File properties of");
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
    const { check: outside } = await checkInNote(setup.core, SENTENCE, null);
    expect(outside?.state).not.toBe("supported");
    expect(outside?.evidence ?? null).toBeNull();
    expect(setup.sent()).not.toContain("2026-11-02T09:00:00Z");

    const { check: inside } = await checkInNote(setup.core, SENTENCE, client.id);
    expect(inside).toMatchObject({
      state: "supported",
      evidence: { documentId: lease.id, location: property("modified", "2026-11-02T09:00:00Z") },
    });
  });

  // protects=a small scope shows its Documents' properties on a search that finds none of their text, and a search asked again with them is a new search; fails_when=a sentence whose words match no text never sees the file's properties.
  test("a scope of a few Documents shows theirs though the search finds no text, and asking again for them is a new search", async () => {
    const UNMATCHED = "It was last modified on 2 November 2026.";
    const AGAIN = "The agreement's file was last modified on 2 November 2026.";
    const setup = await setUp(
      [
        {
          name: "Services agreement.docx",
          contents: agreement({ modified: "2026-11-02T09:00:00Z" }),
        },
      ],
      {
        [UNMATCHED]: {
          verdict: "supported",
          query: "zebra quartz",
          quote: "Modified: 2026-11-02T09:00:00Z",
          property: "modified",
        },
        [AGAIN]: {
          verdict: "supported",
          searchesTextFirst: true,
          quote: "Modified: 2026-11-02T09:00:00Z",
          property: "modified",
        },
      },
    );

    for (const claim of [UNMATCHED, AGAIN]) {
      expect(await setup.core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "supported",
        evidence: { location: property("modified", "2026-11-02T09:00:00Z") },
      });
    }
  });
});

describe("What a Document keeps of its file's properties", () => {
  const propertiesOf = async (files: readonly SourceFile[]) => {
    const setup = await setUp(files, {});
    const listed = await setup.core.listDocuments();
    return (name: string) => listed.find((each) => each.path.endsWith(name))?.properties;
  };

  test("dates as the file writes them, offset and all; its author, Chinese too; a workbook's sheets", async () => {
    const of = await propertiesOf([
      {
        name: "Brief.docx",
        contents: docxOf([{ text: "Brief" }], {
          coreXml: corePropertiesXml({
            created: "2026-10-01T08:00:00+08:00",
            modified: "2026-11-02T23:59:00-05:00",
            creator: "  王  小明  ",
          }),
        }),
      },
      {
        name: "Report.pdf",
        contents: buildPdf([{ lines: ["Report"] }], {
          info: { CreationDate: "D:20260930", ModDate: "D:20261102093000Z", Author: "Ana Ruiz" },
        }),
      },
      {
        name: "Model.xlsx",
        contents: xlsxOf(
          [
            { name: "A", rows: [["x", 1]] },
            { name: "B", rows: [["y", 2]], state: "veryHidden" },
          ],
          { coreXml: corePropertiesXml({ modified: "2026-11-01T10:00:00Z" }) },
        ),
      },
    ]);

    expect(of("Brief.docx")).toEqual({
      created: "2026-10-01T08:00:00+08:00",
      modified: "2026-11-02T23:59:00-05:00",
      author: "王 小明",
      sheets: null,
    });
    expect(of("Report.pdf")).toEqual({
      created: "2026-09-30",
      modified: "2026-11-02T09:30:00Z",
      author: "Ana Ruiz",
      sheets: null,
    });
    expect(of("Model.xlsx")).toEqual({
      created: null,
      modified: "2026-11-01T10:00:00Z",
      author: "IncarnaMind tests",
      sheets: { count: 2, hidden: 1 },
    });
  });

  // protects=a property that can't be read as the file's is none, never a guess: an empty, garbled or overlong author, a zero or future date; fails_when=a placeholder or damaged value is shown and cited as the file's own.
  test("an empty, garbled or overlong author, and a zero or future date, are none", async () => {
    const office = (core: Parameters<typeof corePropertiesXml>[0]) =>
      docxOf([{ text: "Text" }], { coreXml: corePropertiesXml(core) });
    const of = await propertiesOf([
      {
        name: "Empty.docx",
        contents: office({ creator: "   ", modified: "1980-01-01T00:00:00Z" }),
      },
      { name: "Garbled.docx", contents: office({ creator: "J��nes", modified: "2099-05-01" }) },
      { name: "Long.docx", contents: office({ creator: "A".repeat(201), created: "2026-13-40" }) },
      { name: "Edge.docx", contents: office({ creator: "B".repeat(200) }) },
    ]);

    for (const name of ["Empty.docx", "Garbled.docx", "Long.docx"]) {
      expect(of(name), name).toEqual({ created: null, modified: null, author: null, sheets: null });
    }
    expect(of("Edge.docx")?.author).toBe("B".repeat(200));
  });

  test("a date still to come is no date the file was saved on", async () => {
    // Days ahead of today: a date in a later year is refused by its year alone.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const of = await propertiesOf([
      {
        name: "Soon.docx",
        contents: docxOf([{ text: "Text" }], {
          coreXml: corePropertiesXml({ created: "2026-10-01T08:00:00Z", modified: soon }),
        }),
      },
    ]);

    expect(of("Soon.docx")).toEqual({
      created: "2026-10-01T08:00:00Z",
      modified: null,
      author: "IncarnaMind tests",
      sheets: null,
    });
  });

  // protects=a stored row is read back checked: a damaged, older or synced value that can't be the file's makes them all unknown, never "the file records none"; fails_when=a row's garbage date is shown and cited as the file's, or a malformed row brings up "only this computer's date".
  test("a stored row that can't be the file's reads as unknown, never as none recorded", async () => {
    const setup = await setUp([{ name: "Brief.docx", contents: agreement({}) }], {});
    const brief = setup.named("Brief.docx");
    const read = async (stored: string) => {
      queryDatabase(
        setup.dataDir,
        "UPDATE documents SET file_properties = ? WHERE id = ? RETURNING id",
        [stored, brief.id],
      );
      return (await setup.core.listDocuments()).find((each) => each.id === brief.id)?.properties;
    };
    const row = (values: Record<string, unknown>) =>
      JSON.stringify({ created: null, modified: null, author: null, sheets: null, ...values });

    for (const stored of [
      row({ modified: "2099-01-01" }),
      row({ modified: "yesterday" }),
      row({ created: 5 }),
      row({ author: "J\u0000nes" }),
      row({ sheets: { count: 2, hidden: 3 } }),
      "{}",
      "not JSON",
    ]) {
      expect(await read(stored), stored).toBeNull();
    }
    expect(await read(row({ modified: "2026-11-02T09:00:00Z", author: "Jo Jones" }))).toEqual({
      created: null,
      modified: "2026-11-02T09:00:00Z",
      author: "Jo Jones",
      sheets: null,
    });
  });

  test("a text file records none of its own; a kind whose properties aren't read has none known", async () => {
    const of = await propertiesOf([
      { name: "Notes.md", contents: "# Notes\n\nText.\n" },
      { name: "Letter.rtf", contents: "{\\rtf1\\ansi{\\info{\\author Jo}}Dear Jo,\\par}" },
    ]);

    expect(of("Notes.md")).toEqual({ created: null, modified: null, author: null, sheets: null });
    expect(of("Letter.rtf")).toBeNull();
  });
});

describe.each([
  {
    language: "en" as const,
    note: "(“Modified 30 Oct 2026 (the file’s own date)”, File properties, Services agreement)",
  },
  {
    language: "zh-CN" as const,
    note: "（“修改时间 2026年10月30日（文件本身的日期）”，文件属性，Services agreement）",
  },
])("In an export ($language)", ({ language, note }) => {
  test("a sentence a property contradicts is noted with the property, as a plain note of the file's properties", async () => {
    const SENTENCE = "Services agreement.docx was last modified on 2 November 2026.";
    const setup = await setUp(
      [
        {
          name: "Services agreement.docx",
          contents: agreement({ modified: "2026-10-30T16:45:00Z" }),
        },
      ],
      {
        [SENTENCE]: {
          verdict: "contradicted",
          quote: "Modified: 2026-10-30T16:45:00Z",
          property: "modified",
          says: "The file records 30 October 2026.",
        },
      },
      language,
    );
    const { check, noteId } = await checkInNote(setup.core, SENTENCE, null);
    expect(check).toMatchObject({
      state: "contradicted",
      evidence: { location: property("modified", "2026-10-30T16:45:00Z") },
    });

    const exported = await setup.core.exportMind(noteId, {
      format: "docx",
      commentFailedChecks: true,
    });
    const comments = textOf(unzip(exported.data).get("word/comments.xml")?.toString("utf8") ?? "");
    expect(comments).toContain(note);
    expect(comments).not.toContain("2026-10-30T16:45:00Z");
  });
});

describe("The Property line", () => {
  test("is read as the check's other fields are, in bold or with a full-width colon, and is never what the Document says", () => {
    const reply = (line: string) =>
      `Verdict: contradicted\n${line}\nThe file records 30 October 2026. [^1]`;
    expect(declaredProperties(reply("Property: modified"))).toEqual(new Set(["modified"]));
    expect(declaredProperties(reply("**Property**：created, modified"))).toEqual(
      new Set(["created", "modified"]),
    );
    expect(declaredProperties(reply("Property: none"))).toEqual(new Set());
    expect(declaredProperties(reply("Property: the signing date"))).toBeNull();
    expect(declaredProperties(reply("Property: none, modified"))).toBeNull();
    expect(declaredProperties("Verdict: supported")).toBeNull();
    expect(readVerdict(reply("**Property**：modified"))?.says).toBe(
      "The file records 30 October 2026.",
    );
  });
});
