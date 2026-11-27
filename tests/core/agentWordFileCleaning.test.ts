/**
 * The Word file save_as_word writes into the file a Note was imported from (#3751): it keeps only
 * what it knows makes the file's look and what the agent was given, and is written new from the
 * Note when it can't be sure. Each file here is checked as the agent's file always is: every text
 * in it is one read_mind gave the agent, and every link one the Note holds.
 */
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createSourceFolder } from "../helpers/documents";
import { part, unzip } from "../helpers/docx";
import { started, structured } from "../helpers/handedFiles";
import { editMind } from "../helpers/minds";
import {
  CHART,
  DECLARATION,
  expectNoneOf,
  expectOnlyGiven,
  HEADER_TYPE,
  type Language,
  plantedIn,
  REL,
  reviewed,
  W,
  WORDS,
  type Words,
  without,
  withParts,
} from "../helpers/plantedWordFile";
import { escapeXml, paragraph, run, STYLES, tracked, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

interface Saved {
  files: Map<string, Buffer>;
  original: Map<string, Buffer>;
  all: string;
}

/**
 * The agent's Word file of the Note imported from `bytes`, after the User's `edit`; checked as
 * every agent's file is: Word's package checks pass, its texts are what read_mind gave, its links
 * the Note's.
 */
async function savedFor(
  language: Language,
  bytes: Buffer,
  edit?: (blocks: JSONContent[]) => JSONContent[],
): Promise<Saved> {
  const { core, coast, writer } = await started([], { asItLands: false });
  await core.updateSettings({ user: { language } });
  await core.setOutputLocation(await createSourceFolder());
  const { mindId, client } = await importWordBytes(core, await createSourceFolder(), bytes, {
    name: "Reviewed.docx",
    origin: "someone-else",
    folderId: coast.id,
  });
  if (edit) {
    editMind(client, edit);
    await client.settled();
  }
  const agent = await connectLegacyAgent(writer.launch);
  const { markdown } = structured<{ markdown: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId } }),
  );
  const saved = structured<{ saved: string | null; notSaved: string | null }>(
    await agent.callTool({ name: "save_as_word", arguments: { mindId } }),
  );
  if (!saved.saved) throw new Error(`The Word file wasn't saved: ${saved.notSaved}`);
  const data = new Uint8Array(readFileSync(saved.saved));
  expect((await inspectPackage(data)).problems).toEqual([]);
  const files = unzip(data);
  expectOnlyGiven(files, markdown);
  return {
    files,
    original: unzip(bytes),
    all: [...files.values()].map((each) => each.toString("utf8")).join("\n"),
  };
}

const LANGUAGES = ["en", "zh-CN"] as const;

/** Words before a field a link holds part of, and those the User typed over them in the Note. */
const EDITED = {
  en: ["See the schedule on page", "Read the schedule on page"],
  "zh-CN": ["见附表第", "读附表第"],
} as const;

beforeAll(async () => {
  await buildAgentShim();
}, 60_000);

