/**
 * Edit with AI (`fakeEdit`): Shorten drops filler words ("very", "really",
 * 非常, 真的…), Improve writing capitalises each sentence and writes "a lot
 * of" as "many", Translate… puts the text in capitals, Explain says what the
 * passage starts with, and an instruction to "replace X with Y" (把 X 换成 Y)
 * does so, or "drop the citations" (去掉引用) leaves their markers out.
 * "Restructure" (重新组织) cuts a plain last paragraph, quoting it between
 * <removed> and </removed> as a model does (#2180), and puts the last
 * section, from its heading (a "#" paragraph) on, first, keeping each
 * paragraph's mark, as a model restructuring a whole Mind does (#703). One
 * that asks for a table (表格) adds a Markdown table after the passage, a
 * row for each paragraph, its markers in the cells, and a last row whose
 * source is a name in brackets no Citation has (#961). "Rewrite the
 * section" (重写这一节) writes its heading and each paragraph anew (#1028).
 * Cut the unsupported part gives a sentence `PARTLY` lists its cut words,
 * with the passage's markers, and takes the part named out of any other
 * (#1111). Following a Citation's new version (#99) makes the sentence the words the
 * Citation now quotes, with its markers. The
 * new text streams in word by word, slowly when the instruction or the passage
 * says "slowly", or not at all until it is stopped when it says "forever", then
 * a line saying why (#202). It reads a passage shown with its paragraphs' names
 * without them, and names none of its own, so its rewrites are paired by their
 * words (#2356).
 */

import { QUOTE_WHAT_GOES, withoutNames } from "../../core/edits/prompt";
import { appliedEditReply } from "./appliedEdits";
import { PARTLY } from "./checks";
import { type Prompt, SHORTEN, SLOWLY, type StreamPart, USAGE } from "./prompt";

const HOLDING = /\bforever\b/i;

const FILLER = /(?:\b(?:very|really|truly|quite|actually|basically)\s+|非常|真的|其实|十分)/giu;

/** A passage restructured (see the top of this file): its last section first, a plain last paragraph cut. */
function restructured(passage: string): string {
  const paragraphs = passage.split(/\n\n+/);
  const cut =
    paragraphs.length > 1 && !/^(?:#|- |\d+\. |> )/.test(paragraphs.at(-1) ?? "")
      ? [`<removed>${paragraphs.pop()}</removed>`]
      : [];
  const last = paragraphs.findLastIndex((paragraph) => paragraph.startsWith("#"));
  if (last <= 0) return [...paragraphs, ...cut].join("\n\n");
  return [...paragraphs.slice(last), ...paragraphs.slice(0, last), ...cut].join("\n\n");
}

function rewrittenSection(passage: string): string {
  const chinese = /\p{Script=Han}/u.test(passage);
  let paragraphs = 0;
  return passage
    .split(/\n\n+/)
    .map((paragraph) => {
      if (paragraph.startsWith("#")) {
        return `${paragraph.match(/^#+ /)?.[0] ?? "## "}${chinese ? "核心优势" : "Key strengths"}`;
      }
      paragraphs++;
      return chinese
        ? `十年咨询与审计项目经验，第 ${paragraphs} 条。`
        : `Ten years of consulting and audit work, point ${paragraphs}.`;
    })
    .join("\n\n");
}

/** A row for each paragraph but headings: its first two words, then the rest. */
function withTable(passage: string): string {
  const rows = passage
    .split(/\n\n+/)
    .filter((paragraph) => !paragraph.startsWith("#"))
    .map((paragraph) => {
      const words = paragraph.replace(/^(?:- |\d+\. |> )/, "").split(/\s+/);
      return `| ${words.slice(0, 2).join(" ")} | ${words.slice(2).join(" ")} |`;
    });
  const named = "| Source | Board minutes [Board minutes, p. 2] |";
  return [passage, "", "| Term | What it says |", "|---|---|", ...rows, named].join("\n");
}

/** Why the scripted Edit with AI changed a passage, by its action, in English and in Chinese. */
const EDIT_REASONS: Readonly<Record<string, readonly [string, string]>> = {
  shorten: ["Shorter: the filler words are gone.", "更简洁：去掉了多余的词。"],
  improve: ["Each sentence starts with a capital.", "每句话的开头都大写了。"],
  translate: ["Translated.", "已翻译。"],
  instruction: ["Changed as you asked.", "已按你的要求修改。"],
  "cut-unsupported": ["The part its Citations don't support is gone.", "删去了引用不支持的部分。"],
  "follow-citation": ["It now agrees with its Document.", "已与文档的新版本一致。"],
};

/**
 * The scripted Edit with AI (see the top of this file): the passage's new
 * text and why, or an explanation; `slow` when the instruction or the passage
 * says "slowly".
 */
export function fakeEdit(prompt: Prompt): { text: string; slow: boolean; holds: boolean } | null {
  const request = prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");
  const task = /<task action="([^"]+)">([\s\S]*?)<\/task>/.exec(request);
  if (!task) return null;
  const shown = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(request)?.[1] ?? "";
  // Its paragraphs' names (#2356) are left out of what it reads and writes: its replies carry none.
  const passage = /^¶1 /.test(shown) ? withoutNames(shown) : shown;
  const asked = (task[2] ?? "")
    .replace(/^Do what the User asks: /, "")
    .replace(`\n${QUOTE_WHAT_GOES}`, "");
  const action = task[1] ?? "";
  const text = editedText(action, passage, asked.replace(/\s+slowly\.?$/i, ""));
  // In the passage's language, as the instructions ask.
  const why = EDIT_REASONS[action]?.[/\p{Script=Han}/u.test(passage) ? 1 : 0];
  // A cut's task quotes the sentence's sources, which may say "slowly" themselves.
  const slow = action !== "cut-unsupported" && (SLOWLY.test(asked) || SLOWLY.test(passage));
  const holds = action !== "cut-unsupported" && HOLDING.test(asked);
  return { text: why ? `${text}\n\n<why>${why}</why>` : text, slow, holds };
}

