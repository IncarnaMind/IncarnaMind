/**
 * Formatting the editor doesn't show stays on the text an edit didn't touch (#746): a colour, a
 * highlight, a character style, an East Asian font and language, small caps, shading and an
 * emphasis mark, in English and Chinese, through a word replaced, a word made bold, a word
 * deleted, and Enter at a space or inside a word, which carries the rest of the paragraph into
 * a new one.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { descendants, parseXml } from "../../src/core/documents/formats/xml";
import { createTempDataFolder, startCore } from "../helpers/core";
import { part, type RunCharacter, runCharacters, unzip } from "../helpers/docx";
import { editMind } from "../helpers/minds";
import { escapeXml, paragraph, STYLES, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const formatted = (rPr: string, text: string) =>
  `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;

const CHARACTER_STYLE =
  '<w:style w:type="character" w:styleId="Defined"><w:name w:val="Defined Term"/><w:rPr><w:i/></w:rPr></w:style>';

/** A clause whose every run carries formatting the editor doesn't show; `edits` name its words. */
const LANGUAGES = [
  {
    language: "English",
    runs: [
      formatted('<w:color w:val="C00000"/>', "The Tenant "),
      formatted('<w:highlight w:val="yellow"/>', "pays the rent "),
      formatted('<w:rStyle w:val="Defined"/><w:lang w:val="en-GB"/>', "monthly in advance "),
      formatted('<w:smallCaps/><w:kern w:val="28"/>', "under this lease "),
      formatted('<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>', "to the Landlord."),
    ],
    replace: ["rent", "fee"],
    bold: "monthly",
    remove: "this ",
    space: "pays the rent ".length + "The Tenant ".length,
    inside: "The Tenant pays the rent mon".length,
  },
  {
    language: "Chinese",
    runs: [
      formatted(
        '<w:rFonts w:eastAsia="宋体"/><w:lang w:eastAsia="zh-CN"/><w:color w:val="C00000"/>',
        "承租人",
      ),
      formatted('<w:rFonts w:eastAsia="宋体"/><w:highlight w:val="yellow"/>', "应按月预付租金，"),
      formatted('<w:rStyle w:val="Defined"/><w:rFonts w:eastAsia="黑体"/>', "租金标准见附件一，"),
      formatted('<w:rFonts w:eastAsia="楷体"/><w:em w:val="dot"/>', "逾期按日计收违约金，"),
      formatted(
        '<w:rFonts w:eastAsia="宋体"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>',
        "直至付清为止。",
      ),
    ],
    replace: ["租金标准", "费用标准"],
    bold: "违约金",
    remove: "按日",
    space: "承租人应按月预付租金，".length,
    inside: "承租人应按月预付租金，租金标".length,
  },
] as const;

type Case = (typeof LANGUAGES)[number];

const fileOf = (each: Case) =>
  wordFile({
    styles: STYLES + CHARACTER_STYLE,
    body: `${paragraph(each.runs.join(""))}${paragraph("The next clause stays as it was.")}`,
  });

/** The edited paragraph's characters as written: the first paragraph, and the one Enter made after it. */
function writtenCharacters(data: Uint8Array, split: boolean): RunCharacter[] {
  const paragraphs = descendants(parseXml(part(unzip(data), "word/document.xml")), "w:p");
  const [first, second] = paragraphs;
  return [
    ...(first ? runCharacters(first) : []),
    ...(split && second ? runCharacters(second) : []),
  ];
}

/** The text nodes of a paragraph's content, cut at `at` characters. */
function cut(content: JSONContent[], at: number): [JSONContent[], JSONContent[]] {
  const left: JSONContent[] = [];
  const right: JSONContent[] = [];
  let reached = 0;
  for (const node of content) {
    const text = node.text ?? "";
    if (reached + text.length <= at) left.push(node);
    else if (reached >= at) right.push(node);
    else {
      left.push({ ...node, text: text.slice(0, at - reached) });
      right.push({ ...node, text: text.slice(at - reached) });
    }
    reached += text.length;
  }
  return [left, right];
}

const textOf = (node: JSONContent) => (node.content ?? []).map((each) => each.text ?? "").join("");

/** Edits the clause, the Note's first paragraph, as `change` says. */
const onClause =
  (change: (clause: JSONContent) => JSONContent[]) =>
  (blocks: JSONContent[]): JSONContent[] => {
    const at = blocks.findIndex((block) => block.type === "paragraph" && textOf(block) !== "");
    const clause = blocks[at];
    return clause ? [...blocks.slice(0, at), ...change(clause), ...blocks.slice(at + 1)] : blocks;
  };

const mapText = (
  clause: JSONContent,
  change: (text: string, node: JSONContent) => JSONContent[],
) => ({
  ...clause,
  content: (clause.content ?? []).flatMap((node) => change(node.text ?? "", node)),
});

/** Enter at `at`: the clause keeps its first part, a new paragraph like it takes the rest. */
const enterAt = (at: number) =>
  onClause((clause) => {
    const [left, right] = cut(clause.content ?? [], at);
    const { id: _id, ...attrs } = clause.attrs ?? {};
    return [
      { ...clause, content: left },
      { ...clause, attrs, content: right },
    ];
  });

async function exported(bytes: Buffer, edit: (blocks: JSONContent[]) => JSONContent[]) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  editMind(client, edit);
  await client.settled();
  return (await core.exportMind(mindId, { format: "docx" })).data;
}