describe.each(LANGUAGES)("the agent's Word file of a reviewed contract (%s)", (language) => {
  const words = WORDS[language];
  // Made in the first test that asks, its data folder going with that test: the file is kept in memory.
  let made: Promise<Saved> | undefined;
  const reviewedFile = () => {
    made ??= savedFor(language, reviewed(words), without(words.gone, words.footer));
    return made;
  };

  // protects=the agent's file of a Note imported from Word is written into that file, its look kept, when every part can be cleaned (#3751); fails_when=it is written new, without the original's styles
  it("is written into the file the Note came from", async () => {
    const saved = await reviewedFile();
    expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
  });

  // protects=a relationship nothing in the agent's file points at once it is cleaned goes, with its part: pictures inside deletions, a link whose text was deleted, a link nothing uses, a picture in a clause the User took out of the Note (#3751); fails_when=a picture or a link target of those is in the agent's file
  it("leaves out the pictures and links nothing in the file shows any more", async () => {
    const saved = await reviewedFile();
    expect([...saved.files.keys()].filter((name) => /secret|headdel|user\.png/.test(name))).toEqual(
      [],
    );
    for (const target of [words.orphan, words.deletedLink]) {
      expect(saved.all).not.toContain(target);
    }
    expect(part(saved.files, "word/header1.xml")).not.toContain("w:hyperlink");
    expect(saved.all).not.toMatch(/SECRETPICTURE|HEADERDELPIC|USERDELPIC/);
    expect(part(saved.files, "word/document.xml")).not.toContain(escapeXml(words.gone));
  });

  // protects=a footer whose Block the User deleted from the Note is not in the agent's file, nor its reference (#3751); fails_when=the footer's part or words, or its reference in the section, stay
  it("leaves out a footer the User deleted from the Note", async () => {
    const saved = await reviewedFile();
    expect([...saved.files.keys()].filter((name) => name.includes("footer"))).toEqual([]);
    expect(part(saved.files, "word/document.xml")).not.toContain("footerReference");
    expect(saved.all).not.toContain(escapeXml(words.footer));
  });

  // protects=someone's deletion is applied and someone's insertion taken out in every part, the body's included, and no tracked change's mark or author is left (#3751); fails_when=a deleted or inserted word, an author's name or a tracked change's mark is in the agent's file
  it("applies someone's deletions and takes out their insertions everywhere", async () => {
    const saved = await reviewedFile();
    for (const text of [words.deleted, words.noteDeleted, words.headerAdded, words.headerLink]) {
      expect(saved.all).not.toContain(escapeXml(text));
    }
    for (const name of [words.deletedBy, words.formattedBy]) {
      expect(saved.all).not.toContain(escapeXml(name));
    }
    expect(saved.all).not.toMatch(/<w:(?:ins|del|moveFrom|moveTo) |Change |w:author=/);
    const document = part(saved.files, "word/document.xml");
    expect(document).toContain(escapeXml(words.formatted));
    expect(document).toContain('<w:jc w:val="center"/>');
    expect(part(saved.files, "word/footnotes.xml")).toContain(escapeXml(words.noteText));
  });

  // protects=a field that reads another file shows its result as plain text, its path gone (#3751); fails_when=the path or the LINK field is in the agent's file, or its result is not
  it("writes a field that reads another file as what it shows", async () => {
    const saved = await reviewedFile();
    const document = part(saved.files, "word/document.xml");
    expect(saved.all).not.toContain(escapeXml(words.path));
    expect(document).not.toContain("LINK");
    expect(document).toContain(escapeXml(words.linked));
  });

  // protects=a content control keeps its text without its names, a smart tag its text without its data, and a property shown only in deleted text goes (#3751); fails_when=a control's tag or title, a smart tag's data or the property is in the agent's file
  it("keeps what controls and smart tags show, without their names and data", async () => {
    const saved = await reviewedFile();
    for (const text of [words.tag, words.alias, words.smart, words.settled, words.settledShown]) {
      expect(saved.all).not.toContain(escapeXml(text));
    }
    const document = part(saved.files, "word/document.xml");
    expect(document).toContain(escapeXml(words.control));
    expect(document).toContain(escapeXml(words.street));
    expect(document).not.toMatch(/smartTag|w:alias|w:tag /);
    expect(saved.files.has("docProps/custom.xml")).toBe(false);
  });

  // protects=the properties and settings kept are only those known to be harmless: counts, the program, dates and the layout's settings (#3751); fails_when=a template, a link base, links, a company, a person, a protection's hash, the file's ids, variables or revision ids are in the agent's file
  it("keeps only the properties and settings known to be harmless", async () => {
    const saved = await reviewedFile();
    const names = (name: string) =>
      [...part(saved.files, name).matchAll(/<([\w:]+)[\s>/]/g)].map(([, tag]) => tag);
    expect(names("docProps/app.xml")).toEqual(["Properties", "Pages"]);
    expect(names("docProps/core.xml")).toEqual([
      "cp:coreProperties",
      "cp:revision",
      "dcterms:created",
    ]);
    const settings = part(saved.files, "word/settings.xml");
    for (const kept of ["w:zoom", "w:defaultTabStop", "w:compat"]) expect(settings).toContain(kept);
    expect(settings).not.toMatch(/documentProtection|docVars|rsids|docId/);
    expect(saved.all).not.toMatch(/SECRETHASH|hlinks\.example/);
    for (const text of [words.company, words.base]) {
      expect(saved.all).not.toContain(escapeXml(text));
    }
    expect(saved.files.has("docProps/rootpic.png")).toBe(false);
    expect(part(saved.files, "_rels/.rels")).not.toMatch(/custom-properties|image/);
  });

  // protects=no part of the agent's file holds a word planted where the Note doesn't show it, read as bytes and whatever holds it, element or attribute (#3751); fails_when=any planted word is found in any part's bytes
  it("holds none of the words the Note doesn't show, in any part's bytes", async () => {
    const saved = await reviewedFile();
    expectNoneOf(saved.files, plantedIn(words));
  });

  // protects=a drop-down keeps only the choice it shows, its other choices and values gone (#3751); fails_when=another choice, a value or the last value is in the agent's file
  it("keeps only the choice a drop-down shows", async () => {
    const saved = await reviewedFile();
    const document = part(saved.files, "word/document.xml");
    expect(document).toContain(
      `<w:dropDownList><w:listItem w:displayText="${escapeXml(words.choice)}" w:value="${escapeXml(words.choice)}"/></w:dropDownList>`,
    );
    expect(document).toContain(run(words.choice));
    expect(document).not.toContain("w:lastValue");
  });

  // protects=a legacy form field is written as what it shows, in the file the Note came from, without its name, help, status text, default or list (#3751); fails_when=any of those, or the field, is in the agent's file, or what it shows is not, or the file is written new
  it("writes a legacy form field as what it shows", async () => {
    const saved = await reviewedFile();
    expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
    const document = part(saved.files, "word/document.xml");
    expect(document).toContain(run(words.formAnswer));
    expect(document).not.toMatch(/FORMTEXT|FORMDROPDOWN|w:ffData|w:ddList/);
    for (const text of [words.formName, words.formHelp, words.formStatus, words.formOther]) {
      expect(saved.all).not.toContain(escapeXml(text));
    }
    expect(document).toContain(`${run(words.kept)}<w:r><w:t>☒</w:t></w:r><w:r><w:t>☐</w:t></w:r>`);
  });

  // protects=a VML shape's id, the name someone gave it in the selection pane, is written as Word's own id for it, or a neutral one when it has none (#3751); fails_when=the name is in the agent's file, or a shape loses its look
  it("writes shapes someone named under Word's own ids", async () => {
    const saved = await reviewedFile();
    const document = part(saved.files, "word/document.xml");
    expect(document).toContain(
      '<v:rect id="_x0000_s1030" o:spid="_x0000_s1030" style="width:20pt;height:10pt" fillcolor="silver"/>',
    );
    expect(document).toMatch(
      /<v:oval id="_x0000_s\d+" style="width:10pt;height:10pt" fillcolor="gray"\/>/,
    );
    expectNoneOf(saved.files, [words.shapeName]);
  });

  // protects=a watermark goes from the header with its words, and a link keeps its text and target without its tip (#3751); fails_when=the watermark's words or shape, or the link's tip, are in the agent's file, or the link is not
  it("leaves out a watermark and a link's tip", async () => {
    const saved = await reviewedFile();
    const header = part(saved.files, "word/header1.xml");
    expect(header).toContain(run(words.header));
    expect(header).not.toMatch(/v:textpath|PowerPlusWaterMarkObject/);
    expect(saved.all).not.toContain(escapeXml(words.watermark));
    const document = part(saved.files, "word/document.xml");
    expect(document).toMatch(/<w:hyperlink r:id="[^"]+">/);
    expect(document).toContain(run(words.webText));
    expect(part(saved.files, "word/_rels/document.xml.rels")).toContain(words.web);
    expect(saved.all).not.toContain(escapeXml(words.linkTip));
  });
});

