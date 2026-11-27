/**
 * An invented contract two people reviewed in Word, in English and Chinese, for the Word file
 * IncarnaMind writes into for an outside agent (#3751): numbered clauses, a table of contents, a
 * REF to a bookmarked sub-clause, comments by both people, a tracked insertion and a format change,
 * a tracked change in the header, a footer field showing a custom property, and the people and
 * words its properties, variables, custom XML and the rest hold.
 */
import { unzip } from "./docx";
import { escapeXml, field, paragraph, run, STYLES, tracked, wordFile } from "./word";
import { CHINESE_CONTRACT, type Contract, ENGLISH_CONTRACT, sub } from "./wordContracts";
import { buildZip } from "./zip";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const MS = "http://schemas.microsoft.com/office/2011/relationships";
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";

interface Words {
  contract: Contract;
  title: string;
  /** The two reviewers: the first wrote the file and the header's change, the second the body's. */
  people: [string, string];
  manager: string;
  company: string;
  /** The custom property the footer's field shows. */
  client: string;
  /** A custom property no text shows, and a document variable no field shows. */
  hidden: [name: string, value: string];
  variable: string;
  comments: [string, string];
  inserted: string;
  description: string;
  header: string;
  headerAdded: string;
  footer: string;
  /** Where the first reviewer's template is on their computer. */
  template: string;
  email: string;
}

const WORDS: Record<"en" | "zh-CN", Words> = {
  en: {
    contract: ENGLISH_CONTRACT,
    title: "Packaging services agreement",
    people: ["Dana Kim", "Luis Ortega"],
    manager: "Priya Nair",
    company: "Kim Ortega LLP",
    client: "Alder & Finch Ltd",
    hidden: ["Reviewer notes", "Push back on the interest cap"],
    variable: "Settle above two percent",
    comments: ["Check the scope with Alder first.", "Is this rate too high?"],
    inserted: " and prints",
    description: "Draft for the Alder call",
    header: "Confidential",
    headerAdded: " draft",
    footer: "Prepared for ",
    template: "file:///Users/dkim/Templates/Contract.dotx",
    email: "dana.kim@kimortega.example",
  },
  "zh-CN": {
    contract: CHINESE_CONTRACT,
    title: "包装服务协议",
    people: ["王丽", "陈伟"],
    manager: "周敏",
    company: "王陈律师事务所",
    client: "远帆贸易有限公司",
    hidden: ["审阅备注", "利率上限需要再谈"],
    variable: "利息高于百分之二再议",
    comments: ["先与远帆确认服务范围。", "这个利率是否过高？"],
    inserted: "及印刷",
    description: "远帆通话前的草稿",
    header: "保密",
    headerAdded: "草稿",
    footer: "编制对象：",
    template: "file:///Users/wangli/Templates/合同.dotx",
    email: "wang.li@wangchen.example",
  },
};

export interface ReviewedContract {
  bytes: Buffer;
  words: Words;
  /** Every name and word of someone else's in the file that no text of it shows. */
  others: string[];
}

const comment = (id: number, paraId: string, author: string, text: string) =>
  `<w:comment w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-02T09:00:00Z" w:initials="${escapeXml(author.slice(0, 2))}"><w:p w14:paraId="${paraId}"><w:r><w:annotationRef/></w:r>${run(text)}</w:p></w:comment>`;

