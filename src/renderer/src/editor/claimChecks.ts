/**
 * Checks of the User's own sentences in the editor (#96): the mark that
 * holds a sentence's result (`CLAIM_CHECK_MARK`), where each check is now,
 * how it shows (`claimCheckShown`), and the wash behind a sentence found
 * unsupported or contradicted.
 */
import { Extension, Mark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type SearchScope,
} from "../../../core/api";
import { chartCheckText, chartPoints, readChart } from "../../../shared/charts";
import {
  type ClaimCheckShown,
  claimCheckShown,
  figureCheckShown,
  type KeptMark,
  readClaimCheck,
} from "../../../shared/claimChecks";
import { sameScope } from "../../../shared/searchScope";
import { INLINE_NODE, sentenceSpans } from "../../../shared/sentences";

/** Every attribute a check's mark keeps: all of `ClaimCheckAttributes`, never read from pasted HTML. */
const ATTRIBUTES: readonly (keyof ClaimCheckAttributes)[] = [
  "id",
  "request",
  "action",
  "state",
  "reason",
  "detail",
  "providerId",
  "modelId",
  "text",
  "evidence",
  "says",
  "unsupported",
  "calculation",
  "citedCaseUnchecked",
  "citedCaseFound",
  "scope",
  "versions",
  "excluded",
  "checkedAt",
  "kept",
  "figures",
  "remainder",
];

/**
 * A sentence's check, on its text. A copied sentence pastes without it: its
 * check belongs where it was made.
 */
export const ClaimCheck = Mark.create({
  name: CLAIM_CHECK_MARK,
  inclusive: false,
  addAttributes: () =>
    Object.fromEntries(
      ATTRIBUTES.map((name) => [
        name,
        {
          default: name === "remainder" ? undefined : null,
          parseHTML: () => null,
          renderHTML: () => ({}),
        },
      ]),
    ),
  parseHTML: () => [],
  renderHTML: ({ mark }) => ["span", { "data-claim-check": String(mark.attrs.id ?? "") }, 0],
});

/** A paragraph's text as checks read it, and where it is in the document. */
export interface ParagraphPlaces {
  /** An inline node that isn't text is one U+FFFC, a line break "\n". */
  text: string;
  /** Where each character of `text` starts in the document, and where it ends: a footnote takes more room than its one character. */
  starts: number[];
  ends: number[];
  /** The inline nodes that aren't text, each at its character of `text` and its position. */
  inline: { node: ProseMirrorNode; at: number; pos: number }[];
}

/** A paragraph (`block`, at `pos` in the document) read as checks read it, leaving out the children `skip` says. */
export function paragraphPlaces(
  block: ProseMirrorNode,
  pos: number,
  skip: (child: ProseMirrorNode) => boolean = () => false,
): ParagraphPlaces {
  const places: ParagraphPlaces = { text: "", starts: [], ends: [], inline: [] };
  block.forEach((child, offset) => {
    const start = pos + 1 + offset;
    if (skip(child)) return;
    if (child.isText) {
      const words = child.text ?? "";
      for (let index = 0; index < words.length; index++) {
        places.starts.push(start + index);
        places.ends.push(start + index + 1);
      }
      places.text += words;
      return;
    }
    places.inline.push({ node: child, at: places.text.length, pos: start });
    places.starts.push(start);
    places.ends.push(start + child.nodeSize);
    places.text += child.type.name === "hardBreak" ? "\n" : INLINE_NODE;
  });
  return places;
}

/** A check where it is in the editor now. */
export interface ClaimSpan {
  kind?: "chart";
  check: ClaimCheckAttributes;
  /** The first marked character, and after the last. */
  from: number;
  to: number;
  /** The whole sentences the marked text is in, as they read now. */
  sentence: { from: number; to: number; text: string };
}

