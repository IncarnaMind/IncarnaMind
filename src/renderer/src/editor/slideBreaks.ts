/**
 * Where each slide of a checked deck starts in its Note (#3493): a quiet "Slide N" line drawn before
 * the slide's first Block, from the slide each Block came from (`Verification.pages`). It is drawn,
 * never written, so the Note's text stays the file's.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { verificationOf } from "../../../shared/verification";
import { useAppStore } from "../store";

export interface SlideBreaksOptions {
  /** The slide each Block of a checked deck came from, by Block id; null for any other Note. */
  slides(): Readonly<Record<string, number>> | null;
  /** The line's words for slide `n`. */
  label(n: number): string;
}

/** The first Block id at or inside `node`: a table's is its first cell's. */
function blockIdOf(node: ProseMirrorNode): string | null {
  if (typeof node.attrs.id === "string") return node.attrs.id;
  let found: string | null = null;
  node.descendants((child) => {
    if (found !== null) return false;
    if (typeof child.attrs.id === "string") found = child.attrs.id;
    return found === null;
  });
  return found;
}

/** Where each slide starts among the Note's top Blocks, and its number. */
export function slideStarts(
  doc: ProseMirrorNode,
  slides: Readonly<Record<string, number>>,
): { at: number; slide: number }[] {
  const starts: { at: number; slide: number }[] = [];
  let last: number | null = null;
  doc.forEach((node, offset) => {
    const id = blockIdOf(node);
    const slide = id === null ? undefined : slides[id];
    if (slide === undefined || slide === last) return;
    last = slide;
    starts.push({ at: offset, slide });
  });
  return starts;
}

/** A checked deck's slides, by Block id: its Note's verification, while its Document is a deck. */
export function deckSlides(doc: Y.Doc): Readonly<Record<string, number>> | null {
  const verification = verificationOf(doc);
  if (!verification) return null;
  const kind = useAppStore
    .getState()
    .documents.find((each) => each.id === verification.documentId)?.kind;
  return kind === "pptx" ? verification.pages : null;
}

export const SlideBreaks = Extension.create<SlideBreaksOptions>({
  name: "slideBreaks",

  addOptions() {
    return { slides: () => null, label: (n) => String(n) };
  },

  addProseMirrorPlugins() {
    const { slides, label } = this.options;
    return [
      new Plugin({
        key: new PluginKey("slideBreaks"),
        props: {
          decorations(state) {
            const pages = slides();
            if (!pages) return null;
            return DecorationSet.create(
              state.doc,
              slideStarts(state.doc, pages).map(({ at, slide }) =>
                Decoration.widget(
                  at,
                  () => {
                    const line = document.createElement("div");
                    line.className = "slide-break";
                    line.contentEditable = "false";
                    line.dataset.testid = "slide-break";
                    line.textContent = label(slide);
                    return line;
                  },
                  { side: -1, key: `slide-${slide}-${label(slide)}`, ignoreSelection: true },
                ),
              ),
            );
          },
        },
      }),
    ];
  },
});