const commentedRun = (id: number, text: string) =>
  `<w:commentRangeStart w:id="${id}"/>${run(text)}<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;

/** A table of contents of the clauses, as Word writes one, each entry a link to its heading's page. */
const contents = (headings: readonly string[]) =>
  headings
    .map((heading, at) => {
      const begin =
        at === 0
          ? `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`
          : "";
      const end = at === headings.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : "";
      return `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${begin}${run(heading)}<w:r><w:tab/></w:r>${run("1")}${end}</w:p>`;
    })
    .join("");

/** The contract two people reviewed, in the language its words are in. */
export function reviewedContract(language: "en" | "zh-CN"): ReviewedContract {
  const words = WORDS[language];
  const { contract, people } = words;
  const [first, second] = people;
  // The contract's own clauses, one sub-clause each commented on and one given an insertion.
  const [services, scope, fees, monthly, due, bookmarked, termination] = contract
    .body(contract.reference)
    .split(/(?=<w:p[ >])/);
  const textOf = (xml: string | undefined) =>
    [...(xml ?? "").matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
      .map((match) =>
        (match[1] ?? "")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&"),
      )
      .join("");
  const headings = [services, fees, termination].map(textOf);
  const feesBold = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b/><w:rPrChange w:id="31" w:author="${escapeXml(first)}" w:date="2026-10-02T09:30:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t xml:space="preserve">${escapeXml(headings[1] ?? "")}</w:t></w:r></w:p>`;
  const body = [
    contents(headings),
    services,
    sub(commentedRun(10, textOf(scope))),
    feesBold,
    sub(`${run(textOf(monthly))}${tracked("ins", 30, second, words.inserted)}`),
    sub(commentedRun(11, textOf(due))),
    bookmarked,
    termination,
    sub(contract.reference),
  ].join("");
  const sectPr =
    '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/>';
  const extended = `${DECLARATION}<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx w15:paraId="2A000001" w15:done="0"/><w15:commentEx w15:paraId="2A000002" w15:done="0"/></w15:commentsEx>`;
  const peopleXml = `${DECLARATION}<w15:people xmlns:w15="${W15}">${people
    .map(
      (person, at) =>
        `<w15:person w15:author="${escapeXml(person)}"><w15:presenceInfo w15:providerId="AD" w15:userId="${at === 0 ? words.email : "S::lo@kimortega.example"}"/></w15:person>`,
    )
    .join("")}</w15:people>`;
  const generated = unzip(
    wordFile({
      styles: `${STYLES}<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>`,
      numbering: contract.numbering,
      body,
      comments: [
        comment(10, "2A000001", first, words.comments[0]),
        comment(11, "2A000002", second, words.comments[1]),
      ].join(""),
      headers: {
        rIdH1: paragraph(`${run(words.header)}${tracked("ins", 40, first, words.headerAdded)}`),
      },
      footers: {
        rIdF1: paragraph(
          `${run(words.footer)}${field("DOCPROPERTY Client \\* MERGEFORMAT", words.client)}`,
        ),
      },
      settings: `<w:attachedTemplate r:id="rIdT1"/><w:docVars><w:docVar w:name="MatterNote" w:val="${escapeXml(words.variable)}"/></w:docVars>`,
      rels:
        `<Relationship Id="rIdCommentsExtended" Type="${MS}/commentsExtended" Target="commentsExtended.xml"/>` +
        `<Relationship Id="rIdPeople" Type="${MS}/people" Target="people.xml"/>` +
        `<Relationship Id="rIdCustomXml" Type="${OFFICE}/customXml" Target="../customXml/item1.xml"/>`,
      sectPr,
      parts: [
        { name: "word/commentsExtended.xml", data: extended },
        { name: "word/people.xml", data: peopleXml },
        {
          name: "word/_rels/settings.xml.rels",
          data: `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rIdT1" Type="${OFFICE}/attachedTemplate" Target="${escapeXml(words.template)}" TargetMode="External"/></Relationships>`,
        },
        {
          name: "customXml/item1.xml",
          data: `${DECLARATION}<review><reviewer>${escapeXml(first)}</reviewer><note>${escapeXml(words.hidden[1])}</note></review>`,
        },
        {
          name: "customXml/_rels/item1.xml.rels",
          data: `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${OFFICE}/customXmlProps" Target="itemProps1.xml"/></Relationships>`,
        },
        {
          name: "customXml/itemProps1.xml",
          data: `${DECLARATION}<ds:datastoreItem ds:itemID="{6B1C2D3E-0000-4000-8000-000000000001}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`,
        },
        {
          name: "docProps/core.xml",
          data: `${DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(words.title)}</dc:title><dc:subject>${escapeXml(words.title)}</dc:subject><dc:creator>${escapeXml(first)}</dc:creator><cp:keywords>${escapeXml(words.client)}</cp:keywords><dc:description>${escapeXml(words.description)}</dc:description><cp:lastModifiedBy>${escapeXml(second)}</cp:lastModifiedBy><cp:revision>7</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-28T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-02T11:00:00Z</dcterms:modified></cp:coreProperties>`,
        },
        {
          name: "docProps/app.xml",
          data: `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Contract.dotx</Template><TotalTime>94</TotalTime><Pages>1</Pages><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${escapeXml(words.title)}</vt:lpstr></vt:vector></TitlesOfParts><Manager>${escapeXml(words.manager)}</Manager><Company>${escapeXml(words.company)}</Company><AppVersion>16.0000</AppVersion></Properties>`,
        },
        {
          name: "docProps/custom.xml",
          data: `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>${escapeXml(words.client)}</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="${escapeXml(words.hidden[0])}"><vt:lpwstr>${escapeXml(words.hidden[1])}</vt:lpwstr></property></Properties>`,
        },
        { name: "docProps/thumbnail.jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      ],
    }),
  );
  generated.set(
    "_rels/.rels",
    Buffer.from(
      `${DECLARATION}<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${PACKAGE}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${OFFICE}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId4" Type="${OFFICE}/custom-properties" Target="docProps/custom.xml"/><Relationship Id="rId5" Type="${PACKAGE}/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>`,
    ),
  );
  const types = (generated.get("[Content_Types].xml") ?? Buffer.alloc(0)).toString("utf8");
  generated.set(
    "[Content_Types].xml",
    Buffer.from(
      types.replace(
        "</Types>",
        `<Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/commentsExtended.xml" ContentType="${WML}.commentsExtended+xml"/><Override PartName="/word/people.xml" ContentType="${WML}.people+xml"/><Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
      ),
    ),
  );
  const bytes = buildZip([...generated].map(([name, data]) => ({ name, data })));
  return {
    bytes,
    words,
    others: [
      ...people,
      words.manager,
      words.company,
      words.hidden[0],
      words.hidden[1],
      words.variable,
      ...words.comments,
      words.description,
      words.template,
      words.email,
    ],
  };
}