/** A header in a part whose name doesn't end in .xml, with someone's deletion and insertion. */
function headerElsewhere(words: Words): Buffer {
  return withParts(
    wordFile({
      body: paragraph(run(words.kept)),
      sectPr: '<w:headerReference w:type="default" r:id="rIdHX"/><w:pgSz w:w="11906" w:h="16838"/>',
      rels: `<Relationship Id="rIdHX" Type="${REL}/header" Target="parts/head.part"/>`,
    }),
    {
      "word/parts/head.part": `${DECLARATION}<w:hdr xmlns:w="${W}" xmlns:r="${REL}"><w:p>${run(words.header)}${tracked("ins", 5, words.formattedBy, words.headerAdded)}${tracked("del", 6, words.deletedBy, words.deleted)}</w:p></w:hdr>`,
    },
    `<Override PartName="/word/parts/head.part" ContentType="${HEADER_TYPE}"/>`,
  );
}

/** A header that names WordprocessingML by another prefix than Word's own. */
function headerPrefixed(words: Words): Buffer {
  return withParts(
    wordFile({
      body: paragraph(run(words.kept)),
      sectPr: '<w:headerReference w:type="default" r:id="rIdHX"/><w:pgSz w:w="11906" w:h="16838"/>',
      rels: `<Relationship Id="rIdHX" Type="${REL}/header" Target="header9.xml"/>`,
    }),
    {
      "word/header9.xml": `${DECLARATION}<x:hdr xmlns:x="${W}"><x:p><x:r><x:t>${escapeXml(words.header)}</x:t></x:r><x:ins x:id="5" x:author="${escapeXml(words.formattedBy)}" x:date="2026-10-02T09:00:00Z"><x:r><x:t>${escapeXml(words.headerAdded)}</x:t></x:r></x:ins><x:del x:id="6" x:author="${escapeXml(words.deletedBy)}" x:date="2026-10-02T09:00:00Z"><x:r><x:delText>${escapeXml(words.deleted)}</x:delText></x:r></x:del></x:p></x:hdr>`,
    },
    `<Override PartName="/word/header9.xml" ContentType="${HEADER_TYPE}"/>`,
  );
}

