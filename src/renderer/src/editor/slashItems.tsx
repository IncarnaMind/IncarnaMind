import type { Editor, Range } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { ReactNode } from "react";
import { QUESTION_BLOCK, type Skill } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { SkillIcon } from "../components/icons";
import { ImageLineIcon } from "../components/lineIcons";
import { matchName, queryWords } from "../matcher";
import { showBibliography } from "./bibliographyCommands";
import { insertFootnote } from "./footnoteSchema";
import { TableIcon } from "./icons";
import { insertBlock } from "./insertBlock";
import { emptyTable } from "./tableCommands";

/**
 * One entry of the slash menu. To add one, add it to `noteSlashItems`, or
 * give `SlashMenu.configure({ items })` a list that includes it (as the
 * editor does with `skillSlashItems`).
 */
export interface SlashItem {
  /** A stable name. Tests find the item by it (`slash-item-<id>`), and typing it after the slash finds the item. */
  id: string;
  /** What the menu shows: a dictionary key, or text shown as it is (e.g. a Skill's name). */
  label: MessageKey | { text: string };
  /** Shown when the item is pointed at, e.g. what a Skill is for. */
  hint?: string;
  /** More words that find the item when typed after the slash, whatever the interface language. */
  keywords?: readonly string[];
  /** A small glyph before the label. */
  icon: ReactNode;
  /** Replaces the typed slash and query (`range`) with what the item inserts. */
  run(editor: Editor, range: Range): void;
}

const turnInto =
  (type: string, attrs?: Record<string, unknown>) =>
  (editor: Editor, range: Range): void => {
    editor.chain().focus().deleteRange(range).setNode(type, attrs).run();
  };

/** The slash menu's entries for writing Notes. */
export const noteSlashItems: readonly SlashItem[] = [
  {
    id: "text",
    label: "editor.slash.text",
    keywords: ["paragraph", "plain"],
    icon: "T",
    run: turnInto("paragraph"),
  },
  {
    id: "heading-1",
    label: "editor.slash.heading1",
    keywords: ["h1", "title"],
    icon: "H1",
    run: turnInto("heading", { level: 1 }),
  },
  {
    id: "heading-2",
    label: "editor.slash.heading2",
    keywords: ["h2", "subtitle"],
    icon: "H2",
    run: turnInto("heading", { level: 2 }),
  },
  {
    id: "heading-3",
    label: "editor.slash.heading3",
    keywords: ["h3"],
    icon: "H3",
    run: turnInto("heading", { level: 3 }),
  },
  {
    id: "bulleted-list",
    label: "editor.slash.bulletList",
    keywords: ["bullet", "ul", "unordered", "list"],
    icon: "•",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "editor.slash.numberedList",
    keywords: ["number", "ol", "ordered", "list"],
    icon: "1.",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "checklist",
    label: "editor.slash.checklist",
    keywords: ["todo", "task", "checkbox", "check"],
    icon: "☑",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "editor.slash.quote",
    keywords: ["blockquote", "citation"],
    icon: "❝",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: "picture",
    label: "editor.slash.picture",
    // "tupian" is 图片 in pinyin; "image" and "photo" are what it is called elsewhere.
    keywords: ["image", "photo", "picture", "screenshot", "tupian"],
    icon: <ImageLineIcon className="size-3.5" />,
    run(editor, range) {
      editor.chain().focus().deleteRange(range).run();
      editor.commands.choosePicture();
    },
  },
  {
    id: "divider",
    label: "editor.slash.divider",
    keywords: ["rule", "line", "hr", "separator"],
    icon: "—",
    run(editor, range) {
      const pos = insertBlock(editor, range, { type: "horizontalRule" });
      // The cursor goes on to the line after it.
      if (pos !== null) {
        editor
          .chain()
          .focus()
          .setTextSelection(TextSelection.near(editor.state.doc.resolve(pos + 1), 1).from)
          .run();
      }
    },
  },
  {
    id: "table",
    label: "editor.slash.table",
    keywords: ["grid", "columns", "rows"],
    icon: <TableIcon className="size-3.5" />,
    run(editor, range) {
      const pos = insertBlock(editor, range, emptyTable());
      // Into its first cell, to start typing the first heading.
      if (pos !== null) {
        editor
          .chain()
          .focus()
          .setTextSelection(TextSelection.near(editor.state.doc.resolve(pos + 1)).from)
          .run();
      }
    },
  },
  {
    id: "contents",
    label: "editor.slash.contents",
    keywords: ["toc", "outline", "contents", "mulu", "目录"],
    icon: "☰",
    run(editor, range) {
      const pos = insertBlock(editor, range, { type: "tableOfContents" });
      if (pos !== null) {
        editor
          .chain()
          .focus()
          .setTextSelection(TextSelection.near(editor.state.doc.resolve(pos + 1), 1).from)
          .run();
      }
    },
  },
  {
    id: "code",
    label: "editor.slash.codeBlock",
    keywords: ["code", "codeblock", "pre"],
    icon: "{ }",
    run: turnInto("codeBlock"),
  },
  {
    id: "math",
    label: "editor.slash.math",
    keywords: ["math", "equation", "formula", "latex", "katex", "tex"],
    icon: "∑",
    run(editor, range) {
      const pos = insertBlock(editor, range, { type: "blockMath", attrs: { latex: "" } });
      if (pos !== null) editor.commands.editMath(pos);
    },
  },
  {
    id: "inline-math",
    label: "editor.slash.inlineMath",
    keywords: ["math", "equation", "formula", "latex", "katex", "tex", "inline"],
    icon: "x²",
    run(editor, range) {
      editor
        .chain()
        .deleteRange(range)
        .insertContent({ type: "inlineMath", attrs: { latex: "" } })
        .run();
      editor.commands.editMath(range.from);
    },
  },
  {
    id: "footnote",
    label: "editor.slash.footnote",
    // "jiaozhu" is 脚注 in pinyin.
    keywords: ["note", "endnote", "jiaozhu"],
    icon: "¹",
    run(editor, range) {
      // No focus command: its focus comes a frame later, and would take it from the footnote's text.
      editor.commands.deleteRange(range);
      insertFootnote(editor);
    },
  },
  {
    id: "bibliography",
    label: "editor.slash.bibliography",
    keywords: ["sources", "references", "citations", "cankao", "wenxian"],
    icon: "§",
    run(editor, range) {
      editor.chain().focus().deleteRange(range).run();
      showBibliography(editor);
    },
  },
];