/** The characters before and after an edit, paired outside what it replaced. */
function untouched(was: RunCharacter[], now: RunCharacter[]): [RunCharacter, RunCharacter][] {
  let prefix = 0;
  while (prefix < was.length && prefix < now.length && was[prefix]?.char === now[prefix]?.char)
    prefix++;
  let suffix = 0;
  while (
    suffix < was.length - prefix &&
    suffix < now.length - prefix &&
    was[was.length - 1 - suffix]?.char === now[now.length - 1 - suffix]?.char
  )
    suffix++;
  return [
    ...was
      .slice(0, prefix)
      .map((each, at) => [each, now[at] as RunCharacter] as [RunCharacter, RunCharacter]),
    ...was
      .slice(was.length - suffix)
      .map(
        (each, at) =>
          [each, now[now.length - suffix + at] as RunCharacter] as [RunCharacter, RunCharacter],
      ),
  ];
}

const formats = (pairs: [RunCharacter, RunCharacter][], ignore = (_: string) => false) =>
  pairs.map(([was, now]) => [
    `${was.char} ${was.format.filter((each) => !ignore(each)).join(" ")}`,
    `${now.char} ${now.format.filter((each) => !ignore(each)).join(" ")}`,
  ]);

describe("formatting the editor doesn't show, after an edit to its paragraph", () => {
  // protects=every character a replaced or deleted word leaves keeps its run's colour, highlight, character style, East Asian font, language, small caps, shading and emphasis mark, in English and Chinese; fails_when=any property is lost or gained on them; no_claim=the replacing word's own formatting, which takes the replaced word's.
  test.each(LANGUAGES.flatMap((each) => [["replaced", each] as const, ["deleted", each] as const]))(
    "a word %s (%s)",
    async (how, each) => {
      const bytes = fileOf(each);
      const data = await exported(
        bytes,
        onClause((clause) => [
          mapText(clause, (text, node) => {
            const [word, by] = how === "replaced" ? each.replace : [each.remove, ""];
            return text.includes(word) ? [{ ...node, text: text.replace(word, by) }] : [node];
          }),
        ]),
      );
      const pairs = untouched(writtenCharacters(bytes, false), writtenCharacters(data, false));
      expect(pairs.length).toBeGreaterThan(20);
      for (const [was, now] of formats(pairs)) expect(now).toBe(was);
    },
  );

  // protects=a word made bold keeps everything else its run had, and no other character changes; fails_when=the bold word loses its colour, font or style, or bold spreads; no_claim=Word's own way of writing bold over a style.
  test.each(LANGUAGES)("a word made bold ($language)", async (each) => {
    const bytes = fileOf(each);
    const data = await exported(
      bytes,
      onClause((clause) => [
        mapText(clause, (text, node) => {
          const at = text.indexOf(each.bold);
          if (at < 0) return [node];
          const bold = {
            ...node,
            text: each.bold,
            marks: [...(node.marks ?? []), { type: "bold" }],
          };
          return [
            ...(at > 0 ? [{ ...node, text: text.slice(0, at) }] : []),
            bold,
            ...(at + each.bold.length < text.length
              ? [{ ...node, text: text.slice(at + each.bold.length) }]
              : []),
          ];
        }),
      ]),
    );
    const was = writtenCharacters(bytes, false);
    const now = writtenCharacters(data, false);
    expect(now.map((character) => character.char).join("")).toBe(
      was.map((character) => character.char).join(""),
    );
    const pairs = was.map(
      (character, at) => [character, now[at] as RunCharacter] as [RunCharacter, RunCharacter],
    );
    for (const [before, after] of formats(pairs, (property) => /^w:bC?s?\{/.test(property)))
      expect(after).toBe(before);
  });

  // protects=Enter in the clause carries the rest of it into a new paragraph with every run's formatting, at a space and inside a word, in English and Chinese; fails_when=the new paragraph's text takes one run's formatting for all of it, as on main; no_claim=the paragraph's own properties, which a new paragraph takes from the one it follows.
  test.each(
    LANGUAGES.flatMap((each) => [["at a space", each] as const, ["inside a word", each] as const]),
  )("Enter %s (%s)", async (where, each) => {
    const bytes = fileOf(each);
    const data = await exported(bytes, enterAt(where === "at a space" ? each.space : each.inside));
    const was = writtenCharacters(bytes, false);
    const now = writtenCharacters(data, true);
    expect(now.map((character) => character.char).join("")).toBe(
      was.map((character) => character.char).join(""),
    );
    const pairs = was.map(
      (character, at) => [character, now[at] as RunCharacter] as [RunCharacter, RunCharacter],
    );
    for (const [before, after] of formats(pairs)) expect(after).toBe(before);
  });

  // protects=Enter before a link carries it into the new paragraph still a link, its run exactly as the file had it: the link style isn't added to a link the file formats by hand; fails_when=the carried link's run gains w:rStyle Hyperlink, or the link is lost; no_claim=a link the User adds, which takes the link style.
  test("Enter before a link carries it with its own look", async () => {
    const red = '<w:color w:val="C00000"/>';
    const link = `<w:hyperlink r:id="rIdLink">${formatted('<w:color w:val="0563C1"/><w:u w:val="single"/>', "the schedule")}</w:hyperlink>`;
    const bytes = wordFile({
      styles: STYLES,
      rels: '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/schedule" TargetMode="External"/>',
      body: `${paragraph(`${formatted(red, "The rent is set out in ")}${link}${formatted(red, ".")}`)}${paragraph("The next clause stays as it was.")}`,
    });
    const data = await exported(bytes, enterAt("The rent is set out in ".length));
    const [, second] = descendants(parseXml(part(unzip(data), "word/document.xml")), "w:p");
    expect(second ? descendants(second, "w:hyperlink") : []).toHaveLength(1);
    const was = writtenCharacters(bytes, false);
    const now = writtenCharacters(data, true);
    const pairs = was.map(
      (character, at) => [character, now[at] as RunCharacter] as [RunCharacter, RunCharacter],
    );
    for (const [before, after] of formats(pairs)) expect(after).toBe(before);
  });
});
