/**
 * A reviewed contract with words planted where a Word file keeps them out of sight: in someone's
 * deletions and insertions, pictures and links inside deletions, a field reading another file,
 * a content control's and a smart tag's names, the properties and the settings (#3751).
 */
import type { JSONContent } from "@tiptap/core";
import { expect } from "vitest";
import { parseXml } from "../../src/core/documents/formats/xml";
import { knownIn, textsOf, vocabularyOf } from "../../src/core/exports/wordPatch/forAgentWords";
import { part, unzip } from "./docx";
import {
  escapeXml,
  field,
  note,
  noteMark,
  PNG,
  paragraph,
  picture,
  run,
  tracked,
  wordFile,
} from "./word";
import { buildZip } from "./zip";

export const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
export const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
export const HEADER_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";

export type Language = "en" | "zh-CN";

/** The words of each file: what the Note keeps, and what someone else wrote or named. */
export const WORDS = {
  en: {
    kept: "Clause one stays.",
    deleted: " withdrawn by the board",
    deletedBy: "Dana Kim",
    picturedClause: "Clause three with a picture.",
    alt: "Quay plan",
    gone: "Clause the User took out.",
    link: "Linked figure: ",
    linked: "4 berths",
    path: "C:\\Users\\dkim\\Private\\Berths.xlsx",
    control: "Clause in a control.",
    tag: "Reviewer only",
    alias: "Dana's box",
    street: "Harbour Street",
    smart: "Kim family office",
    settled: "Settlement floor",
    settledShown: "two million",
    formatted: "Clause with a change of format.",
    formattedBy: "Luis Ortega",
    noteText: "Note text.",
    noteDeleted: " and the side letter",
    header: "Head",
    headerAdded: " for the Ortega file",
    headerLink: "old link",
    footer: "Footer the User took out",
    protection: "SECRETHASH",
    company: "Kim Ortega LLP",
    base: "\\\\fs\\matters\\2291",
    hlink: "https://hlinks.example/z",
    orphan: "https://orphan.example/x",
    deletedLink: "https://deleted-link.example/y",
    title: "Board margins",
    choice: "Option shown",
    choiceValue: "SHOWNVALUE",
    hiddenChoice: "Option withheld",
    hiddenValue: "WITHHELDVALUE",
    formAnswer: "Answer typed",
    formName: "DanaField",
    formHelp: "Ask Dana first",
    formStatus: "Kim status line",
    formDefault: "Kim default answer",
    formChosen: "Low offer",
    formOther: "High offer withheld",
    watermark: "KIM CONFIDENTIAL DRAFT",
    linkTip: "Kim private tip",
    web: "https://harbour.example/plan",
    webText: "Harbour plan",
  },
  "zh-CN": {
    kept: "第一条保留。",
    deleted: "（董事会已撤回）",
    deletedBy: "王丽",
    picturedClause: "第三条附有图片。",
    alt: "码头平面图",
    gone: "用户删去的条款。",
    link: "链接的数字：",
    linked: "四个泊位",
    path: "C:\\Users\\wangli\\私人\\泊位.xlsx",
    control: "控件中的条款。",
    tag: "仅限审阅人",
    alias: "王丽的框",
    street: "港口大街",
    smart: "王氏家族办公室",
    settled: "和解底线",
    settledShown: "两百万",
    formatted: "格式有改动的条款。",
    formattedBy: "陈伟",
    noteText: "脚注文字。",
    noteDeleted: "以及附函",
    header: "页眉",
    headerAdded: "（陈伟档案）",
    headerLink: "旧链接",
    footer: "用户删去的页脚",
    protection: "SECRETHASH",
    company: "王陈律师事务所",
    base: "\\\\fs\\案件\\2291",
    hlink: "https://hlinks.example/z",
    orphan: "https://orphan.example/x",
    deletedLink: "https://deleted-link.example/y",
    title: "董事会利润率",
    choice: "显示的选项",
    choiceValue: "显示值标记",
    hiddenChoice: "未显示的选项",
    hiddenValue: "隐藏值标记",
    formAnswer: "填写的答复",
    formName: "王丽的域",
    formHelp: "请先问王丽",
    formStatus: "王丽状态栏",
    formDefault: "王丽默认答复",
    formChosen: "低报价",
    formOther: "未选的高报价",
    watermark: "王丽机密草稿",
    linkTip: "王丽的私人提示",
    web: "https://harbour.example/plan",
    webText: "港口规划",
  },
} as const;
export type Words = (typeof WORDS)[Language];

