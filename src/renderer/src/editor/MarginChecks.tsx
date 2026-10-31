import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { setClaimFocus, setOpenClaim } from "../checks";
import { focusFigure, useFigureFocus } from "../figures";
import { useT } from "../i18n";
import { mindFolded } from "../mindColumn";
import { motionMode, subscribeMotion } from "../motion";
import { checkStateKey } from "../unsupportedFixes";
import { ClaimMark } from "./ClaimCheckCard";
import { ClaimOutline } from "./ClaimOutline";
import { useCardPlace } from "./checkPlace";
import { textBlockEdited } from "./citationNumbers";
import { markOf, type ShownClaim, setClaimInline, setClaimRooms, shownClaims } from "./claimChecks";
import { figurePlace } from "./figurePlaces";
import type { ClaimMarkState } from "./icons";
import {
  EDGE_GAP,
  MARK_HEIGHT,
  type MarginRoom,
  type MarkLine,
  PLAIN_MARK_WIDTH,
  placeMarginMarks,
  revealOrder,
} from "./marginMarks";
import { OpinionCard } from "./OpinionCard";
import { scrollMindTo } from "./reviewPick";

/** When an Answer finishes, its checks appear one after another, this far apart. */
const REVEAL_STEP_MS = 40;

/** A folded Mind's mark, this far after its sentence's last word or Citation marker. */
const INLINE_GAP = 4;

/** The first line's box at a position, from the editor's DOM. */
function startOfSentence(editor: Editor, from: number) {
  const coords = editor.view.coordsAtPos(from, 1);
  return { top: coords.top, bottom: coords.bottom, at: coords.left };
}

/** The last character's own box, after which a folded Mind's mark stands (its reserved room follows it). */
function endOfSentence(editor: Editor, to: number) {
  // A Citation or another inline node is a composite: its inner box can end inside its own pill,
  // so the mark measures the node's outer box, less the room the sentence keeps after it.
  const atom = editor.state.doc.nodeAt(to - 1);
  if (atom && !atom.isText) {
    const dom = editor.view.nodeDOM(to - 1);
    if (dom instanceof Element) {
      const style = getComputedStyle(dom);
      const rect = dom.getBoundingClientRect();
      const right = rect.right - (Number.parseFloat(style.paddingRight) || 0);
      return { top: rect.top, bottom: rect.bottom, at: right };
    }
  }
  const start = editor.view.domAtPos(to - 1);
  const end = editor.view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const [rect] = [...range.getClientRects()].slice(-1);
  if (!rect) {
    const coords = editor.view.coordsAtPos(to, -1);
    return { top: coords.top, bottom: coords.bottom, at: coords.left };
  }
  return { top: rect.top, bottom: rect.bottom, at: rect.right };
}

/** A mark as measured, before its row places it. */
interface Measured {
  /** "claim:" and the sentence check's id. */
  key: string;
  state: ClaimMarkState;
  claim: ShownClaim;
  /** The vertical middle of the sentence's first line, from the top of the column. */
  middle: number;
  /** The first line's box, from the top of the column. */
  lineTop: number;
  lineBottom: number;
  /** Where the sentence starts on its line, from the left of the text. */
  startLeft: number;
  /** The mark's left, from the column's text edge, when the Mind's margin has folded; null in the margin. */
  inlineLeft: number | null;
  /** How long its entrance waits, if it is appearing because its check just finished. */
  delay: number | null;
}

interface Mark extends Measured {
  top: number;
  left: number;
  /** Whether the mark stands in the text, after its sentence, because the margin folded. */
  inline: boolean;
}

/** A mark's sentence as the margin places it, with the width the mark last rendered at. */
function lineOf(mark: Measured, widths: ReadonlyMap<string, number>): MarkLine {
  return {
    top: mark.lineTop,
    bottom: mark.lineBottom,
    middle: mark.middle,
    left: mark.startLeft,
    width: widths.get(mark.claim.check.id) ?? PLAIN_MARK_WIDTH,
    silent: mark.state === "not-checked",
  };
}

/** Each mark at its place in the margin, from its sentence's line and its rendered width. */
function placeMargins(
  measured: readonly Measured[],
  room: MarginRoom,
  widths: ReadonlyMap<string, number>,
): Mark[] {
  const spots = placeMarginMarks(
    measured.map((mark) => lineOf(mark, widths)),
    room,
  );
  return measured.map((mark, at) => {
    const spot = spots[at];
    return {
      ...mark,
      top: spot?.top ?? Math.round(mark.middle - MARK_HEIGHT / 2),
      left: spot?.left ?? room.gap,
      inline: false,
    };
  });
}