/**
 * "Compare Documents…" (#98): the slash and what was typed after it go, and
 * the sheet opens at the foot of the Mind, its table to go where they were.
 */
export function compareSlashItem(onCompare: (afterBlockId: string | null) => void): SlashItem {
  return {
    id: "compare",
    label: "command.compareDocuments",
    keywords: ["comparison", "table", "documents"],
    icon: <TableIcon className="size-3.5" />,
    run(editor, range) {
      editor.chain().focus().deleteRange(range).run();
      const { $from } = editor.state.selection;
      const block = $from.depth > 0 ? $from.node(1) : null;
      onCompare(typeof block?.attrs.id === "string" ? block.attrs.id : null);
    },
  };
}

/**
 * The slash menu's entries for the enabled Skills, labelled with their titles.
 * Choosing one forces the Skill on the Question the cursor is in; in a Note, it goes to the composer as a chip, for the Question asked
 * there next (`onComposer`), and the composer takes the focus.
 */
export function skillSlashItems(
  skills: readonly Skill[],
  describe: (skill: Skill) => string = (skill) => skill.description,
  onComposer: (skill: string) => void = () => undefined,
  titleOf: (skill: Skill) => string = (skill) => skill.name,
): SlashItem[] {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      id: `skill-${skill.name}`,
      label: { text: titleOf(skill) },
      hint: describe(skill),
      keywords: ["skill"],
      icon: <SkillIcon className="size-3.5" />,
      run(editor, range) {
        const inQuestion = editor.state.selection.$from.parent.type.name === QUESTION_BLOCK;
        if (!inQuestion) {
          editor.chain().focus().deleteRange(range).run();
          onComposer(skill.name);
          return;
        }
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .updateAttributes(QUESTION_BLOCK, { forcedSkill: skill.name })
          .run();
      },
    }));
}

/**
 * The items `query` finds, in their order: those with a word of their label,
 * ID or keywords starting with it, as a Chinese label is found by its pinyin
 * ("biaoge" for 表格) or initials ("bg") through the one matcher ⌘K uses.
 */
export function matchSlashItems(
  items: readonly SlashItem[],
  query: string,
  labelOf: (item: SlashItem) => string,
): SlashItem[] {
  const words = queryWords(query);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const text = [labelOf(item), item.id, ...(item.keywords ?? [])].join(" ");
    return matchName(words, text)?.atWordStart === true;
  });
}
