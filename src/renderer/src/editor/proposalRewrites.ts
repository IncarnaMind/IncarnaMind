import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { NODE_CHARACTER } from "../../../shared/proposals";
import {
  type ChangedBlock,
  LINE_WIDGET,
  originalShown,
  rewrittenSections,
  sectionKey,
  sectionLine,
  toggled,
  wasLine,
} from "./changeOriginals";
import { applyingIn, paragraphWrittenAnew, proposalsIn } from "./proposalReview";

/**
 * Changes waiting in the Mind, read as DESIGN.md › AI edits says (#1028): a
 * paragraph a change writes anew shows its new text whole, the old one a
 * "Was: …" line above it; a section rewritten as a whole, one line over its
 * heading. Their buttons are handled by `ProposalBars`.
 */

type Translate = (key: MessageKey, params?: MessageParams) => string;

interface RewritesState {
  shown: ReadonlySet<string>;
  applying: ReadonlySet<string>;
  decorations: DecorationSet;
}

type Meta = { toggle: string } | { redraw: true };

export const proposalRewritesKey = new PluginKey<RewritesState>("proposalRewrites");

const lineText = (text: string) => text.replaceAll(NODE_CHARACTER, "").replace(/\s+/g, " ").trim();

/** The Blocks waiting changes touch, and how each reads; those of edits still applying left out. */
export function changedBlocks(doc: ProseMirrorNode, applying: ReadonlySet<string>): ChangedBlock[] {
  const blocks: ChangedBlock[] = [];
  for (const proposal of proposalsIn(doc)) {
    if (applying.has(proposal.request)) continue;
    const key = `proposal:${proposal.id}`;
    if (proposal.block) {
      for (const range of proposal.ranges) {
        if (range.node === undefined) continue;
        const node = doc.nodeAt(range.from);
        if (node?.isBlock) {
          blocks.push({
            key,
            pos: range.from,
            how: proposal.block === "insert" ? "added" : "removed",
          });
        }
      }
      continue;
    }
    const $from = doc.resolve(proposal.from);
    if (!$from.parent.isTextblock) continue;
    blocks.push(
      paragraphWrittenAnew(doc, proposal)
        ? {
            key,
            pos: $from.before(),
            how: "rewritten",
            old: lineText(proposal.removed),
            title: lineText(proposal.added),
          }
        : { key, pos: $from.before(), how: "words" },
    );
  }
  return blocks;
}

function decorations(
  state: EditorState,
  shown: ReadonlySet<string>,
  applying: ReadonlySet<string>,
  t: Translate,
): DecorationSet {
  const { doc } = state;
  const blocks = changedBlocks(doc, applying);
  const sections = rewrittenSections(doc, blocks, true);
  const marks: Decoration[] = [];
  for (const section of sections) {
    const open = shown.has(sectionKey(section));
    marks.push(
      Decoration.widget(section.heading.pos, () => sectionLine(t, section, open), {
        ...LINE_WIDGET,
        key: `rewrote:${section.heading.key}:${open}:${section.heading.title}:${t("change.showOriginal")}`,
      }),
    );
  }
  for (const block of blocks) {
    const node = doc.nodeAt(block.pos);
    if (!node) continue;
    const { inSection, shown: open } = originalShown(block, sections, shown);
    const attributes = open ? { "data-original-shown": "" } : {};
    if (block.how === "rewritten") {
      if (!inSection) {
        marks.push(
          Decoration.widget(block.pos, () => wasLine(t, block, open), {
            ...LINE_WIDGET,
            key: `was:${block.key}:${open}:${block.old}:${t("change.showOriginal")}`,
          }),
        );
      }
      marks.push(
        Decoration.node(block.pos, block.pos + node.nodeSize, {
          class: "change-rewritten",
          ...attributes,
        }),
      );
    } else if (block.how === "removed" && inSection && !open) {
      marks.push(Decoration.node(block.pos, block.pos + node.nodeSize, { class: "change-hidden" }));
    }
  }
  return DecorationSet.create(doc, marks);
}

export const ProposalRewrites = Extension.create<{ translate: Translate }>({
  name: "proposalRewrites",

  addOptions() {
    return { translate: (key) => key };
  },

  addProseMirrorPlugins() {
    const t = this.options.translate;
    return [
      new Plugin<RewritesState>({
        key: proposalRewritesKey,
        state: {
          init: (_config, state) => {
            const applying = applyingIn(state);
            return {
              shown: new Set(),
              applying,
              decorations: decorations(state, new Set(), applying, t),
            };
          },
          apply: (tr, value, _before, state) => {
            const meta = tr.getMeta(proposalRewritesKey) as Meta | undefined;
            const applying = applyingIn(state);
            const shown =
              meta && "toggle" in meta ? toggled(value.shown, meta.toggle) : value.shown;
            if (!tr.docChanged && !meta && applying === value.applying) return value;
            return { shown, applying, decorations: decorations(state, shown, applying, t) };
          },
        },
        props: {
          decorations: (state) => proposalRewritesKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

/**
 * What shows the old text of the waiting change the cursor is in, its
 * section's when it is in one, and whether it shows; null for one not written
 * anew.
 */
export function proposalOriginalAt(state: EditorState): { key: string; shown: boolean } | null {
  const value = proposalRewritesKey.getState(state);
  if (!value) return null;
  const { doc, selection } = state;
  const blocks = changedBlocks(doc, value.applying);
  const sections = rewrittenSections(doc, blocks, true);
  const here = blocks.find((block) => {
    const node = doc.nodeAt(block.pos);
    return (
      node !== null && block.pos < selection.from && selection.from < block.pos + node.nodeSize
    );
  });
  if (!here) return null;
  const { inSection, shown } = originalShown(here, sections, value.shown);
  if (inSection) return { key: sectionKey(inSection), shown };
  return here.how === "rewritten" ? { key: here.key, shown } : null;
}

/** Shows a waiting change's old text, or its section's, struck in place; or hides it again. */
export function toggleProposalOriginal(editor: Editor, key: string): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(proposalRewritesKey, { toggle: key }));
}

/** Draws the lines again in the interface language. */
export function redrawProposalRewrites(editor: Editor): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(proposalRewritesKey, { redraw: true }));
}