export const SECRET_PNG = Buffer.concat([PNG, Buffer.from("SECRETPICTURE")]);
export const HEADER_PNG = Buffer.concat([PNG, Buffer.from("HEADERDELPIC")]);
export const USER_PNG = Buffer.concat([PNG, Buffer.from("USERDELPIC")]);
export const ROOT_PNG = Buffer.concat([PNG, Buffer.from("ROOTPICTURE")]);

/** The words `reviewed` plants where no one reading the Note sees them, and no part may hold. */
export const plantedIn = (words: Words): string[] => [
  words.deleted,
  words.deletedBy,
  words.formattedBy,
  words.noteDeleted,
  words.headerAdded,
  words.headerLink,
  words.path,
  words.tag,
  words.alias,
  words.smart,
  words.settled,
  words.settledShown,
  words.protection,
  words.company,
  words.base,
  words.hlink,
  words.orphan,
  words.deletedLink,
  words.choiceValue,
  words.hiddenChoice,
  words.hiddenValue,
  words.formName,
  words.formHelp,
  words.formStatus,
  words.formDefault,
  words.formOther,
  words.watermark,
  words.linkTip,
  "SECRETPICTURE",
  "HEADERDELPIC",
  "USERDELPIC",
  "ROOTPICTURE",
];

/** A legacy form field's opening run, with its name and help: `list` makes it a drop-down. */
const formField = (words: Words, kind: "FORMTEXT" | "FORMDROPDOWN") => {
  const input =
    kind === "FORMTEXT"
      ? `<w:textInput><w:default w:val="${escapeXml(words.formDefault)}"/></w:textInput>`
      : `<w:ddList><w:result w:val="0"/><w:listEntry w:val="${escapeXml(words.formChosen)}"/><w:listEntry w:val="${escapeXml(words.formOther)}"/></w:ddList>`;
  const begin = `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="${escapeXml(words.formName)}"/><w:enabled/><w:calcOnExit w:val="0"/><w:helpText w:type="text" w:val="${escapeXml(words.formHelp)}"/><w:statusText w:type="text" w:val="${escapeXml(words.formStatus)}"/>${input}</w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> ${kind} </w:instrText></w:r>`;
  return kind === "FORMTEXT"
    ? `${begin}<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(words.formAnswer)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    : `${begin}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
};

/** A watermark, as Word writes one in a header: WordArt in VML. */
const watermark = (text: string) =>
  `<w:r><w:pict><v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:path textpathok="t" o:connecttype="custom"/><v:textpath on="t" fitshape="t"/></v:shapetype><v:shape id="PowerPlusWaterMarkObject1" o:spid="_x0000_s2049" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:400pt;height:100pt;z-index:-251657216" fillcolor="silver" stroked="f"><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${escapeXml(text)}"/></v:shape></w:pict></w:r>`;