/** Every check in the document, top to bottom. */
export function claimSpans(doc: ProseMirrorNode): ClaimSpan[] {
  const spans: ClaimSpan[] = [];
  doc.descendants((block, pos) => {
    if (block.type.name === CHART_NODE) {
      const check = readClaimCheck(block.attrs[CLAIM_CHECK_MARK]);
      if (check)
        spans.push({
          kind: "chart",
          check,
          from: pos,
          to: pos + block.nodeSize,
          sentence: {
            from: pos,
            to: pos + block.nodeSize,
            text: chartCheckText(readChart(block.attrs)),
          },
        });
      return false;
    }
    if (!block.isTextblock) return true;
    const found = new Map<string, { check: ClaimCheckAttributes; from: number; to: number }>();
    let at = 0;
    block.forEach((child) => {
      const length = child.isText ? (child.text ?? "").length : 1;
      const mark = child.marks.find((each) => each.type.name === CLAIM_CHECK_MARK);
      const check = mark
        ? readClaimCheck(mark.attrs)
        : child.type.name === CALCULATED_FIGURE_NODE
          ? readClaimCheck(child.attrs[CLAIM_CHECK_MARK])
          : null;
      if (check) {
        const known = found.get(check.id);
        if (known) known.to = at + length;
        else found.set(check.id, { check, from: at, to: at + length });
      }
      at += length;
    });
    if (found.size === 0) return false;
    const { text, starts, ends, inline } = paragraphPlaces(block, pos);
    const sentences = sentenceSpans(
      text,
      inline.filter(({ node }) => node.type.name === CALCULATED_FIGURE_NODE).map(({ at }) => at),
    );
    const startOf = (index: number) => starts[index] ?? pos + 1;
    const endOf = (index: number) => ends[index - 1] ?? startOf(index);
    for (const { check, from, to } of found.values()) {
      const touched = sentences.filter((span) => span.from < to && span.to > from);
      const start = Math.min(from, touched[0]?.from ?? from);
      const end = Math.max(to, touched.at(-1)?.to ?? to);
      spans.push({
        check,
        from: startOf(from),
        to: endOf(to),
        sentence: { from: startOf(start), to: endOf(end), text: text.slice(start, end) },
      });
    }
    return false;
  });
  return spans;
}

/** What a check is compared with besides its sentence: the Documents' versions and the Mind's Folder. */
export interface ClaimContext {
  figureContexts?: ReadonlyMap<string, string> | null;
  /** Each live Document's current version, by id; null while they aren't known. */
  versions: ReadonlyMap<string, string> | null;
  folderId: string | null;
  scope: SearchScope | null;
}

/** A check where it is, and how it shows: never one the User keeps as their own view, which shows nothing. */
export interface ShownClaim extends ClaimSpan {
  shown: Exclude<ClaimCheckShown, { state: "kept" }>;
}

interface ClaimState {
  context: ClaimContext;
  claims: readonly ShownClaim[];
  /** The marks the User keeps as their own view (#1111), at their places. */
  kept: readonly KeptMark[];
  decorations: DecorationSet;
}

const claimsKey = new PluginKey<ClaimState>("claimChecks");

/** A transaction with this meta compares the checks with new Documents or a new Folder (`setClaimContext`). */
const CONTEXT = "claimContext";

const NO_CONTEXT: ClaimContext = { versions: null, folderId: null, scope: null };

/** The checks in a document as they show now, and the sentences the User keeps as their own view. */
export function claimsOf(
  doc: ProseMirrorNode,
  context: ClaimContext,
): Pick<ClaimState, "claims" | "kept"> {
  const claims: ShownClaim[] = [];
  const kept: KeptMark[] = [];
  for (const span of claimSpans(doc)) {
    let shown = claimCheckShown(span.check, { ...context, text: span.sentence.text });
    if (span.kind === "chart") {
      const node = doc.nodeAt(span.from);
      const chart = readChart(node?.attrs ?? {});
      const expected = chartPoints(chart).length * (chart.kind === "scatter" ? 2 : 1);
      if (
        (!span.check.figures?.length || span.check.figures.length !== expected) &&
        shown.state !== "kept" &&
        shown.state !== "checking" &&
        shown.state !== "needs-recheck" &&
        (!span.check.figures?.length || shown.state === "supported")
      )
        shown = { state: "not-checked", reason: "unread" };
    }
    if (shown.state === "kept") {
      kept.push({ from: span.from, to: span.to, text: span.sentence.text });
    } else claims.push({ ...span, shown });
  }
  return { claims, kept };
}

function stateOf(doc: ProseMirrorNode, context: ClaimContext): ClaimState {
  const { claims, kept } = claimsOf(doc, context);
  const washes = claims.flatMap(({ shown, from, to, kind }) =>
    shown.state === "unsupported" || shown.state === "contradicted"
      ? [
          kind === "chart"
            ? Decoration.node(from, to, { class: `claim-wash claim-wash--${shown.state}` })
            : Decoration.inline(from, to, { class: `claim-wash claim-wash--${shown.state}` }),
        ]
      : [],
  );
  return { context, claims, kept, decorations: DecorationSet.create(doc, washes) };
}

