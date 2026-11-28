/**
 * The Word file save_as_word writes into the file a Note was imported from (#3751): it keeps only
 * what it knows makes the file's look and what the agent was given, and is written new from the
 * Note when it can't be sure. Each file here is checked as the agent's file always is: every text
 * in it is one read_mind gave the agent, and every link one the Note holds.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { wordFileOf } from "../../src/shared/wordFiles";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createSourceFolder } from "../helpers/documents";
import { part, unzip } from "../helpers/docx";
import { started, structured } from "../helpers/handedFiles";
import { editMind, readMind } from "../helpers/minds";
import {
  CHART,
  DECLARATION,
  expectNoneOf,
  expectOnlyGiven,
  HEADER_TYPE,
  type Language,
  PACKAGE,
  plantedIn,
  REL,
  reviewed,
  W,
  WORDS,
  type Words,
  without,
  withParts,
} from "../helpers/plantedWordFile";
import {
  escapeXml,
  field,
  PNG,
  paragraph,
  picture,
  run,
  STYLES,
  tracked,
  wordFile,
} from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

interface Saved {
  files: Map<string, Buffer>;
  original: Map<string, Buffer>;
  all: string;
  /** The Note as the agent's file was written from it. */
  note: JSONContent[];
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
  /** What happens to the stored Word file, by its path, once the Note is imported. */
  stored?: (path: string) => Promise<void>,
): Promise<Saved> {
  const { core, coast, writer, dataDir } = await started([], { asItLands: false });
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
  const sha256 = wordFileOf(client.doc)?.sha256;
  if (stored) await stored(join(dataDir, WORD_PACKAGES_FOLDER, `${sha256}.docx`));
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
    note: readMind(client).toJSON().content ?? [],
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

const BULLET_PICTURES = {
  kept: Buffer.concat([PNG, Buffer.from("KEPTBULLETPIC")]),
  override: Buffer.concat([PNG, Buffer.from("OVERRIDEBULLETPIC")]),
  unused: Buffer.concat([PNG, Buffer.from("UNUSEDBULLETPIC")]),
  orphan: Buffer.concat([PNG, Buffer.from("ORPHANBULLETPIC")]),
};

/** A picture bullet, as Word keeps it in the numbering part, drawing the image of relationship `id`. */
const pictureBullet = (bullet: number, id: string) =>
  `<w:numPicBullet w:numPicBulletId="${bullet}"><w:pict><v:shape id="_x0000_i${1025 + bullet}" type="#_x0000_t75" style="width:9pt;height:9pt" o:bullet="t"><v:imagedata r:id="${id}"/></v:shape></w:pict></w:numPicBullet>`;

/**
 * Lists bulleted with pictures. One list, a paragraph's, draws picture bullet 0 and another's
 * override draws 3; a list nothing uses draws 1 and labels its bullets with `unusedLabel`, and
 * picture bullet 2 is drawn by no list.
 */
function pictureBulleted(words: Words): Buffer {
  const level = (format: string, text: string, bullet: number) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text)}"/><w:lvlPicBulletId w:val="${bullet}"/></w:lvl>`;
  const numbering = [
    pictureBullet(0, "rIdBulletKept"),
    pictureBullet(1, "rIdBulletUnused"),
    pictureBullet(2, "rIdBulletOrphan"),
    pictureBullet(3, "rIdBulletOverride"),
    `<w:abstractNum w:abstractNumId="0">${level("bullet", "•", 0)}</w:abstractNum>`,
    `<w:abstractNum w:abstractNumId="1">${level("bullet", words.unusedLabel, 1)}</w:abstractNum>`,
    '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>',
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
    `<w:num w:numId="3"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0">${level("bullet", "•", 3)}</w:lvlOverride></w:num>`,
  ].join("");
  const bullets = `${DECLARATION}<Relationships xmlns="${PACKAGE}">${[
    ["Kept", "keptbullet"],
    ["Unused", "unusedbullet"],
    ["Orphan", "orphanbullet"],
    ["Override", "overridebullet"],
  ]
    .map(
      ([id, name]) =>
        `<Relationship Id="rIdBullet${id}" Type="${REL}/image" Target="media/${name}.png"/>`,
    )
    .join("")}</Relationships>`;
  return wordFile({
    numbering,
    body: [words.street, words.webText]
      .map((text, at) => paragraph(run(text), { numId: at === 0 ? 1 : 3, ilvl: 0 }))
      .join(""),
    parts: [
      { name: "word/_rels/numbering.xml.rels", data: bullets },
      { name: "word/media/keptbullet.png", data: BULLET_PICTURES.kept },
      { name: "word/media/unusedbullet.png", data: BULLET_PICTURES.unused },
      { name: "word/media/orphanbullet.png", data: BULLET_PICTURES.orphan },
      { name: "word/media/overridebullet.png", data: BULLET_PICTURES.override },
    ],
  });
}