/** A link whose place in another file is someone's words, in an attribute nothing lists. */
function linkPlaced(words: Words): Buffer {
  return wordFile({
    body: paragraph(
      `${run(words.kept)}<w:hyperlink w:docLocation="${escapeXml(words.formHelp)}">${run(words.webText)}</w:hyperlink>`,
    ),
  });
}

/**
 * A file whose styles someone named, one Word's own under an id someone gave it, with other names
 * a style goes by, a list someone named and one nothing uses whose numbers show `unusedLabel`.
 */
function styledByClient(words: Words): Buffer {
  const id = escapeXml(words.styleId);
  return wordFile({
    styles: `<w:latentStyles w:defLockedState="0" w:count="2"><w:lsdException w:name="Normal" w:qFormat="1"/><w:lsdException w:name="${escapeXml(words.latent)}" w:qFormat="1"/></w:latentStyles>${STYLES}<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${escapeXml(words.styleName)}"/><w:aliases w:val="${escapeXml(words.styleAlias)}"/><w:basedOn w:val="Normal"/><w:next w:val="${id}"/><w:link w:val="${id}Char"/><w:pPr><w:ind w:left="1234"/></w:pPr></w:style><w:style w:type="character" w:customStyle="1" w:styleId="${id}Char"><w:name w:val="${escapeXml(words.styleName)} Char"/><w:link w:val="${id}"/><w:rPr><w:color w:val="1F4E79"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="${id}Quote"><w:name w:val="Quote"/><w:basedOn w:val="${id}"/></w:style>`,
    numbering: `<w:abstractNum w:abstractNumId="0"><w:name w:val="${escapeXml(words.listName)}"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${escapeXml(words.unusedLabel)} %1"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`,
    body: [
      paragraph(
        `<w:r><w:rPr><w:rStyle w:val="${id}Char"/></w:rPr><w:t>${escapeXml(words.kept)}</w:t></w:r>`,
        { style: words.styleId },
      ),
      paragraph(run(words.control), { style: `${words.styleId}Quote` }),
      paragraph(run(words.street), { numId: 1, ilvl: 0 }),
    ].join(""),
  });
}