/** How the checks of a Mind's sentences cover its Documents (#764). */
export interface Coverage {
  /** More than half of the sentences that got a verdict found nothing in the Documents. */
  mostlyUncovered: boolean;
  /** Some of them were checked in a Folder only, so every Document could still say something. */
  canWiden: boolean;
  /** From the first to the last sentence that found nothing: where "Check against all Documents" goes. */
  range: { from: number; to: number } | null;
  /** How the first of them was checked. */
  action: ShownClaim["check"]["action"] | null;
}

const NO_COVERAGE: Coverage = {
  mostlyUncovered: false,
  canWiden: false,
  range: null,
  action: null,
};

/** Whether the checks, taken together, say the Documents don't cover most of what was checked. */
export function coverageOf(claims: readonly ShownClaim[]): Coverage {
  let checked = 0;
  const lacking: ShownClaim[] = [];
  for (const claim of claims) {
    const { state } = claim.shown;
    if (state === "supported" || state === "contradicted") checked++;
    else if (state === "unsupported") {
      checked++;
      lacking.push(claim);
    }
  }
  const first = lacking[0];
  const last = lacking.at(-1);
  if (!first || !last || checked < 2 || lacking.length * 2 <= checked) return NO_COVERAGE;
  return {
    mostlyUncovered: true,
    canWiden: lacking.some(
      (claim) => !claim.check.scope.widened && claim.check.scope.folderId !== null,
    ),
    range: { from: first.from, to: last.to },
    action: first.check.action,
  };
}

/** Whether two readings of the coverage say the same. */
export const sameCoverage = (a: Coverage, b: Coverage | null | undefined): boolean =>
  b !== null &&
  b !== undefined &&
  a.mostlyUncovered === b.mostlyUncovered &&
  a.canWiden === b.canWiden &&
  a.range?.from === b.range?.from &&
  a.range?.to === b.range?.to;

/** The checks in the editor, as they show now. Empty without `ClaimChecks`. */
export function shownClaims(state: EditorState): readonly ShownClaim[] {
  return claimsKey.getState(state)?.claims ?? [];
}

export function figureShownIn(state: EditorState, id: string): ClaimCheckShown {
  const context = claimsKey.getState(state)?.context ?? NO_CONTEXT;
  for (const span of claimSpans(state.doc)) {
    const child = span.check.figures?.find((figure) => figure.id === id);
    if (!child) continue;
    const now = { ...context, text: span.sentence.text };
    return span.check.kept ? claimCheckShown(span.check, now) : figureCheckShown(child, now);
  }
  return { state: "not-checked", reason: "unread" };
}

const NONE_KEPT: readonly KeptMark[] = [];

/** The marks the User keeps as their own view, at their places: not counted. */
export function keptSpans(state: EditorState): readonly KeptMark[] {
  return claimsKey.getState(state)?.kept ?? NONE_KEPT;
}

/** Compares the checks with the Documents and the Mind's Folder and scope as they are now. */
export function setClaimContext(view: EditorView, context: ClaimContext): void {
  const now = claimsKey.getState(view.state)?.context;
  const sameScopes =
    now?.scope === context.scope ||
    (now?.scope && context.scope && sameScope(now.scope, context.scope));
  if (
    now?.versions === context.versions &&
    now.folderId === context.folderId &&
    sameScopes &&
    now.figureContexts === context.figureContexts
  )
    return;
  view.dispatch(view.state.tr.setMeta(CONTEXT, context).setMeta("addToHistory", false));
}

/** Keeps the checks, how they show, and the washes behind sentences found unsupported or contradicted. */
export const ClaimChecks = Extension.create({
  name: "claimChecks",

  addProseMirrorPlugins() {
    return [
      new Plugin<ClaimState>({
        key: claimsKey,
        state: {
          init: (_config, state) => stateOf(state.doc, NO_CONTEXT),
          apply: (tr, claims) => {
            const context = tr.getMeta(CONTEXT) as ClaimContext | undefined;
            if (context) return stateOf(tr.doc, context);
            return tr.docChanged
              ? stateOf(tr.doc, { ...claims.context, figureContexts: null })
              : claims;
          },
        },
        props: {
          decorations: (state) => claimsKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