/** Words left where a parser reading text and elements never looks: an XML comment, an instruction. */
const MARKUP_WORDS = { comment: "XMLCOMMENTWORDS", instruction: "XMLINSTRUCTIONWORDS" };

/** A file with an XML comment in its body, styles, header, relationships and content types, and an instruction in its body. */
function markupHeld(words: Words): Buffer {
  const comment = (where: string) => `<!-- ${where} ${MARKUP_WORDS.comment} -->`;
  const file = wordFile({
    body: `${comment("body")}${paragraph(`${run(words.kept)}${comment("paragraph")}<?note ${MARKUP_WORDS.instruction}?>`)}`,
    styles: `${comment("styles")}${STYLES}`,
    headers: { rIdH1: `${comment("header")}${paragraph(run(words.header))}` },
    sectPr: HEADED,
    rels: comment("rels"),
  });
  return withParts(file, {}, comment("types"));
}

/**
 * A table whose second row someone's change deleted and whose third row someone's change inserted,
 * as Word writes them: the row's mark, and its words in tracked runs.
 */
function rowsRevised(words: Words): Buffer {
  const date = 'w:author="' + escapeXml(words.deletedBy) + '" w:date="2026-10-02T09:00:00Z"';
  const row = (revision: string, cell: string) =>
    `<w:tr>${revision ? `<w:trPr>${revision}</w:trPr>` : ""}<w:tc>${paragraph(cell)}</w:tc></w:tr>`;
  return wordFile({
    body: `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${row("", run(words.kept))}${row(`<w:del w:id="90" ${date}/>`, tracked("del", 92, words.deletedBy, words.deleted))}${row(`<w:ins w:id="91" ${date}/>`, tracked("ins", 93, words.deletedBy, words.headerAdded))}</w:tbl>${paragraph(run(words.street))}`,
  });
}

const begin = '<w:fldChar w:fldCharType="begin"/>';
const separate = '<w:fldChar w:fldCharType="separate"/>';
const end = '<w:fldChar w:fldCharType="end"/>';

/** A field that reads another file whose markers share runs with the words around it. */
function fieldInRuns(words: Words): Buffer {
  const instruction = `<w:instrText xml:space="preserve"> LINK Excel.Sheet.12 "${words.path}" "Sheet1!R1C1" \\a \\f 4 \\h </w:instrText>`;
  const text = (said: string) => `<w:t xml:space="preserve">${escapeXml(said)}</w:t>`;
  return wordFile({
    body: paragraph(
      `<w:r>${text(words.link)}${begin}</w:r><w:r>${instruction}</w:r><w:r>${separate}</w:r>${run(words.linked)}<w:r>${end}${text(` ${words.noteText}`)}</w:r>`,
    ),
  });
}

