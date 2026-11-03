/**
 * A note's copy, with the Citations in it as footnotes (see `copyNotes`): HTML Word pastes as
 * footnotes, and text with markers and Sources. Added to every editor that shows Notes.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { CALCULATED_FIGURE_NODE, type RetainedFigureAnalysis } from "../../../core/api";
import { InvalidInputError } from "../../../core/errors";
import type { NodeJSON } from "../../../shared/blockJson";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";
import { calculatedFiguresIn, readFigureRunClosure } from "../../../shared/figureRuns";
import { withoutInertBrackets } from "../../../shared/inertBrackets";
import type { SourceContext } from "../../../shared/sources";
import { languageNow } from "../i18n";
import { useAppStore } from "../store";
import { addFootnotes, citationsIn, copiedText, wordFootnoteHtml } from "./copyNotes";

export function sourceContext(): SourceContext {
  const { documents, keptCitationTexts } = useAppStore.getState();
  return { language: languageNow(), documents, kept: keptCitationTexts };
}

export const FIGURE_RUNS_ATTRIBUTE = "data-incarnamind-figure-runs";

export const clipboardBlocks = (fragment: Fragment): NodeJSON[] =>
  fragment.content.map((node) => node.toJSON() as NodeJSON);

const analysisFigure = (node: ProseMirrorNode) =>
  node.type.name === CALCULATED_FIGURE_NODE ? readCalculatedFigureAttributes(node.attrs) : null;

/** The Analysis figures a node is or holds, by the id a copy names them with. */
function analysisFigureIds(node: ProseMirrorNode): string[] {
  const ids: string[] = [];
  const own = analysisFigure(node);
  if (own?.figure.analysis) ids.push(own.id);
  node.descendants((child) => {
    const read = analysisFigure(child);
    if (read?.figure.analysis) ids.push(read.id);
    return true;
  });
  return ids;
}

/** The node, with the figures `plain` names written as the value each shows. */
function asPlainText(
  node: ProseMirrorNode,
  plain: ReadonlySet<string>,
  schema: { text(text: string): ProseMirrorNode },
): ProseMirrorNode[] {
  const read = analysisFigure(node);
  if (read && plain.has(read.id))
    return read.figure.shown === "" ? [] : [schema.text(read.figure.shown)];
  if (node.isLeaf) return [node];
  return [
    node.copy(
      Fragment.fromArray(
        node.content.content.flatMap((child) => asPlainText(child, plain, schema)),
      ),
    ),
  ];
}

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
              let out = base.serializeFragment(fragment, options, target);
              const blocks = clipboardBlocks(fragment);
              const carrier = (runs: readonly RetainedFigureAnalysis[]) => {
                if (runs.length === 0) return;
                const span = (options?.document ?? document).createElement("span");
                span.setAttribute(FIGURE_RUNS_ATTRIBUTE, JSON.stringify(runs));
                span.hidden = true;
                out.appendChild(span);
              };
              if (calculatedFiguresIn(blocks).some(({ figure }) => figure.analysis)) {
                try {
                  carrier(readFigureRunClosure(blocks, this.options.figureRuns(blocks)));
                } catch (error) {
                  // A figure whose saved inputs are incomplete is copied as the value it shows,
                  // and the rest keep their records: pasting gives plain text, never a claim (#2378).
                  const plain = new Set<string>();
                  const runs: RetainedFigureAnalysis[] = [];
                  for (let index = 0; index < fragment.childCount; index += 1) {
                    const block = blocks[index];
                    const node = fragment.child(index);
                    try {
                      if (!block) throw new Error("The copied Blocks didn't line up.");
                      runs.push(...readFigureRunClosure([block], this.options.figureRuns([block])));
                    } catch {
                      for (const id of analysisFigureIds(node)) plain.add(id);
                    }
                  }
                  if (plain.size > 0)
                    out = base.serializeFragment(
                      Fragment.fromArray(
                        fragment.content.flatMap((node) =>
                          asPlainText(node, plain, this.editor.schema),
                        ),
                      ),
                      options,
                      target,
                    );
                  carrier(runs);
                  useAppStore
                    .getState()
                    .reportError(
                      new InvalidInputError(
                        { key: "error.figure.copyIncomplete" },
                        { cause: error },
                      ),
                    );
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
