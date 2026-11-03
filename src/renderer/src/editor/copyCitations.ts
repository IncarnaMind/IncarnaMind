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

const COPY_NOTICE = Symbol("copyIncomplete");
type NoticedDOM = Node & { [COPY_NOTICE]?: unknown };
let pendingNotice: unknown = null;

function takeNotice(node: Node): unknown {
  const noticed = node as NoticedDOM;
  if (noticed[COPY_NOTICE] !== undefined) {
    const error = noticed[COPY_NOTICE];
    delete noticed[COPY_NOTICE];
    return error;
  }
  for (const child of node.childNodes) {
    const found = takeNotice(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Reports the notice a copy left on its serialized DOM, once; true when it did. */
export function reportCopyNotice(dom: Node): boolean {
  const error = takeNotice(dom);
  if (error === undefined) return false;
  reportIncompleteCopy(error);
  return true;
}

function reportIncompleteCopy(error: unknown): void {
  useAppStore
    .getState()
    .reportError(new InvalidInputError({ key: "error.figure.copyIncomplete" }, { cause: error }));
}

function markCopyNotice(dom: Node, error: unknown): void {
  // ProseMirror moves the serialized children into its own wrapper: mark one that travels.
  const target = (dom.firstChild ?? dom) as NoticedDOM;
  target[COPY_NOTICE] = error;
  pendingNotice = error;
  // The copy or cut listener runs in this event; anything else, like a drag, leaves it unread.
  queueMicrotask(() => {
    pendingNotice = null;
  });
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
            const html = data?.getData("text/html");
            const text = data?.getData("text/plain");
            if (data && html)
              data.setData("text/html", withoutInertBrackets(wordFootnoteHtml(html)));
            if (data && text) data.setData("text/plain", withoutInertBrackets(text));
            if (pendingNotice !== null) {
              reportIncompleteCopy(pendingNotice);
              pendingNotice = null;
            }
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
                if (failure !== null) markCopyNotice(out, failure);
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