/** A field that reads another file with a field written inside its instruction, whose result is a secret. */
function fieldNested(words: Words): Buffer {
  const code = (instruction: string) =>
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instruction)}</w:instrText></w:r>`;
  return wordFile({
    body: paragraph(
      `${run(words.kept)}<w:r>${begin}</w:r>${code(` LINK Excel.Sheet.12 "`)}<w:r>${begin}</w:r>${code(" DOCPROPERTY Client ")}<w:r>${separate}</w:r>${run(words.protection)}<w:r>${end}</w:r>${code(`" "Sheet1!R1C1" \\a \\f 4 \\h `)}<w:r>${separate}</w:r>${run(words.linked)}<w:r>${end}</w:r>`,
    ),
  });
}

/**
 * A link the Note holds, and a link written as a field to an address of words the Note has but
 * which is none of its links.
 */
function linkAsField(words: Words, address: string): Buffer {
  return wordFile({
    body: [
      paragraph(`<w:hyperlink r:id="rIdWeb">${run(words.webText)}</w:hyperlink>`),
      paragraph(
        `${run(words.kept)}<w:r>${begin}</w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "${escapeXml(address)}" </w:instrText></w:r><w:r>${separate}</w:r>${run(words.street)}<w:r>${end}</w:r>`,
      ),
    ].join(""),
    rels: `<Relationship Id="rIdWeb" Type="${REL}/hyperlink" Target="${words.web}" TargetMode="External"/>`,
  });
}

/** A file whose properties hold values nobody gave the agent in the elements the cleaning keeps. */
function propertiesWorded(words: Words): Buffer {
  return withParts(
    wordFile({ body: paragraph(run(words.kept)) }),
    {
      "_rels/.rels": `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${PACKAGE}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      "docProps/core.xml": `${DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><cp:revision>${escapeXml(words.formHelp)}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(words.formStatus)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-02T09:00:00Z</dcterms:modified></cp:coreProperties>`,
      "docProps/app.xml": `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>1</Pages><Words>${escapeXml(words.formName)}</Words><AppVersion>${escapeXml(words.formDefault)}</AppVersion><Characters>4827</Characters></Properties>`,
    },
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
  );
}

const CROPPED_PNG = Buffer.concat([PNG, Buffer.from("CROPPEDOUTPIXELS")]);

