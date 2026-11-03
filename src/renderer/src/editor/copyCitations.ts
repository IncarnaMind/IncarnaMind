/**
 * A note's copy, with the Citations in it as footnotes (see `copyNotes`): HTML Word pastes as
 * footnotes, and text with markers and Sources. Added to every editor that shows Notes.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import {
  CALCULATED_FIGURE_NODE,
  type CalculatedFigureAttributes,
  type RetainedFigureAnalysis,
} from "../../../core/api";
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

export const COPY_INCOMPLETE_ATTRIBUTE = "data-copy-incomplete";

/** Takes the plain-text notice off a serialized copy, so the write leaves it out; true when it was there. */
export function takeCopyNotice(dom: Node): boolean {
  const queryable = dom as unknown as {
    querySelectorAll?: (selectors: string) => ArrayLike<{ removeAttribute(name: string): void }>;
    hasAttribute?: (name: string) => boolean;
    removeAttribute?: (name: string) => void;
  };
  const found = Array.from(queryable.querySelectorAll?.(`[${COPY_INCOMPLETE_ATTRIBUTE}]`) ?? []);
  if (queryable.hasAttribute?.(COPY_INCOMPLETE_ATTRIBUTE) && queryable.removeAttribute) {
    queryable.removeAttribute(COPY_INCOMPLETE_ATTRIBUTE);
    return true;
  }
  for (const element of found) element.removeAttribute(COPY_INCOMPLETE_ATTRIBUTE);
  return found.length > 0;
}

/** Reports the plain-text copy the User made, once the clipboard has it. */
export function reportCopyNotice(): void {
  useAppStore.getState().reportError(new InvalidInputError({ key: "error.figure.copyIncomplete" }));
}

const analysisFigure = (node: ProseMirrorNode) =>
  node.type.name === CALCULATED_FIGURE_NODE ? readCalculatedFigureAttributes(node.attrs) : null;

/** Every Analysis figure a node is or holds, with its node. */
function eachAnalysisFigure(
  node: ProseMirrorNode,
  visit: (node: ProseMirrorNode, figure: CalculatedFigureAttributes) => void,
): void {
  const own = analysisFigure(node);
  if (own?.figure.analysis) visit(node, own);
  node.forEach((child) => {
    eachAnalysisFigure(child, visit);
  });
}

function analysisFigureIds(fragment: Fragment): string[] {
  const ids: string[] = [];
  fragment.forEach((node) => {
    eachAnalysisFigure(node, (_node, figure) => {
      ids.push(figure.id);
    });
  });
  return ids;
}

/** The node, with the figures `plain` names written as the value each shows. */
function asPlainText(
  node: ProseMirrorNode,
  plain: ReadonlySet<string>,
  schema: Schema,
): ProseMirrorNode[] {
  const read = analysisFigure(node);
  if (read && plain.has(read.id)) return [schema.text(read.figure.shown, node.marks)];
  if (node.isLeaf) return [node];
  return [
    node.copy(
      Fragment.fromArray(
        node.content.content.flatMap((child) => asPlainText(child, plain, schema)),
      ),
    ),
  ];
}

const plainFragment = (fragment: Fragment, plain: ReadonlySet<string>, schema: Schema) =>
  Fragment.fromArray(fragment.content.flatMap((node) => asPlainText(node, plain, schema)));

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
            let html = data?.getData("text/html") ?? "";
            const text = data?.getData("text/plain");
            let noticed = false;
            if (data && html && html.includes(COPY_INCOMPLETE_ATTRIBUTE)) {
              const holder = view.dom.ownerDocument.createElement("div");
              holder.innerHTML = html;
              noticed = takeCopyNotice(holder);
              html = holder.innerHTML;
            }
            if (data && html)
              data.setData("text/html", withoutInertBrackets(wordFootnoteHtml(html)));
            if (data && text) data.setData("text/plain", withoutInertBrackets(text));
            if (noticed) reportCopyNotice();
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
                // Each Analysis figure is tried on its own: one whose saved inputs are complete
                // keeps its node and record, whatever shares its Block (#2378).
                const plain = new Set<string>();
                let failure: unknown = null;
                fragment.forEach((top) => {
                  eachAnalysisFigure(top, (node, figure) => {
                    const one = clipboardBlocks(Fragment.from(node));
                    try {
                      readFigureRunClosure(one, this.options.figureRuns(one));
                    } catch (error) {
                      console.error(
                        "Copying a figure: its saved inputs are incomplete; copying it as text.",
                        error,
                      );
                      plain.add(figure.id);
                      failure ??= error;
                    }
                  });
                });
                let left =
                  plain.size > 0 ? plainFragment(fragment, plain, this.editor.schema) : fragment;
                let runs: RetainedFigureAnalysis[] = [];
                try {
                  const leftBlocks = clipboardBlocks(left);
                  runs = readFigureRunClosure(leftBlocks, this.options.figureRuns(leftBlocks));
                } catch (error) {
                  // What is left can't be read together: every Analysis figure is its value.
                  failure ??= error;
                  left = plainFragment(
                    fragment,
                    new Set(analysisFigureIds(fragment)),
                    this.editor.schema,
                  );
                  runs = [];
                  console.error("Copying a figure: its saved inputs couldn't be read.", error);
                }
                if (left !== fragment) out = base.serializeFragment(left, options, target);
                carrier(runs);
                if (failure !== null) {
                  const marker = (options?.document ?? document).createElement("span");
                  marker.setAttribute(COPY_INCOMPLETE_ATTRIBUTE, "");
                  marker.hidden = true;
                  out.appendChild(marker);
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