const drawingOf = (id: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="7" name="Picture 7"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/** The package `bytes` with these parts in place and the properties' relationships from its root. */
export function withParts(bytes: Buffer, parts: Record<string, string>, types: string): Buffer {
  const files = unzip(bytes);
  for (const [name, data] of Object.entries(parts)) files.set(name, Buffer.from(data));
  const contentTypes = part(files, "[Content_Types].xml").replace("</Types>", `${types}</Types>`);
  files.set("[Content_Types].xml", Buffer.from(contentTypes));
  return buildZip([...files].map(([name, data]) => ({ name, data })));
}

/**
 * A contract someone reviewed: their deletions and insertions in the body, a note and the header,
 * pictures and a link inside deletions, a link nothing uses, a field reading another file, a
 * content control and a smart tag with their names and data, a property shown only in deleted
 * text, a drop-down's other choices, legacy form fields' names, help and lists, a watermark, a
 * link's tip, a picture the package's root names, a protection's hash and the file's ids in its
 * settings, and its properties' names and paths; a clause with a picture and the footer are the
 * ones the User takes out of the Note.
 */
export function reviewed(words: Words): Buffer {
  const body = [
    paragraph(`${run(words.kept)}${tracked("del", 50, words.deletedBy, words.deleted)}`),
    paragraph(
      `${run(words.picturedClause)}<w:del w:id="51" w:author="${escapeXml(words.deletedBy)}" w:date="2026-10-02T09:00:00Z">${drawingOf("rIdSecretPic")}</w:del>${picture("rIdPic", words.alt)}`,
    ),
    paragraph(`${run(words.gone)}${picture("rIdUserPic", words.alt)}`),
    paragraph(
      `${run(words.link)}${field(`LINK Excel.Sheet.12 "${words.path}" "Sheet1!R1C1" \\a \\f 4 \\h`, words.linked)}`,
    ),
    `<w:sdt><w:sdtPr><w:alias w:val="${escapeXml(words.alias)}"/><w:tag w:val="${escapeXml(words.tag)}"/><w:id w:val="9"/></w:sdtPr><w:sdtContent>${paragraph(run(words.control))}</w:sdtContent></w:sdt>`,
    paragraph(
      `<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="address"><w:smartTagPr><w:attr w:name="Owner" w:val="${escapeXml(words.smart)}"/></w:smartTagPr>${run(words.street)}</w:smartTag>`,
    ),
    paragraph(
      `${run(words.kept)}<w:del w:id="52" w:author="${escapeXml(words.deletedBy)}" w:date="2026-10-02T09:00:00Z"><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText xml:space="preserve"> DOCPROPERTY "${escapeXml(words.settled)}" </w:delInstrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:delText>${escapeXml(words.settledShown)}</w:delText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:del>`,
    ),
    `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="53" w:author="${escapeXml(words.formattedBy)}" w:date="2026-10-02T09:00:00Z"><w:pPr/></w:pPrChange></w:pPr><w:r><w:rPr><w:i/><w:rPrChange w:id="54" w:author="${escapeXml(words.formattedBy)}" w:date="2026-10-02T09:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>${escapeXml(words.formatted)}</w:t></w:r></w:p>`,
    paragraph(`${run(words.kept)}${noteMark("footnote", 1)}`),
    `<w:sdt><w:sdtPr><w:id w:val="11"/><w:dropDownList w:lastValue="${escapeXml(words.choiceValue)}"><w:listItem w:displayText="${escapeXml(words.choice)}" w:value="${escapeXml(words.choiceValue)}"/><w:listItem w:displayText="${escapeXml(words.hiddenChoice)}" w:value="${escapeXml(words.hiddenValue)}"/></w:dropDownList></w:sdtPr><w:sdtContent>${paragraph(run(words.choice))}</w:sdtContent></w:sdt>`,
    paragraph(formField(words, "FORMTEXT")),
    paragraph(`${run(words.kept)}${formField(words, "FORMDROPDOWN")}`),
    paragraph(
      `<w:hyperlink r:id="rIdWeb" w:tooltip="${escapeXml(words.linkTip)}">${run(words.webText)}</w:hyperlink>`,
    ),
  ].join("");
  const file = wordFile({
    body,
    footnotes: note("footnote", 1, [
      `${run(words.noteText)}${tracked("del", 60, words.deletedBy, words.noteDeleted)}`,
    ]),
    headers: {
      rIdH1:
        paragraph(
          `${run(words.header)}${tracked("ins", 70, words.formattedBy, words.headerAdded)}<w:hyperlink r:id="rIdDelLink"><w:del w:id="71" w:author="${escapeXml(words.deletedBy)}" w:date="2026-10-02T09:00:00Z"><w:r><w:delText>${escapeXml(words.headerLink)}</w:delText></w:r></w:del></w:hyperlink><w:del w:id="72" w:author="${escapeXml(words.deletedBy)}" w:date="2026-10-02T09:00:00Z">${drawingOf("rIdHeadPic")}</w:del>`,
        ) + paragraph(watermark(words.watermark)),
    },
    footers: { rIdF1: paragraph(run(words.footer)) },
    settings: `<w:zoom w:percent="100"/><w:documentProtection w:edit="readOnly" w:enforcement="0" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="${words.protection}==" w:salt="c2FsdA=="/><w:defaultTabStop w:val="720"/><w:docVars><w:docVar w:name="Matter" w:val="${escapeXml(words.company)}"/></w:docVars><w:rsids><w:rsidRoot w:val="00A1B2C3"/></w:rsids><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w14:docId w14:val="1A2B3C4D"/><w15:docId xmlns:w15="${W15}" w15:val="{6B1C2D3E-0000-4000-8000-000000000002}"/>`,
    sectPr:
      '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/>',
    media: {
      rIdPic: { name: "media/image1.png", data: PNG },
      rIdSecretPic: { name: "media/secret.png", data: SECRET_PNG },
      rIdUserPic: { name: "media/user.png", data: USER_PNG },
    },
    rels: `<Relationship Id="rIdOrphan" Type="${REL}/hyperlink" Target="${words.orphan}" TargetMode="External"/><Relationship Id="rIdWeb" Type="${REL}/hyperlink" Target="${words.web}" TargetMode="External"/>`,
  });
  return withParts(
    file,
    {
      "word/_rels/header1.xml.rels": `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rIdDelLink" Type="${REL}/hyperlink" Target="${words.deletedLink}" TargetMode="External"/><Relationship Id="rIdHeadPic" Type="${REL}/image" Target="media/headdel.png"/></Relationships>`,
      "word/media/headdel.png": HEADER_PNG.toString("latin1"),
      "_rels/.rels": `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${PACKAGE}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId4" Type="${REL}/custom-properties" Target="docProps/custom.xml"/><Relationship Id="rId5" Type="${REL}/image" Target="docProps/rootpic.png"/></Relationships>`,
      "docProps/rootpic.png": ROOT_PNG.toString("latin1"),
      "docProps/core.xml": `${DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${escapeXml(words.deletedBy)}</dc:creator><dc:language>en-GB</dc:language><cp:lastPrinted>2026-10-01T08:00:00Z</cp:lastPrinted><cp:revision>4</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-28T08:00:00Z</dcterms:created></cp:coreProperties>`,
      "docProps/app.xml": `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><Pages>1</Pages><HyperlinkBase>${escapeXml(words.base)}</HyperlinkBase><HLinks><vt:vector size="1" baseType="variant"><vt:variant><vt:lpwstr>${words.hlink}</vt:lpwstr></vt:variant></vt:vector></HLinks><Company>${escapeXml(words.company)}</Company><Application>Microsoft Office Word</Application></Properties>`,
      "docProps/custom.xml": `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${escapeXml(words.settled)}"><vt:lpwstr>${escapeXml(words.settledShown)}</vt:lpwstr></property></Properties>`,
    },
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>`,
  );
}

/** Asserts no part holds any of `words`, as written or escaped: read as bytes, whatever the part. */
export function expectNoneOf(files: Map<string, Buffer>, words: readonly string[]): void {
  const found = [...files].flatMap(([name, data]) =>
    words
      .filter(
        (word) => data.includes(Buffer.from(word)) || data.includes(Buffer.from(escapeXml(word))),
      )
      .map((word) => ({ part: name, word })),
  );
  expect(found).toEqual([]);
}

/** The Note's Blocks without those holding any of `texts`: what the User took out of it. */
export const without =
  (...texts: string[]) =>
  (blocks: JSONContent[]) =>
    blocks.filter((block) => !texts.some((text) => JSON.stringify(block).includes(text)));

/**
 * Asserts the agent's Word file holds only what read_mind gave the agent as `markdown`: every
 * text of every part, alt text and field instructions too, and every link it leads out to.
 */
export function expectOnlyGiven(files: Map<string, Buffer>, markdown: string): void {
  const vocabulary = vocabularyOf([markdown]);
  const unknown = [...files].flatMap(([name, data]) => {
    const text = data.toString("utf8");
    if (!text.trimStart().startsWith("<")) return [];
    return textsOf(parseXml(text))
      .filter((each) => !knownIn(each, vocabulary))
      .map((each) => ({ part: name, text: each }));
  });
  if (unknown.length > 0) console.log("UNKNOWN", JSON.stringify(unknown));
  expect(unknown).toEqual([]);
  const targets = [...files]
    .filter(([name]) => name.endsWith(".rels"))
    .flatMap(([, rels]) =>
      [...rels.toString("utf8").matchAll(/Target="([^"]*)" TargetMode="External"/g)].map(
        ([, target]) => target ?? "",
      ),
    );
  expect(targets.filter((target) => !markdown.includes(target))).toEqual([]);
}
