/**
 * A note's copy, with the Citations in it as footnotes (see `copyNotes`): HTML Word pastes as
 * footnotes, and text with markers and Sources. Added to every editor that shows Notes.
 */
import { Extension } from "@tiptap/core";
import { DOMSerializer, type Fragment } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { RetainedFigureAnalysis } from "../../../core/api";
import type { NodeJSON } from "../../../shared/blockJson";
import { calculatedFiguresIn, readFigureRunClosure } from "../../../shared/figureRuns";
import { withoutInertBrackets } from "../../../shared/inertBrackets";
import type { SourceContext } from "../../../shared/sources";
import { languageNow } from "../i18n";
import { useAppStore } from "../store";
import { addFootnotes, citationsIn, copiedText, wordFootnoteHtml } from "./copyNotes";

export function sourceContext(): SourceContext {
  return { language: languageNow(), documents: useAppStore.getState().documents };
}

export const FIGURE_RUNS_ATTRIBUTE = "data-incarnamind-figure-runs";

export const clipboardBlocks = (fragment: Fragment): NodeJSON[] =>
  fragment.content.map((node) => node.toJSON() as NodeJSON);

interface CopyCitationsOptions {
  figureRuns(blocks: readonly NodeJSON[]): readonly RetainedFigureAnalysis[];
}

export const CopyCitations = Extension.create<CopyCitationsOptions>({
  name: "copyCitations",
  addOptions: () => ({ figureRuns: () => [] }),
  // Before the editor's own plain-text copy, which writes a Citation as its reference.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        // After the editor's own copy and cut handlers, which set the HTML: Word's conditional
        // blocks can't be made in the DOM, so they are written into the string.
        view: (view) => {
          // An outside agent's inert brackets (#352) are copied as the words read. Pasted into a
          // Note they are words the User typed: a paste makes a Citation only from a copied one.
          const rewrite = (event: Event) => {
            const data = (event as ClipboardEvent).clipboardData;
            const html = data?.getData("text/html");
            const text = data?.getData("text/plain");
            if (data && html)
              data.setData("text/html", withoutInertBrackets(wordFootnoteHtml(html)));
            if (data && text) data.setData("text/plain", withoutInertBrackets(text));
          };
          view.dom.addEventListener("copy", rewrite);
          view.dom.addEventListener("cut", rewrite);
          return {
            destroy: () => {
              view.dom.removeEventListener("copy", rewrite);
              view.dom.removeEventListener("cut", rewrite);
            },
          };
        },
        props: {
          clipboardSerializer: (() => {
            const base = DOMSerializer.fromSchema(this.editor.schema);
            const serializer = new DOMSerializer(base.nodes, base.marks);
            serializer.serializeFragment = (fragment, options, target) => {
              const out = base.serializeFragment(fragment, options, target);
              const blocks = clipboardBlocks(fragment);
              if (calculatedFiguresIn(blocks).some(({ figure }) => figure.analysis)) {
                try {
                  const runs = readFigureRunClosure(blocks, this.options.figureRuns(blocks));
                  const carrier = (options?.document ?? document).createElement("span");
                  carrier.setAttribute(FIGURE_RUNS_ATTRIBUTE, JSON.stringify(runs));
                  carrier.hidden = true;
                  out.appendChild(carrier);
                } catch (error) {
                  useAppStore.getState().reportError(error);
                  throw error;
                }
              }
              addFootnotes(out, citationsIn(fragment), sourceContext());
              return out;
            };
            return serializer;
          })(),
          clipboardTextSerializer: (slice, view) =>
            copiedText(slice.content, view.state.schema, sourceContext()),
        },
      }),
    ];
  },
});