/** A picture Word shows cropped to its right 40%: the crop is a rectangle beside the picture's whole image. */
function pictureCropped(words: Words): Buffer {
  return wordFile({
    body: paragraph(
      `${run(words.kept)}${picture("rIdCrop", words.alt).replace("</pic:blipFill>", '<a:srcRect l="60000"/></pic:blipFill>')}`,
    ),
    media: { rIdCrop: { name: "media/crop.png", data: CROPPED_PNG } },
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

/** The header a file's last section shows, as rIdH1. */
const HEADED =
  '<w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="11906" w:h="16838"/>';

/** Runs that write a field's instruction in pieces, as Word often does. */
const instructed = (pieces: readonly string[], result: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${pieces.map((piece) => `<w:r><w:instrText xml:space="preserve">${escapeXml(piece)}</w:instrText></w:r>`).join("")}<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

/**
 * A table of contents that lists a style someone named, its name cut across two runs, and a header
 * that shows the text in that style; `styled`: false names a style the file doesn't have.
 */
function contentsByStyle(words: Words, styled = true): Buffer {
  const cut = Math.ceil(words.styleName.length / 2);
  return wordFile({
    styles: styled
      ? `${STYLES}<w:style w:type="paragraph" w:customStyle="1" w:styleId="${escapeXml(words.styleId)}"><w:name w:val="${escapeXml(words.styleName)}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>`
      : STYLES,
    body: [
      paragraph(
        instructed(
          [
            ` TOC \\o "1-1" \\h \\z \\t "${words.styleName.slice(0, cut)}`,
            `${words.styleName.slice(cut)},2" `,
          ],
          words.street,
        ),
      ),
      paragraph(run(words.street), styled ? { style: words.styleId } : {}),
    ].join(""),
    headers: styled
      ? { rIdH1: paragraph(field(`STYLEREF "${words.styleName}" \\* MERGEFORMAT`, words.street)) }
      : { rIdH1: paragraph(run(words.header)) },
    sectPr: HEADED,
  });
}

/** A field whose instruction holds `instruction` and whose result shows `result`. */
const fielded = (words: Words, instruction: string, result: string) =>
  wordFile({ body: paragraph(run(words.kept)) + paragraph(field(instruction, result)) });

/** Fields whose pictures and formats show only what their results show, and Word's own formats. */
const PICTURED = {
  en: [
    ['DATE \\@ "dddd, d MMMM yyyy" \\* MERGEFORMAT', "Friday, 2 October 2026"],
    ["PAGE \\* roman", "ii"],
    ['= 1234 \\# "#,##0.00"', "1,234.00"],
  ],
  "zh-CN": [
    ["DATE \\@ \"yyyy'年'M'月'd'日'\" \\* MERGEFORMAT", "2026年10月2日"],
    ['CREATEDATE \\@ "yyyy年M月d日"', "2026年10月1日"],
    ["PAGE \\* CHINESENUM3", "二"],
    ['= 1234 \\# "#,##0.00"', "1,234.00"],
  ],
} as const;

/** A contract as Chinese Word writes one: its own short style ids, and 字符 after a linked style's name. */
const CHINESE_WORD_STYLES = `<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:link w:val="10"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:kern w:val="44"/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="character" w:default="1" w:styleId="a0"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style><w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="numbering" w:default="1" w:styleId="a2"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="header"/><w:basedOn w:val="a"/><w:link w:val="a4"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:tabs><w:tab w:val="center" w:pos="4153"/><w:tab w:val="right" w:pos="8306"/></w:tabs><w:snapToGrid w:val="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style><w:style w:type="character" w:customStyle="1" w:styleId="a4"><w:name w:val="页眉 字符"/><w:basedOn w:val="a0"/><w:link w:val="a3"/><w:uiPriority w:val="99"/><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="a5"><w:name w:val="footer"/><w:basedOn w:val="a"/><w:link w:val="a6"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4153"/><w:tab w:val="right" w:pos="8306"/></w:tabs><w:snapToGrid w:val="0"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style><w:style w:type="character" w:customStyle="1" w:styleId="a6"><w:name w:val="页脚 字符"/><w:basedOn w:val="a0"/><w:link w:val="a5"/><w:uiPriority w:val="99"/><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style><w:style w:type="character" w:customStyle="1" w:styleId="10"><w:name w:val="标题 1 字符"/><w:basedOn w:val="a0"/><w:link w:val="1"/><w:rPr><w:b/><w:kern w:val="44"/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="table" w:styleId="a7"><w:name w:val="Table Grid"/><w:basedOn w:val="a1"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>`;

function chineseWordContract(words: Words): Buffer {
  return wordFile({
    styles: CHINESE_WORD_STYLES,
    body: [paragraph(run(words.kept), { style: "1" }), paragraph(run(words.street))].join(""),
    headers: {
      rIdH1: `<w:p><w:pPr><w:pStyle w:val="a3"/></w:pPr><w:r><w:rPr><w:rStyle w:val="a4"/></w:rPr><w:t>${escapeXml(words.header)}</w:t></w:r></w:p>`,
    },
    footers: {
      rIdF1: paragraph(field("PAGE \\* Arabic \\* MERGEFORMAT", "1"), { style: "a5" }),
    },
    sectPr:
      '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/>',
  });
}

/** A shape someone named in the header and in the body, beside a shape Word numbered 5000. */
function shapesNamed(words: Words): Buffer {
  const shape = (color: string) =>
    `<w:r><w:pict><v:rect id="${escapeXml(words.shapeName)}" style="width:20pt;height:10pt" fillcolor="${color}"/></w:pict></w:r>`;
  return wordFile({
    body: paragraph(
      `${run(words.kept)}${shape("silver")}<w:r><w:pict><v:oval id="_x0000_s5000" o:spid="_x0000_s5000" style="width:10pt;height:10pt" fillcolor="gray"/></w:pict></w:r>`,
    ),
    headers: { rIdH1: paragraph(`${run(words.header)}${shape("gray")}`) },
    sectPr: HEADED,
  });
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

    // protects=a picture bullet no list the file shows draws goes with its picture, and so does a bullet list nothing uses with the words its bullets are labelled with, while the picture bullets a list and a list's override draw stay (#3751); fails_when=an unused list's or an undrawn picture bullet's image or a label's words are in the agent's file, a drawn picture bullet is lost, or the file is written new
    it("leaves out the picture bullets no list draws, and a bullet list nothing uses", async () => {
      const saved = await savedFor(language, pictureBulleted(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      expectNoneOf(saved.files, [words.unusedLabel, "UNUSEDBULLETPIC", "ORPHANBULLETPIC"]);
      expect([...saved.files.keys()].filter((name) => name.includes("bullet.png")).sort()).toEqual([
        "word/media/keptbullet.png",
        "word/media/overridebullet.png",
      ]);
      const numbering = part(saved.files, "word/numbering.xml");
      expect(
        [...numbering.matchAll(/w:numPicBulletId="(\d+)"/g)].map(([, bullet]) => bullet),
      ).toEqual(["0", "3"]);
      const relationships = part(saved.files, "word/_rels/numbering.xml.rels");
      expect(relationships).toContain("media/keptbullet.png");
      expect(relationships).toContain("media/overridebullet.png");
      expect(relationships).not.toMatch(/unusedbullet|orphanbullet/);
    });

    // protects=an XML comment or instruction a file carries, which a reader of text and elements never shows, is not in the agent's file, in any part (#3751); fails_when=the comment's or the instruction's words are in any part's bytes, or the file is written new
    it("leaves out an XML comment and an instruction in every part", async () => {
      const saved = await savedFor(language, markupHeld(words));
      expect(part(saved.files, "word/styles.xml")).toBe(
        part(saved.original, "word/styles.xml").replace(/<!--.*?-->/gs, ""),
      );
      expect(part(saved.files, "word/document.xml")).toContain(run(words.kept));
      expectNoneOf(saved.files, [MARKUP_WORDS.comment, MARKUP_WORDS.instruction]);
    });

    // protects=the words of a table row someone's change deleted, or one it inserted, are not in the agent's file, as with any other deletion or insertion (#3751); fails_when=the words of either row, or a mark of the change, are in the agent's file
    it("takes out the words of a row someone deleted and of one someone inserted", async () => {
      const saved = await savedFor(language, rowsRevised(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const document = part(saved.files, "word/document.xml");
      expect(document).toContain(run(words.kept));
      expect(document).not.toMatch(/<w:del |<w:ins |w:author/);
      expectNoneOf(saved.files, [words.deleted, words.headerAdded, words.deletedBy]);
    });

    // protects=the words a run holds beside a field's marker stay when the field is written as its result (#3751); fails_when=the words before the field's start, or after its end, in the marker's own run, are lost
    it("keeps the words that share a run with a field's marker", async () => {
      const saved = await savedFor(language, fieldInRuns(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const document = part(saved.files, "word/document.xml");
      expect(document).not.toMatch(/LINK|fldChar/);
      for (const shown of [words.link, words.linked, words.noteText]) {
        expect(document).toContain(escapeXml(shown));
      }
      expectNoneOf(saved.files, [words.path]);
    });

    // protects=a field written inside another field's instruction goes with that instruction, its result too (#3751); fails_when=the inner field's result, or the outer field, is in the agent's file, or the outer field's own result is not
    it("takes out a field written inside a field's instruction with its result", async () => {
      const saved = await savedFor(language, fieldNested(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const document = part(saved.files, "word/document.xml");
      expect(document).not.toMatch(/LINK|DOCPROPERTY|fldChar/);
      expect(document).toContain(run(words.linked));
      expectNoneOf(saved.files, [words.protection]);
    });

    // protects=a link written as a field shows its words and no address, as the Note holds none for it: an address of words the Note has, though none of its links, is not in the agent's file (#3751); fails_when=the field's address is in the agent's file, the link the Note holds is lost, or the file is written new
    it("writes a link written as a field as its words, without its address", async () => {
      const other = `${words.web}/harbour/plan`;
      const saved = await savedFor(language, linkAsField(words, other));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const document = part(saved.files, "word/document.xml");
      expect(document).not.toContain("HYPERLINK");
      expect(document).toContain(escapeXml(words.street));
      expect(part(saved.files, "word/_rels/document.xml.rels")).toContain(words.web);
      expectNoneOf(saved.files, [other]);
    });

    // protects=a property is kept only as the number or the date it is: a value that is anyone's words goes (#3751); fails_when=a revision, a count, a version or a date that is words is in the agent's file
    it("keeps a property only when its value is a number or a date", async () => {
      const saved = await savedFor(language, propertiesWorded(words));
      const core = part(saved.files, "docProps/core.xml");
      expect(core).toContain("2026-10-02T09:00:00Z");
      const app = part(saved.files, "docProps/app.xml");
      expect(app).toContain("<Pages>1</Pages>");
      expect(app).toContain("<Characters>4827</Characters>");
      expectNoneOf(saved.files, [
        words.formHelp,
        words.formStatus,
        words.formName,
        words.formDefault,
      ]);
    });

    // protects=a Note whose imported Word file is gone from the computer still gets its Word file, written new from the Note, as before the original was kept (#3751); fails_when=save_as_word fails, or the file keeps the original's styles it can't have read
    it("writes the file new when the Word file the Note came from can't be read", async () => {
      const bytes = wordFile({ body: paragraph(run(words.kept)) });
      const saved = await savedFor(language, bytes, undefined, (path) => rm(path));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expect(part(saved.files, "word/document.xml")).toContain(escapeXml(words.kept));
    });

    // protects=a picture Word shows cropped is the whole image in the Note and the whole image in the agent's file, so no pixel is in the file that the Note doesn't hold (#3751); fails_when=the Note's picture is cut to the crop but the file's isn't, or the file's picture is not the Note's
    it("holds a cropped picture as the Note holds it, the whole image", async () => {
      const saved = await savedFor(language, pictureCropped(words));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      expect(saved.files.get("word/media/crop.png")).toEqual(CROPPED_PNG);
      const held = [
        ...JSON.stringify(saved.note).matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g),
      ];
      expect(held.map(([, data]) => Buffer.from(data ?? "", "base64"))).toEqual([CROPPED_PNG]);
    });

    // protects=the check reads the words a date control's picture shows, so ones the Note doesn't hold make the agent's file be written new (#3751); fails_when=the picture's words are in the agent's file
    it("writes the file new when a date's picture shows words the agent wasn't given", async () => {
      const saved = await savedFor(language, datePictured(words));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.dateNote]);
    });

    // protects=a table of contents' \t list and STYLEREF name a style someone named by its new name, so the file is written into the original without the old one (#3751); fails_when=the old name is in the agent's file's bytes, or the file is written new
    it("renames a style a table of contents or a header's field names", async () => {
      const saved = await savedFor(language, contentsByStyle(words));
      expect(part(saved.files, "word/styles.xml")).toContain(
        '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Style1"><w:name w:val="Style 1"/>',
      );
      const document = part(saved.files, "word/document.xml");
      expect(document).toContain(escapeXml('TOC \\o "1-1" \\h \\z \\t "Style 1,2" '));
      expect(document).toContain('<w:pStyle w:val="Style1"/>');
      expect(part(saved.files, "word/header1.xml")).toContain(
        escapeXml('STYLEREF "Style 1" \\* MERGEFORMAT'),
      );
      expectNoneOf(saved.files, [words.styleName, words.styleId]);
    });

    // protects=the check reads a table of contents' switch arguments as words unless they are levels, separators or Word's own, so a bookmark someone named or a caption's label the Note doesn't hold makes the agent's file be written new (#3751); fails_when=the bookmark's name or the label is in the agent's file
    it.each([
      ["a bookmark", (each: Words) => `\\b ${each.bookmark}`, (each: Words) => each.bookmark],
      [
        "a caption's label",
        (each: Words) => `\\c "${each.captionLabel}"`,
        (each: Words) => each.captionLabel,
      ],
    ])(
      "writes the file new when a table of contents names %s the agent wasn't given",
      async (_, switched, planted) => {
        const saved = await savedFor(
          language,
          fielded(words, `TOC \\o "1-3" \\h \\z ${switched(words)}`, words.street),
        );
        expect(part(saved.files, "word/styles.xml")).not.toBe(
          part(saved.original, "word/styles.xml"),
        );
        expectNoneOf(saved.files, [planted(words)]);
      },
    );

    // protects=a table of contents with only Word's own switches, levels and separators is written into the original (#3751); fails_when=the file is written new
    it("keeps a table of contents of Word's own switches", async () => {
      const instruction = 'TOC \\o "1-3" \\h \\z \\u \\p "-" \\f C \\l "1-2"';
      const saved = await savedFor(language, fielded(words, instruction, words.street));
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      expect(part(saved.files, "word/document.xml")).toContain(escapeXml(instruction));
    });

    // protects=a style's name a field holds that is no style the file renames makes the agent's file be written new (#3751); fails_when=the name is in the agent's file
    it("writes the file new when a table of contents names a style the file doesn't have", async () => {
      const saved = await savedFor(language, contentsByStyle(words, false));
      expect(part(saved.files, "word/styles.xml")).not.toBe(
        part(saved.original, "word/styles.xml"),
      );
      expectNoneOf(saved.files, [words.styleName]);
    });

    // protects=the check reads the words a field's date picture, number picture and \* format show, so ones the Note doesn't hold make the agent's file be written new (#3751); fails_when=the picture's or format's words are in the agent's file
    it.each([
      ["date", (note: string) => `DATE \\@ "'${note}' MMMM yyyy"`, "October 2026"],
      ["number", (note: string) => `= 1+1 \\# "0 '${note}'"`, "2"],
      ["format", (note: string) => `PAGE \\* "${note}"`, "1"],
    ])(
      "writes the file new when a field's %s picture shows words the agent wasn't given",
      async (_, instruction, result) => {
        const saved = await savedFor(language, fielded(words, instruction(words.dateNote), result));
        expect(part(saved.files, "word/styles.xml")).not.toBe(
          part(saved.original, "word/styles.xml"),
        );
        expectNoneOf(saved.files, [words.dateNote]);
      },
    );

    // protects=a field's picture that shows only what its result shows, such as 'yyyy'年'M'月'd'日'', and Word's own formats keep the file written into the original (#3751); fails_when=the file is written new
    it("keeps fields whose pictures show only what they show", async () => {
      const instructions = PICTURED[language];
      const saved = await savedFor(
        language,
        wordFile({
          body: [
            paragraph(run(words.kept)),
            ...instructions.map(([instruction, result]) => paragraph(field(instruction, result))),
          ].join(""),
        }),
      );
      expect(part(saved.files, "word/styles.xml")).toBe(part(saved.original, "word/styles.xml"));
      const document = part(saved.files, "word/document.xml");
      for (const [instruction] of instructions) expect(document).toContain(escapeXml(instruction));
    });

    // protects=a contract Chinese Word made keeps its styles, header and footer byte for byte: Word's short ids (a, a0 to a7, 1, 10) and 字符 after a linked style's name are Word's own (#3751); fails_when=a style is renamed or the file is written new
    it("keeps a Chinese Word contract's styles, header and footer as they are", async () => {
      const saved = await savedFor(language, chineseWordContract(words));
      for (const name of ["word/styles.xml", "word/header1.xml", "word/footer1.xml"]) {
        expect(part(saved.files, name)).toBe(part(saved.original, name));
      }
    });

    // protects=a shape Word gave no id of its own gets one no other shape in the package has, above the highest it holds (#3751); fails_when=the header's and the body's shapes share an id, or one is at or below an id the file holds
    it("gives the shapes someone named ids no other shape has", async () => {
      const saved = await savedFor(language, shapesNamed(words));
      const idOf = (name: string) =>
        Number(/<v:rect id="_x0000_s(\d+)"/.exec(part(saved.files, name))?.[1]);
      const ids = [idOf("word/document.xml"), idOf("word/header1.xml")];
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id).toBeGreaterThan(5000);
      expect(part(saved.files, "word/document.xml")).toContain('<v:oval id="_x0000_s5000"');
      expectNoneOf(saved.files, [words.shapeName]);
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