/** The list Chinese contracts number their clauses with, 第一条 and on. */
const CLAUSES =
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum>';

/** Clauses numbered 第%1条, whose text never says 条, and a list nothing uses whose numbers show `unused`. */
function numberedClauses(words: Words, unused: string): Buffer {
  return wordFile({
    numbering: `${CLAUSES}<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${escapeXml(unused)} %1"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`,
    body: [words.street, words.webText]
      .map((text) => paragraph(run(text), { numId: 1, ilvl: 0 }))
      .join(""),
  });
}

/** A date control whose picture shows words the Note doesn't hold. */
function datePictured(words: Words): Buffer {
  return wordFile({
    body: `${paragraph(run(words.kept))}<w:sdt><w:sdtPr><w:id w:val="12"/><w:date w:fullDate="2026-10-02T00:00:00Z"><w:dateFormat w:val="'${escapeXml(words.dateNote)}' d/M/yyyy"/><w:lid w:val="en-GB"/><w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date></w:sdtPr><w:sdtContent>${paragraph(run("2/10/2026"))}</w:sdtContent></w:sdt>`,
  });
}

/** A setting tied to an address that is no schema's: someone's own. */
function settingAddressed(words: Words): Buffer {
  return wordFile({
    body: paragraph(run(words.kept)),
    settings: `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="${escapeXml(words.privateUri)}" w:val="15"/></w:compat>`,
  });
}

const DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const DRAWING_ML = "application/vnd.openxmlformats-officedocument.drawingml";
/** A SmartArt diagram whose layout has a title and a description the Note doesn't hold. */
function diagramTitled(words: Words): Buffer {
  const part = (root: string, inside = "") =>
    `${DECLARATION}<dgm:${root} xmlns:dgm="${DIAGRAM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${inside}</dgm:${root}>`;
  return withParts(
    wordFile({
      body: `${paragraph(run(words.kept))}<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="2000000"/><wp:docPr id="60" name=""/><a:graphic><a:graphicData uri="${DIAGRAM}"><dgm:relIds xmlns:dgm="${DIAGRAM}" r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      rels: [
        "Dm diagramData data",
        "Lo diagramLayout layout",
        "Qs diagramQuickStyle quickStyle",
        "Cs diagramColors colors",
      ]
        .map((each) => each.split(" "))
        .map(
          ([id, kind, name]) =>
            `<Relationship Id="rId${id}" Type="${REL}/${kind}" Target="diagrams/${name}1.xml"/>`,
        )
        .join(""),
    }),
    {
      "word/diagrams/data1.xml": part("dataModel", "<dgm:ptLst/><dgm:cxnLst/>"),
      "word/diagrams/layout1.xml": part(
        "layoutDef",
        `<dgm:title val="${escapeXml(words.diagramTitle)}"/><dgm:desc val="${escapeXml(words.diagramDesc)}"/><dgm:layoutNode name="diagram"/>`,
      ),
      "word/diagrams/quickStyle1.xml": part("styleDef"),
      "word/diagrams/colors1.xml": part("colorsDef"),
    },
    ["data diagramData", "layout diagramLayout", "quickStyle diagramStyle", "colors diagramColors"]
      .map((each) => each.split(" "))
      .map(
        ([name, type]) =>
          `<Override PartName="/word/diagrams/${name}1.xml" ContentType="${DRAWING_ML}.${type}+xml"/>`,
      )
      .join(""),
  );
}

/** A chart whose numbers are shown with words the Note doesn't hold. */
function chartFormatted(words: Words): Buffer {
  return withParts(
    wordFile({
      body: `${paragraph(run(words.kept))}<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="2000000"/><wp:docPr id="51" name=""/><a:graphic><a:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" r:id="rIdChart1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      rels: `<Relationship Id="rIdChart1" Type="${REL}/chart" Target="charts/chart1.xml"/>`,
    }),
    {
      "word/charts/chart1.xml": `${DECLARATION}<c:chartSpace xmlns:c="${CHART}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:formatCode>0 "${escapeXml(words.unit)}"</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`,
    },
    '<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
  );
}