/** The scripted Edit with AI's new text for `passage`, or its explanation. */
function editedText(action: string, passage: string, asked: string): string {
  switch (action) {
    case "shorten":
      return passage.replace(FILLER, "");
    case "improve":
      return passage
        .replace(/\ba lot of\b/g, "many")
        .replace(
          /(^|[.!?]\s+)([a-z])/g,
          (_match, before: string, letter: string) => `${before}${letter.toUpperCase()}`,
        );
    case "translate":
      return passage.toUpperCase();
    case "cut-unsupported": {
      const markers = (passage.match(/\[\d+\]/g) ?? []).join("");
      const listed = PARTLY.find((each) => each.when.test(passage));
      if (listed) return `${listed.cut}${markers}`;
      const part = /support this part of it: ([\s\S]*?)\. Take out only/.exec(asked)?.[1] ?? "";
      return part === "" ? passage : passage.split(part).join("");
    }
    case "follow-citation": {
      const words = /“([^”]*)”/.exec(asked)?.[1] ?? "";
      const markers = (passage.match(/\[\d+\]/g) ?? []).join("");
      return words === "" ? passage : `${words}${markers}`;
    }
    case "explain": {
      const words = passage
        .replace(/\s*\[\d+\]/g, "")
        .split(/\s+/)
        .slice(0, 6)
        .join(" ");
      return `This passage says: ${words}…`;
    }
    default: {
      const applied = appliedEditReply(passage, asked);
      if (applied !== null) return applied;
      const replace =
        /replace\s+[“"]?(.+?)[”"]?\s+with\s+[“"]?(.+?)[”"]?\.?$/i.exec(asked) ??
        /把\s*[“"]?(.+?)[”"]?\s*换成\s*[“"]?(.+?)[”"]?。?$/u.exec(asked);
      if (replace?.[1] && replace[2] !== undefined)
        return passage.split(replace[1]).join(replace[2]);
      if (/drop the citations|去掉引用/i.test(asked)) return passage.replace(/\s*\[\d+\]/g, "");
      if (/restructure|重新组织/i.test(asked)) return restructured(passage);
      if (/rewrite the section|重写这一节/i.test(asked)) return rewrittenSection(passage);
      if (/\btable\b|表格/i.test(asked)) return withTable(passage);
      if (SHORTEN.test(asked)) return passage.replace(FILLER, "");
      return `${passage} (edited)`;
    }
  }
}

/** Edit with AI's new text, streamed in word by word. */
export function editParts(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "edit" },
    ...text
      .split(/(?<=\s)/)
      .map((word): StreamPart => ({ type: "text-delta", id: "edit", delta: word })),
    { type: "text-end", id: "edit" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}
