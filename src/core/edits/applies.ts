import type { EditAction } from "../api";

// "Cut it down to two sentences" shortens.
const REMOVE =
  /\b(?:delete|deleting|remove|removing|(?:cut|cutting)(?!\s+(?:[\p{L}]+\s+){0,3}(?:down|back)\b)|drop|dropping|erase|get rid of|take out|strip)\b|删除|删掉|删去|去掉|去除|移除|拿掉/giu;
/**
 * A part of the text by its kind: "the second paragraph", "the Methods section",
 * 第二段, 最后一句. Words in the text ("these filler words", 所有形容词) are no
 * part, so taking them out never takes out what the model left out.
 */
const PART =
  /\b(?:paragraphs?|sections?|parts?|headings?|sentences?|bullets?|bullet points?|list items?|tables?)\b|段落|章节|小节|整节|一节|整段|整条|部分|句子|标题|表格|要点|列表项|条目|(?:第[\d一二三四五六七八九十百]+|最后[\d一二两三四五六七八九十]*|[前后][\d一二两三四五六七八九十]+|[这那此该本上下][一二两]?)[段节句条]/iu;
/** Saying not to, before the verb in its own clause: "but keep the rest" after it doesn't undo it. */
const NOT =
  /\b(?:don'?t|do not|never|without|no need to|not)\b|不要|别|不用|不必|无需|不需要|没必要|勿/iu;
const CLAUSE = /[,;:.!?，；：。！？]|\b(?:but|then)\b|但是?/iu;
/** Asking for the text as a table replaces it, as a delete does: "make this into a table", 改成表格 (#961). */
const AS_TABLE =
  /\b(?:make|turn|convert|change|rewrite|reformat|format|put|present|restructure|lay out)\b(?:\s+(?!and\b|but\b)[\w'-]+){0,4}?\s+(?:in(?:to)?|as|to)\s+(?:a\s+)?table\b|\bmake\s+(?:it|this|these|them|that)\s+a\s+table\b|(?:改|做|转|变|整理|转换|改写|换)(?:成|为)(?:一个|一张)?表格|以表格(?:的)?形式/giu;
/** "the first and second paragraphs" is one part; "the jargon and tighten the paragraph" isn't. */
const ORDINAL_AND =
  /\b(?:and|or)\s+(?=(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|last|next|\d+(?:st|nd|rd|th)?)\b)/giu;

/**
 * Whether the request asks to take a part out, by its words. Only for a reply that has no
 * <removed/> (a small local model doesn't write it, #2180): what the new text leaves out is
 * then taken out when this says so, and otherwise kept, as a model may return only what it
 * changed (#880).
 */
export function asksToRemove(action: EditAction, instruction: string): boolean {
  if (action === "cut-unsupported" || action === "follow-citation") return true;
  if (action !== "instruction") return false;
  for (const table of instruction.matchAll(AS_TABLE)) {
    const opening = instruction.slice(0, table.index).split(CLAUSE).at(-1) ?? "";
    if (!NOT.test(opening)) return true;
  }
  const asked = instruction.replace(ORDINAL_AND, "");
  for (const verb of asked.matchAll(REMOVE)) {
    const at = verb.index ?? 0;
    const opening = asked.slice(0, at).split(CLAUSE).at(-1) ?? "";
    if (NOT.test(opening)) continue;
    const rest = (asked.slice(at + verb[0].length).split(CLAUSE)[0] ?? "").split(/\band\b/iu)[0];
    // The object, not where it is: "the adjectives across all paragraphs", "第二段里的口语化表达".
    const object = (words: string) =>
      (
        words.split(
          /\b(?:in|of|from|within|across|throughout|over|on|at|for|each|every|per)\b|从|每|各/iu,
        )[0] ?? ""
      )
        .split("的")
        .at(-1) ?? "";
    // Chinese puts the object before the verb: 把第二段删掉.
    const before = /[把将]([^把将]*)$/u.exec(opening)?.[1] ?? "";
    if (PART.test(object(rest ?? "")) || PART.test(object(before))) return true;
  }
  return false;
}

export const MOST_OF_IT = 0.5;

/** New text maps onto the selection when at least half of it is found there. */
export function mapsOnto(found: number, total: number): boolean {
  return total === 0 || found / total >= MOST_OF_IT;
}

/** What was meant can't be told when new text maps onto none of the selection and removes most of it: it waits. */
export function waitsForUser(edit: {
  action: EditAction;
  removing: boolean;
  mapped: boolean;
  removed: number;
  added: number;
  selected: number;
}): boolean {
  if (edit.removing || edit.mapped || edit.action === "translate" || edit.selected === 0) {
    return false;
  }
  return (edit.removed - edit.added) / edit.selected > MOST_OF_IT;
}
