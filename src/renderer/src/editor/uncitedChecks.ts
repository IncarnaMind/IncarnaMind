/**
 * The sentences of an Answer in the assistant its model cited nothing in, which the Answer's own
 * judgement found the Passages it read don't back (#3410): each washed as a Note washes a sentence
 * found unsupported or contradicted, with the check's mark after it, as a Citation's marker shows
 * its check. The mark opens a card that says so, in the Citation card's words for that check.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { UncitedCheck } from "../../../core/api";
import { comparableSentence, INLINE_NODE, sentenceSpans } from "../../../shared/sentences";
import { translateNow } from "../i18n";
import { hideMarkCard, showMarkCard } from "./markCards";

const SVG = "http://www.w3.org/2000/svg";

/** The check's icon, as the Citation marker draws it (`CheckMarkIcon`). */
const ICON_PATHS: Record<UncitedCheck["check"], { weight: string; paths: string[] }> = {
  unsupported: { weight: "3", paths: ["M12 6v8", "M12 18.5v.01"] },
  contradicted: { weight: "2.5", paths: ["M6 9.5h12", "M6 14.5h12", "m15 5-6 14"] },
};

function iconOf(check: UncitedCheck["check"]): SVGSVGElement {
  const icon = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": ICON_PATHS[check].weight,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "citation-marker-icon",
  })) {
    icon.setAttribute(name, value);
  }
  for (const d of ICON_PATHS[check].paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

const headingOf = (check: UncitedCheck["check"]) =>
  translateNow(
    check === "unsupported" ? "citation.badge.unsupported" : "citation.badge.contradicted",
  );

function showCard(anchor: HTMLElement, check: UncitedCheck): void {
  const card = document.createElement("div");
  card.className = `citation-card citation-card--${check.check} uncited-check-card`;
  card.dataset.testid = "uncited-check-card";
  card.dataset.check = check.check;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", headingOf(check.check));
  card.tabIndex = -1;
  const head = document.createElement("p");
  head.className = "uncited-check-heading";
  head.textContent = headingOf(check.check);
  card.append(head);
  if (check.verdict) {
    const verdict = document.createElement("p");
    verdict.className = "citation-card-verdict";
    verdict.dataset.testid = "uncited-check-verdict";
    verdict.textContent = check.verdict;
    card.append(verdict);
  }
  const why = document.createElement("p");
  why.className = "citation-card-note";
  why.textContent = translateNow("uncitedCheck.why");
  card.append(why);
  showMarkCard(anchor, card);
  card.focus();
}

function markFor(check: UncitedCheck): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "citation-marker uncited-check-mark";
  button.dataset.testid = "uncited-check-mark";
  button.dataset.check = check.check;
  const label = translateNow("uncitedCheck.label", {
    heading: headingOf(check.check),
    why: translateNow("uncitedCheck.why"),
  });
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "dialog");
  button.title = label;
  button.contentEditable = "false";
  button.append(iconOf(check.check));
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showCard(button, check);
  });
  return button;
}

/** A text block's words, each other inline node as one character, as the Answer's sentences are split. */
function textOf(node: ProseMirrorNode): string {
  let text = "";
  node.forEach((child) => {
    text += child.isText
      ? (child.text ?? "")
      : child.type.name === "hardBreak"
        ? "\n"
        : INLINE_NODE;
  });
  return text;
}

/** The wash and mark of each judged sentence, found by its words in the Answer's text blocks. */
export function uncitedCheckDecorations(
  doc: ProseMirrorNode,
  checks: readonly UncitedCheck[],
): Decoration[] {
  if (checks.length === 0) return [];
  const bySentence = new Map(checks.map((check) => [comparableSentence(check.sentence), check]));
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = textOf(node);
    for (const span of sentenceSpans(text)) {
      const words = text.slice(span.from, span.to);
      const check = bySentence.get(comparableSentence(words.replaceAll(INLINE_NODE, "")));
      if (!check || words.includes(INLINE_NODE)) continue;
      const end = span.from + words.trimEnd().length;
      decorations.push(
        Decoration.inline(pos + 1 + span.from, pos + 1 + end, {
          class: `claim-wash claim-wash--${check.check}`,
          "data-testid": "uncited-check",
        }),
        Decoration.widget(pos + 1 + end, () => markFor(check), {
          side: 1,
          key: `uncited-check:${pos + 1 + span.from}:${check.check}:${check.judgedAt}`,
        }),
      );
    }
    return false;
  });
  return decorations;
}

interface Shown {
  checks: readonly UncitedCheck[];
  decorations: DecorationSet;
}

const key = new PluginKey<Shown>("uncitedChecks");

/** Shows `checks` in the Answer's view: those of its sentences a check marked though they cite nothing. */
export function setUncitedChecks(view: EditorView, checks: readonly UncitedCheck[]): void {
  view.dispatch(view.state.tr.setMeta(key, checks).setMeta("addToHistory", false));
}

export const UncitedChecks = Extension.create({
  name: "uncitedChecks",

  onDestroy() {
    hideMarkCard();
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<Shown>({
        key,
        state: {
          init: (): Shown => ({ checks: [], decorations: DecorationSet.empty }),
          apply: (transaction, state) => {
            const checks =
              (transaction.getMeta(key) as readonly UncitedCheck[] | undefined) ?? state.checks;
            if (checks === state.checks && !transaction.docChanged) return state;
            return {
              checks,
              decorations: DecorationSet.create(
                transaction.doc,
                uncitedCheckDecorations(transaction.doc, checks),
              ),
            };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
        },
      }),
    ];
  },
});
