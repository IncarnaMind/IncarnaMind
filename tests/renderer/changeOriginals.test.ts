import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  type ChangedBlock,
  rewrittenSections,
} from "../../src/renderer/src/editor/changeOriginals";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { ProposalReview } from "../../src/renderer/src/editor/proposalReview";
import { changedBlocks } from "../../src/renderer/src/editor/proposalRewrites";

/*
 * How a waiting change reads (#1028; DESIGN.md, AI edits): a paragraph a
 * change writes anew is read whole, with its old text apart; a section whose
 * heading and most of whose paragraphs are written anew is one section.
 */

const mark = (type: "proposalInsert" | "proposalDelete", id: string) => ({
  type,
  attrs: { id, request: "r1" },
});
const words = (value: string, marks: JSONContent["marks"] = []): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks }),
});
/** A paragraph or heading whose text one change `id` writes anew, from `before` to `after`. */
const anew = (id: string, before: string, after: string): JSONContent[] => [
  words(before, [mark("proposalDelete", id)]),
  words(after, [mark("proposalInsert", id)]),
];
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const heading = (level: number, ...content: JSONContent[]): JSONContent => ({
  type: "heading",
  attrs: { level },
  content,
});

function docOf(content: JSONContent[]) {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), ProposalReview],
    content: { type: "doc", content },
  });
  onTestFinished(() => editor.destroy());
  return editor.state.doc;
}

describe("How a waiting change reads", () => {
  test("a paragraph written anew reads whole, its old text apart; a word replaced reads word by word", () => {
    const doc = docOf([
      paragraph(...anew("p1", "跨医疗、金融两个行业的数据分析经验。", "十年咨询与审计项目经验。")),
      paragraph(
        words("The tide "),
        words("turns", [mark("proposalDelete", "p2")]),
        words("rises", [mark("proposalInsert", "p2")]),
        words(" at noon."),
      ),
    ]);
    expect(
      changedBlocks(doc, new Set()).map(({ how, old, title }) => ({ how, old, title })),
    ).toEqual([
      {
        how: "rewritten",
        old: "跨医疗、金融两个行业的数据分析经验。",
        title: "十年咨询与审计项目经验。",
      },
      { how: "words", old: undefined, title: undefined },
    ]);
    // Changes of an edit still applying read as the text they make.
    expect(changedBlocks(doc, new Set(["r1"]))).toEqual([]);
  });

  test("a section whose heading and most of whose paragraphs are written anew is one section; with most kept, it isn't", () => {
    const rewritten = docOf([
      heading(2, ...anew("h", "履历亮点与待核实事项", "核心优势")),
      paragraph(...anew("a", "跨医疗、金融两个行业。", "十年咨询经验。")),
      paragraph(...anew("b", "熟悉财务建模。", "擅长团队管理。")),
      paragraph(words("英语 CET-6、雅思 7.5")),
      heading(2, words("教育背景")),
      paragraph(words("复旦大学 金融学 硕士")),
    ]);
    const blocks = changedBlocks(rewritten, new Set());
    const sections = rewrittenSections(rewritten, blocks, true);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading.title).toBe("核心优势");
    expect(sections[0]?.members.map((member) => member.key)).toEqual(["proposal:a", "proposal:b"]);

    const mostlyKept = docOf([
      heading(2, ...anew("h", "Highlights", "Key strengths")),
      paragraph(...anew("a", "Data across health and finance.", "Ten years of consulting.")),
      paragraph(words("Financial modelling.")),
      paragraph(words("English, IELTS 7.5.")),
    ]);
    expect(rewrittenSections(mostlyKept, changedBlocks(mostlyKept, new Set()), true)).toEqual([]);
  });

  test("an applied edit's Block removed at the end of a section is one of its members", () => {
    const doc = docOf([
      heading(2, words("Key strengths")),
      paragraph(words("Ten years of consulting.")),
      heading(2, words("Education")),
      paragraph(words("Fudan University.")),
    ]);
    const at: number[] = [];
    doc.forEach((_node, pos) => {
      at.push(pos);
    });
    const blocks: ChangedBlock[] = [
      { key: "h", pos: at[0] ?? 0, how: "rewritten", title: "Key strengths" },
      { key: "a", pos: at[1] ?? 0, how: "rewritten" },
      // The old last paragraph of the first section: it sits where the next heading starts.
      { key: "gone", pos: at[2] ?? 0, how: "removed" },
    ];
    const sections = rewrittenSections(doc, blocks, false);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.members.map((member) => member.key)).toEqual(["a", "gone"]);
  });
});