/** A link to a page whose address holds parentheses. */
const TEA = "https://encyclopedia.example/wiki/Tea_(drink)";
function linkParenthesised(words: Words): Buffer {
  return wordFile({
    body: paragraph(
      `${run(words.kept)}<w:hyperlink r:id="rIdTea">${run(words.webText)}</w:hyperlink>`,
    ),
    rels: `<Relationship Id="rIdTea" Type="${REL}/hyperlink" Target="${TEA}" TargetMode="External"/>`,
  });
}

/** A first-page header the Note shows, holding `alias`, and a later section's own header that holds `kept`. */
function twoHeaders(words: Words): Buffer {
  return withParts(
    wordFile({
      body: `<w:p><w:pPr><w:sectPr><w:headerReference w:type="first" r:id="rIdHF"/><w:titlePg/></w:sectPr></w:pPr>${run(words.kept)}</w:p>${paragraph(run(words.control))}`,
      sectPr: '<w:headerReference w:type="default" r:id="rIdHD"/><w:pgSz w:w="11906" w:h="16838"/>',
      rels: `<Relationship Id="rIdHF" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdHD" Type="${REL}/header" Target="header2.xml"/>`,
    }),
    {
      "word/header1.xml": `${DECLARATION}<w:hdr xmlns:w="${W}"><w:p>${run(words.alias)}</w:p></w:hdr>`,
      "word/header2.xml": `${DECLARATION}<w:hdr xmlns:w="${W}"><w:p>${run(words.kept)}</w:p></w:hdr>`,
    },
    `<Override PartName="/word/header1.xml" ContentType="${HEADER_TYPE}"/><Override PartName="/word/header2.xml" ContentType="${HEADER_TYPE}"/>`,
  );
}

/** A theme the file keeps that isn't XML. */
function themeUnread(words: Words): Buffer {
  return withParts(
    wordFile({
      body: paragraph(run(words.kept)),
      rels: `<Relationship Id="rIdTheme" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    }),
    { "word/theme/theme1.xml": `${words.deletedBy} <not xml` },
    '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  );
}

/** A chart whose title is words the Note doesn't hold. */
function chartTitled(words: Words): Buffer {
  return withParts(
    wordFile({
      body: `${paragraph(run(words.kept))}<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="2000000"/><wp:docPr id="51" name="Chart 1"/><a:graphic><a:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" r:id="rIdChart1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      rels: `<Relationship Id="rIdChart1" Type="${REL}/chart" Target="charts/chart1.xml"/>`,
    }),
    {
      "word/charts/chart1.xml": `${DECLARATION}<c:chartSpace xmlns:c="${CHART}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${escapeXml(words.title)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`,
    },
    '<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
  );
}