/**
 * Whether a change to the editor's DOM may move marks: not one in the text
 * block being typed in (`measure` checks that block), to a node removed since
 * (its removal is a change of its own), or an attribute set to the value it
 * had (the editor sets its own at every change).
 */
function mayMoveMarks(record: MutationRecord, typedIn: Node | null): boolean {
  const { target } = record;
  if (!target.isConnected || typedIn?.contains(target)) return false;
  return (
    record.type !== "attributes" ||
    record.oldValue !== (target as Element).getAttribute(record.attributeName ?? "")
  );
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]) =>
  a.length === b.length &&
  a.every((mark, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      mark.key === other.key &&
      mark.state === other.state &&
      mark.top === other.top &&
      mark.left === other.left &&
      mark.inline === other.inline &&
      mark.delay === other.delay &&
      mark.claim.check === other.claim.check &&
      mark.claim.sentence.text === other.claim.sentence.text
    );
  });

/**
 * The column of sentence checks in the right margin, the Mind's signature:
 * one 18px mark for each sentence that has been checked, its verdict, level
 * with the sentence's first line, so the checks can be scanned down the page
 * (see `ClaimMark`). Sentences that start on one line put their marks side by
 * side, and one that would pass the pane's edge goes under the line's first
 * mark (`marginMarks.ts`). A Citation's own check isn't here: it shows on its
 * marker, in the text.
 *
 * It is an overlay beside the editor that measures the sentences: again after
 * every change to the Mind, every change to the editor's DOM (Answers stream
 * in, formulas render), every resize and every font load, at most once a
 * frame. Typing in a text block with no check in it, most of what happens,
 * is the exception: it moves no mark unless the block grows or shrinks, so
 * only the block is measured then. When a check finishes, its mark appears
 * after those above it, 40ms apart, and left to right within a line (not with
 * reduced motion: see styles.css). Under 760px the column keeps to the text's
 * 40px gutter.
 */
