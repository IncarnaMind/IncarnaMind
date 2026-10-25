import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MessageKey, MessageParams } from "../../../shared/i18n";

/*
 * How a change reads (#1028; DESIGN.md, AI edits): a paragraph written anew
 * shows whole, its old text one "Was: …" line above it that opens the old
 * text, struck, in place; a section rewritten as a whole shows one line,
 * "Rewrote “…” · Show original", instead of one per paragraph. Shared by the
 * changes waiting in the Mind (`ProposalRewrites`) and an applied edit's
 * changes shown again (`AppliedEditLine`).
 */

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A Block a change touches, where it starts, and how the change reads there. */
export interface ChangedBlock {
  /** What shows its old text, toggled by its line's button (`data-change-original`). */
  key: string;
  pos: number;
  how: "rewritten" | "added" | "removed" | "words";
  /** A Block written anew: its text before, and its heading's new words. */
  old?: string;
  title?: string;
}

/** A section rewritten as a whole: its heading, and the Blocks under it that the change touches. */
export interface RewrittenSection {
  heading: ChangedBlock;
  members: ChangedBlock[];
}

/** How the lines are drawn: after an edit's own line at the same place (side -1), right over their Block. */
export const LINE_WIDGET = { side: -0.5, ignoreSelection: true, stopEvent: () => true };

const COUNTED: ReadonlySet<string> = new Set(["paragraph", "heading"]);
const ANEW: ReadonlySet<ChangedBlock["how"]> = new Set(["rewritten", "added", "removed"]);

const paragraphsBetween = (doc: ProseMirrorNode, from: number, to: number) => {
  let count = 0;
  doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from) return true;
    if (COUNTED.has(node.type.name) && node.textContent.trim() !== "") count++;
    return !node.isTextblock;
  });
  return count;
};

/**
 * The sections rewritten as a whole: a top-level heading written anew, and
 * more than half the paragraphs under it, up to the next heading of its
 * level or higher, written anew, added or removed. `removedInDoc`: Blocks a
 * change removes are still in `doc`, as a waiting change's are.
 */
export function rewrittenSections(
  doc: ProseMirrorNode,
  blocks: readonly ChangedBlock[],
  removedInDoc: boolean,
): RewrittenSection[] {
  const tops: { node: ProseMirrorNode; pos: number }[] = [];
  doc.forEach((node, pos) => {
    tops.push({ node, pos });
  });
  const sections: RewrittenSection[] = [];
  for (const [index, { node, pos }] of tops.entries()) {
    if (node.type.name !== "heading") continue;
    const heading = blocks.find((block) => block.pos === pos && block.how === "rewritten");
    if (!heading) continue;
    const level = Number(node.attrs.level);
    const next = tops
      .slice(index + 1)
      .find((each) => each.node.type.name === "heading" && Number(each.node.attrs.level) <= level);
    const from = pos + node.nodeSize;
    const to = next?.pos ?? doc.content.size;
    // A Block an applied edit removed has no room left in `doc`: one that ended the section sits at its end.
    const members = blocks.filter(
      (block) =>
        block.pos >= from &&
        (block.pos < to || (block.pos === to && block.how === "removed" && !removedInDoc)),
    );
    const removedApart = removedInDoc
      ? 0
      : members.filter((block) => block.how === "removed").length;
    const paragraphs = paragraphsBetween(doc, from, to) + removedApart;
    const anew = members.filter((block) => ANEW.has(block.how)).length;
    if (paragraphs > 0 && anew * 2 > paragraphs) sections.push({ heading, members });
  }
  return sections;
}

function lineOf(className: string, testId: string, parts: Node[]): HTMLElement {
  const line = document.createElement("div");
  line.contentEditable = "false";
  line.className = className;
  line.dataset.testid = testId;
  line.append(...parts);
  return line;
}

function toggle(key: string, shown: boolean, label: string, testId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "change-original-button";
  button.dataset.changeOriginal = key;
  button.dataset.testid = testId;
  button.setAttribute("aria-expanded", String(shown));
  button.textContent = label;
  return button;
}

/** "Was: …" over a paragraph written anew: one line, cut with an ellipsis; it shows the old text, struck. */
export function wasLine(t: Translate, block: ChangedBlock, shown: boolean): HTMLElement {
  const button = toggle(block.key, shown, t("change.was", { text: block.old ?? "" }), "change-was");
  button.title = block.old ?? "";
  return lineOf("change-was", "change-was-line", [button]);
}

/** "Rewrote “…” · Show original" over a section rewritten as a whole. */
export function sectionLine(t: Translate, section: RewrittenSection, shown: boolean): HTMLElement {
  const words = document.createElement("span");
  words.className = "change-section-words";
  words.textContent = t("change.rewrote", { heading: section.heading.title ?? "" });
  const dot = document.createElement("span");
  dot.className = "proposal-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.textContent = "·";
  const button = toggle(
    sectionKey(section),
    shown,
    t(shown ? "change.hideOriginal" : "change.showOriginal"),
    "change-section-original",
  );
  return lineOf("change-section", "change-section-line", [words, dot, button]);
}

/** What shows a section's old text: its heading's key, marked as the section's. */
export const sectionKey = (section: RewrittenSection) => `${section.heading.key}:section`;

/** The section a Block reads as part of, if it does. */
export const sectionOf = (
  block: ChangedBlock,
  sections: readonly RewrittenSection[],
): RewrittenSection | null =>
  sections.find((section) => section.heading === block || section.members.includes(block)) ?? null;

/** Whether a Block's old text shows: its own line opened it, or its section's. */
export function originalShown(
  block: ChangedBlock,
  sections: readonly RewrittenSection[],
  shown: ReadonlySet<string>,
): { inSection: RewrittenSection | null; shown: boolean } {
  const inSection = sectionOf(block, sections);
  return {
    inSection,
    shown: inSection ? shown.has(sectionKey(inSection)) : shown.has(block.key),
  };
}

/** A key shown, or hidden again. */
export function toggled(shown: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(shown);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