describe.each(LANGUAGES)(
  "the agent's Word file of a file it can't keep as it is (%s)",
  (language) => {
    const words = WORDS[language];

    // protects=a part is cleaned by the kind of relationship that reaches it and its content type, whatever its name (#3751); fails_when=a header kept under a name not ending in .xml keeps someone's deletion, insertion or name
    it("cleans a header kept under a name that doesn't end in .xml", async () => {
      const saved = await savedFor(language, headerElsewhere(words));
      expect(part(saved.files, "word/parts/head.part")).toContain(escapeXml(words.header));
      for (const text of [words.deleted, words.headerAdded, words.deletedBy, words.formattedBy]) {
        expect(saved.all).not.toContain(escapeXml(text));
      }
    });

    // protects=a part that names WordprocessingML by another prefix is not cleaned by guesswork: the agent's file is written new from the Note (#3751); fails_when=the part is copied with someone's deletion, insertion or name in it
    it("writes the file new when a part names WordprocessingML by another prefix", async () => {
      const saved = await savedFor(language, headerPrefixed(words));
      expect(saved.files.has("word/header9.xml")).toBe(false);
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      for (const text of [words.deleted, words.headerAdded, words.deletedBy, words.formattedBy]) {
        expect(saved.all).not.toContain(escapeXml(text));
      }
    });

    // protects=a part the file keeps that can't be read as XML makes the agent's file be written new from the Note (#3751); fails_when=the part is copied into the agent's file
    it("writes the file new when a part it keeps isn't XML", async () => {
      const saved = await savedFor(language, themeUnread(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expect(saved.all).not.toContain(words.deletedBy);
    });

    // protects=the agent's file is confirmed in code to hold only words read_mind gave the agent: one that holds others, such as a chart's title the Note doesn't show, is written new from the Note (#3751); fails_when=the chart's title is in the agent's file
    it("writes the file new when it would hold words the agent wasn't given", async () => {
      const saved = await savedFor(language, chartTitled(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expect(saved.all).not.toContain(escapeXml(words.title));
    });

    // protects=the check reads every attribute as words unless it is known to hold none, so words in one nobody listed make the agent's file be written new from the Note (#3751); fails_when=the attribute's words are in the agent's file
    it("writes the file new when an attribute nobody listed holds words", async () => {
      const saved = await savedFor(language, linkPlaced(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expect(part(saved.files, "word/document.xml")).toContain(escapeXml(words.webText));
      expectNoneOf(saved.files, [words.formHelp]);
    });

    // protects=a style someone named is renamed Style 1, Style 2 and so on, its id Style1 and so on, everywhere the file names it, with its look kept; Word's own styles keep their names; a list's name, a style's other names, a latent style not Word's and a list nothing uses go (#3751); fails_when=any of those names or the unused list's words are in the agent's file, or the style's look or a reference to it is lost, or the file is written new
    it("renames the styles someone named, keeping their look", async () => {
      const saved = await savedFor(language, styledByClient(words));
      const styles = part(saved.files, "word/styles.xml");
      expect(styles).toContain(
        '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Style1"><w:name w:val="Style 1"/><w:basedOn w:val="Normal"/><w:next w:val="Style1"/><w:link w:val="Style2"/><w:pPr><w:ind w:left="1234"/></w:pPr></w:style>',
      );
      expect(styles).toContain(
        '<w:style w:type="character" w:customStyle="1" w:styleId="Style2"><w:name w:val="Style 2"/><w:link w:val="Style1"/>',
      );
      expect(styles).toContain(
        '<w:style w:type="paragraph" w:styleId="Style3"><w:name w:val="Quote"/><w:basedOn w:val="Style1"/>',
      );
      expect(styles).toContain('<w:name w:val="heading 1"/>');
      expect(styles).toContain('<w:lsdException w:name="Normal" w:qFormat="1"/>');
      const document = part(saved.files, "word/document.xml");
      expect(document).toContain('<w:pStyle w:val="Style1"/>');
      expect(document).toContain('<w:rStyle w:val="Style2"/>');
      expect(document).toContain('<w:pStyle w:val="Style3"/>');
      const numbering = part(saved.files, "word/numbering.xml");
      expect(numbering).toContain('<w:lvlText w:val="%1."/>');
      expect(numbering).not.toContain('w:numId="2"');
      expectNoneOf(saved.files, [
        words.styleName,
        words.styleId,
        words.styleAlias,
        words.listName,
        words.latent,
        words.unusedLabel,
      ]);
    });

    // protects=a list's number words, such as 第…条, are how its numbers look, as its font is: a file numbered 第%1条 whose text never says 条 is written into the original with its numbering, and a list nothing uses goes with the words its numbers show (#3751); fails_when=the file is written new, its used list changes, or the unused list's words are in the agent's file
    it("keeps 第%1条 numbering as it is, and drops a list nothing uses", async () => {
      const saved = await savedFor(language, numberedClauses(words, words.unusedLabel));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const numbering = part(saved.files, "word/numbering.xml");
      expect(numbering).toContain(
        `${CLAUSES}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
      );
      expect(numbering).not.toContain('w:numId="2"');
      expectNoneOf(saved.files, [words.unusedLabel]);
    });

    // protects=the check reads the words a date control's picture shows, so ones the Note doesn't hold make the agent's file be written new (#3751); fails_when=the picture's words are in the agent's file
    it("writes the file new when a date's picture shows words the agent wasn't given", async () => {
      const saved = await savedFor(language, datePictured(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.dateNote]);
    });

    // protects=the check reads an address that is no schema's as words, so one the Note doesn't hold makes the agent's file be written new (#3751); fails_when=the address is in the agent's file
    it("writes the file new when a setting names an address the agent wasn't given", async () => {
      const saved = await savedFor(language, settingAddressed(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.privateUri]);
    });

    // protects=the check reads a diagram layout's title and description, so ones the Note doesn't hold make the agent's file be written new (#3751); fails_when=the title or description is in the agent's file
    it("writes the file new when a diagram's layout is titled with words the agent wasn't given", async () => {
      const saved = await savedFor(language, diagramTitled(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.diagramTitle, words.diagramDesc]);
    });

    // protects=the check reads a chart's number format, so words it shows that the Note doesn't hold make the agent's file be written new (#3751); fails_when=the format's words are in the agent's file
    it("writes the file new when a chart's numbers show words the agent wasn't given", async () => {
      const saved = await savedFor(language, chartFormatted(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.unit]);
    });

    // protects=a link whose address holds parentheses is matched whole against the Note's links, so it doesn't make the agent's file be written new (#3751); fails_when=the file is written new
    it("keeps a link whose address holds parentheses", async () => {
      const saved = await savedFor(language, linkParenthesised(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      expect(part(saved.files, "word/_rels/document.xml.rels")).toContain(TEA);
    });

    // protects=deleting the header the Note shows takes out that header's part alone; another section's header stays (#3751); fails_when=the deleted header's part or words stay, or the other header goes
    it("leaves out only the header the User deleted from the Note", async () => {
      const saved = await savedFor(language, twoHeaders(words), without(words.alias));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      expect(saved.files.has("word/header1.xml")).toBe(false);
      expect(part(saved.files, "word/header2.xml")).toContain(run(words.kept));
      const document = part(saved.files, "word/document.xml");
      expect(document).not.toContain('w:type="first"');
      expect(document).toContain('<w:headerReference w:type="default"');
      expectNoneOf(saved.files, [words.alias]);
    });

    // protects=an edit of the User's that the export can't write into the original, such as one in a field's result, makes the agent's file be written new from the Note, never the original's words kept (#3751); fails_when=the agent's file holds the words the User changed, not the Note's
    it("writes the file new when the User's edit can't be written into it", async () => {
      const [was, now] = EDITED[language];
      // A field that starts in a link and ends after it can only be written as it was, and the words beside it with it.
      const bytes = wordFile({
        body: paragraph(
          `${run(words.kept)}<w:hyperlink w:anchor="_Toc1">${run(`${was} `)}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("2")}</w:hyperlink><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
        ),
      });
      const saved = await savedFor(language, bytes, (blocks) =>
        JSON.parse(JSON.stringify(blocks).replaceAll(was, now)),
      );
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      const document = part(saved.files, "word/document.xml");
      expect(document).toContain(now);
      expect(document).not.toContain(was);
    });
  },
);