export function MarginChecks({
  editor,
  mind,
}: {
  editor: Editor;
  /** The Mind and its document: a card checks again there. */
  mind: { id: string; doc: Y.Doc };
}) {
  const t = useT();
  const place = useCardPlace(mind.id);
  const layer = useRef<HTMLDivElement>(null);
  // The outline draws in the layer, which a figure shown before this note opened waits for.
  const [layerReady, setLayerReady] = useState(false);
  useEffect(() => setLayerReady(true), []);
  const focusedFigure = useFigureFocus((state) => (state.mindId === mind.id ? state.row : null));
  const shownFigure = useFigureFocus((state) =>
    state.mindId === mind.id && state.shown ? state.row : null,
  );
  // A figure shown from its schedule, in a note that may only now have opened.
  useEffect(() => {
    if (!shownFigure) return;
    const place = figurePlace(editor.state.doc, shownFigure);
    if (place) scrollMindTo(editor, place.from, place.to);
    const dom = editor.view.dom;
    const done = () => focusFigure(mind.id, null);
    dom.addEventListener("pointerdown", done);
    dom.addEventListener("keydown", done);
    return () => {
      dom.removeEventListener("pointerdown", done);
      dom.removeEventListener("keydown", done);
    };
  }, [editor, mind.id, shownFigure]);
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  /** Whether the Mind's column has folded its margins, its checks drawn in the text instead. */
  const [folded, setFolded] = useState(() => {
    const column = editor.view.dom.closest(".mind-column");
    return column ? mindFolded(column.getBoundingClientRect().width) : false;
  });
  /** Whether the marks are drawn in the text, followed by the measuring effect (it outlives a render). */
  const foldedNow = useRef(folded);
  useEffect(() => {
    foldedNow.current = folded;
  }, [folded]);
  /** Each mark's state as last drawn: a change from "checking" is its check finishing. */
  const seen = useRef(new Map<string, ClaimMarkState>());
  /** The entrance delays of the marks that appeared that way, by key and state. */
  const reveals = useRef(new Map<string, number>());
  /** The sentences last measured in the margin, kept to place them again as their marks render wider. */
  const margin = useRef<{ marks: readonly Measured[]; room: MarginRoom } | null>(null);
  /** Each mark's own rendered width, by its check's id. */
  const widths = useRef(new Map<string, number>());

  useEffect(() => {
    const column = editor.view.dom.closest(".mind-column");
    if (!column) return;
    const measure = () => {
      const next = mindFolded(column.getBoundingClientRect().width);
      // Before the transaction below, which measures the marks: they must be placed for this fold.
      foldedNow.current = next;
      setFolded(next);
      if (!editor.isDestroyed) setClaimInline(editor.view, next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [editor]);

  /** Places the marks again once one has rendered at a width the last measure didn't know. */
  const relayout = useCallback(() => {
    const last = margin.current;
    if (!last) return;
    const next = placeMargins(last.marks, last.room, widths.current);
    setMarks((drawn) => {
      // An entrance's delay belongs to the render that played it, and to `onRevealed` when it ends.
      const delays = new Map(drawn.map((mark) => [mark.key, mark.delay]));
      const placed = next.map((mark) => ({ ...mark, delay: delays.get(mark.key) ?? null }));
      return sameMarks(drawn, placed) ? drawn : placed;
    });
  }, []);

  // Each mark's own rendered width: the room it keeps after its sentence when the margin folds, and
  // where the next mark on the line stands when it doesn't. One walk of the layer for all of them,
  // so a Note with many marks costs one query rather than one per mark.
  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const shown = new Set(
      marks.filter((mark) => mark.state !== "not-checked").map((mark) => mark.claim.check.id),
    );
    const drawn = new Map<string, number>();
    for (const mark of element.querySelectorAll<HTMLElement>("[data-claim]")) {
      const id = mark.dataset.claim;
      if (!id || !shown.has(id)) continue;
      const width = Math.ceil(mark.getBoundingClientRect().width);
      if (width > 0) drawn.set(id, width);
    }
    let changed = false;
    for (const [id, width] of drawn) {
      if (widths.current.get(id) === width) continue;
      widths.current.set(id, width);
      changed = true;
    }
    if (folded) {
      if (!editor.isDestroyed) setClaimRooms(editor.view, drawn);
      return;
    }
    if (changed) relayout();
  }, [folded, marks, editor, relayout]);

  useEffect(() => {
    let frame = 0;
    /** Whether the next frame measures every mark, rather than those `typedIn` may have moved. */
    let all = true;
    /** The text block typed in since the last frame, when nothing else changed (`textBlockEdited`). */
    let typedIn: HTMLElement | null = null;
    /** The text block typed in when the marks were last measured, and its height then. */
    let typed: { block: HTMLElement; height: number } | null = null;
    const measure = () => {
      frame = 0;
      const column = layer.current;
      if (!column || editor.isDestroyed) return;
      const block = typedIn;
      typedIn = null;
      const height = block?.getBoundingClientRect().height ?? 0;
      // Typing that keeps its block's height moves only the marks in that block, if any.
      const only =
        !all && block && typed?.block === block && typed.height === height ? block : null;
      if (only && !only.querySelector("[data-claim-check]")) return;
      all = false;
      typed = block ? { block, height } : null;
      const rect = column.getBoundingClientRect();
      const folded = foldedNow.current;
      const measured: Measured[] = [];
      const revealing = new Set<string>();
      for (const claim of shownClaims(editor.state)) {
        const state = markOf(claim);
        let coords: { top: number; bottom: number; at: number };
        try {
          coords = folded
            ? endOfSentence(editor, claim.sentence.to)
            : startOfSentence(editor, claim.sentence.from);
        } catch {
          continue;
        }
        const mark: Measured = {
          key: `claim:${claim.check.id}`,
          state,
          claim,
          middle: (coords.top + coords.bottom) / 2 - rect.top,
          lineTop: coords.top - rect.top,
          lineBottom: coords.bottom - rect.top,
          startLeft: folded ? 0 : coords.at,
          inlineLeft: folded ? Math.round(coords.at - rect.left + INLINE_GAP) : null,
          delay: null,
        };
        if (seen.current.get(mark.key) === "checking" && state !== "checking")
          revealing.add(mark.key);
        seen.current.set(mark.key, state);
        measured.push(mark);
      }
      // In the margin, marks keep the line their sentence starts on: side by side when it starts
      // on one line, and under the line's first when one would pass the pane's edge. A sentence
      // not checked yet keeps its line and takes no room (#1941). In the text, each mark stands at
      // its own sentence's end, so none can overlap another.
      let next: Mark[];
      if (folded) {
        next = measured.map((mark) => ({
          ...mark,
          top: Math.round(mark.middle - MARK_HEIGHT / 2),
          left: mark.inlineLeft ?? 0,
          inline: true,
        }));
        margin.current = null;
      } else {
        const pane = column.closest(".mind-column")?.getBoundingClientRect();
        // The first mark's gap comes from the frame's `--check-gap`, so the CSS and the row agree.
        const room: MarginRoom = {
          gap: Number.parseFloat(getComputedStyle(column).getPropertyValue("--check-gap")) || 8,
          edge: (pane?.right ?? rect.right) - rect.left - EDGE_GAP,
        };
        next = placeMargins(measured, room, widths.current);
        margin.current = { marks: measured, room };
      }
      // Only with motion on: otherwise the marks are there at once, with no cascade to end.
      if (motionMode() === "on") {
        revealOrder(next.filter((mark) => revealing.has(mark.key))).forEach((mark, index) => {
          reveals.current.set(`${mark.key}:${mark.state}`, index * REVEAL_STEP_MS);
        });
      }
      for (const mark of next)
        mark.delay = reveals.current.get(`${mark.key}:${mark.state}`) ?? null;
      setMarks((drawn) => (sameMarks(drawn, next) ? drawn : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const request = () => {
      all = true;
      schedule();
    };
    request();

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const at = textBlockEdited(transaction);
      const block = at === null ? null : editor.view.nodeDOM(at);
      if (!(block instanceof HTMLElement) || (typedIn && typedIn !== block)) {
        request();
        return;
      }
      typedIn = block;
      schedule();
    };
    editor.on("transaction", onTransaction);
    const resizes = new ResizeObserver(request);
    resizes.observe(editor.view.dom);
    // A Note's pane can change width with no edit at all: a group opens beside it, the assistant
    // shows, the splitter moves. The measure stays 680px, so nothing above moves; the room the
    // marks stand in does, and their places have to follow.
    const pane = editor.view.dom.closest(".mind-column");
    let paneWidth = pane?.getBoundingClientRect().width ?? 0;
    const paneResizes = new ResizeObserver(() => {
      const width = pane?.getBoundingClientRect().width ?? 0;
      if (Math.abs(width - paneWidth) < 0.5) return;
      paneWidth = width;
      request();
    });
    if (pane) paneResizes.observe(pane);
    // React draws node views after the transaction; Answers stream in; KaTeX renders.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => mayMoveMarks(record, typedIn))) request();
    });
    mutations.observe(editor.view.dom, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style"],
    });
    document.fonts.addEventListener("loadingdone", request);
    void document.fonts.ready.then(request);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
      resizes.disconnect();
      paneResizes.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", request);
    };
  }, [editor]);

  useEffect(
    () => () => {
      setOpenClaim(place, null);
      setClaimFocus(place, null);
    },
    [place],
  );

  // Motion turned to Reduced or Off stops the cascade (styles.css), so it never ends on its own:
  // its marks are simply there, and can't play it later if motion comes back on.
  useEffect(
    () =>
      subscribeMotion(() => {
        if (motionMode() === "on") return;
        reveals.current.clear();
        setMarks((drawn) =>
          drawn.some((mark) => mark.delay !== null)
            ? drawn.map((mark) => (mark.delay === null ? mark : { ...mark, delay: null }))
            : drawn,
        );
      }),
    [],
  );

  const markElement = (mark: Mark) => (
    <ClaimMark
      key={mark.key}
      claim={mark.claim}
      editor={editor}
      mindId={mind.id}
      doc={mind.doc}
      label={t("claim.mark.label", { state: t(checkStateKey(editor, mark.claim)) })}
      reveal={mark.delay !== null}
      style={
        {
          top: mark.top,
          left: mark.left,
          "--reveal-delay": `${mark.delay ?? 0}ms`,
        } as CSSProperties
      }
      inline={mark.inline}
      onRevealed={() => {
        reveals.current.delete(`${mark.key}:${mark.state}`);
        setMarks((drawn) => drawn.map((each) => (each === mark ? { ...each, delay: null } : each)));
      }}
    />
  );

  return (
    <div ref={layer} className="margin-checks" data-testid="margin-checks">
      <OpinionCard editor={editor} mindId={mind.id} doc={mind.doc} />
      {focusedFigure && layerReady && layer.current && (
        <ClaimOutline
          editor={editor}
          layer={layer.current}
          rangeOf={() => figurePlace(editor.state.doc, focusedFigure)}
        />
      )}
      {marks.map((mark) => markElement(mark))}
    </div>
  );
}
